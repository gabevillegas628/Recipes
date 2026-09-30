import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { prisma } from './db.js';
import { env } from './env.js';

/**
 * The app's one Google connection: someone connects a Google account on the
 * Settings page and picks the family calendar, and the app writes events there
 * (see calendarSync.ts). Plain REST calls; the refresh token is stored encrypted.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const ID = 'default';

export const googleConfigured = Boolean(env.googleClientId && env.googleClientSecret);

/** Google said no for good (revoked, expired, removed). Needs reconnecting. */
export class GoogleAuthError extends Error {}
/** Google rejected a request. `status` is the HTTP status. */
export class GoogleApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- Refresh token at rest ----------

const key = createHash('sha256').update(`${env.sessionSecret}:google-refresh-token`).digest();

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ---------- OAuth ----------

export function authUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // A refresh token, every time (Google only sends one on consent).
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.googleClientId!,
      client_secret: env.googleClientSecret!,
      ...params,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok) {
    const message = body.error_description ?? body.error ?? `Google sign-in failed (${res.status})`;
    if (body.error === 'invalid_grant') throw new GoogleAuthError(message);
    throw new GoogleApiError(res.status, message);
  }
  return body;
}

let cached: { token: string; expiresAt: number } | null = null;

/** Finishes connecting: trades the sign-in code for tokens and stores the connection. */
export async function connect(code: string, redirectUri: string, appUrl: string, userId: string | null) {
  const tokens = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!tokens.refresh_token || !tokens.access_token) {
    throw new GoogleApiError(400, "Google didn't grant offline access. Try connecting again.");
  }
  const granted = tokens.scope?.split(' ') ?? [];
  if (!SCOPES.every((s) => granted.includes(s))) {
    throw new GoogleApiError(400, 'Allow both calendar permissions on the Google screen, then try again.');
  }
  cached = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 };

  // Nothing is stored yet, so use this sign-in's token directly.
  const email = (await listCalendars(tokens.access_token)).find((c) => c.primary)?.id ?? null;
  const previous = await prisma.googleConnection.findUnique({ where: { id: ID } });
  const sameAccount = previous?.email != null && previous.email === email;
  const data = {
    email,
    refreshToken: encrypt(tokens.refresh_token),
    appUrl,
    error: null,
    connectedById: userId,
    // Reconnecting the same account keeps the chosen calendar.
    ...(sameAccount ? {} : { calendarId: null, calendarName: null }),
  };
  await prisma.googleConnection.upsert({ where: { id: ID }, create: { id: ID, ...data }, update: data });
}

export async function getConnection() {
  return prisma.googleConnection.findUnique({
    where: { id: ID },
    include: { connectedBy: { select: { name: true } } },
  });
}

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const connection = await prisma.googleConnection.findUnique({ where: { id: ID } });
  if (!connection) throw new GoogleAuthError('Google Calendar isn’t connected.');
  if (connection.error) throw new GoogleAuthError(connection.error);
  try {
    const tokens = await tokenRequest({ refresh_token: decrypt(connection.refreshToken), grant_type: 'refresh_token' });
    cached = { token: tokens.access_token!, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 };
    return cached.token;
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      await prisma.googleConnection.update({
        where: { id: ID },
        data: { error: 'Google stopped accepting the connection. Reconnect it.' },
      });
    }
    throw err;
  }
}

export async function disconnect() {
  const connection = await prisma.googleConnection.findUnique({ where: { id: ID } });
  if (!connection) return;
  cached = null;
  await prisma.googleConnection.delete({ where: { id: ID } });
  // Best effort: also withdraw the app's access on Google's side.
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: decrypt(connection.refreshToken) }),
    });
  } catch {
    // Already gone, or Google is unreachable; the token is deleted here either way.
  }
}

// ---------- Calendar API ----------

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token ?? (await accessToken())}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    if (res.status === 401) cached = null;
    throw new GoogleApiError(res.status, data.error?.message ?? `Google Calendar error (${res.status})`);
  }
  return data;
}

export interface CalendarChoice {
  id: string;
  name: string;
  primary: boolean;
  timeZone: string | null;
}

/** Calendars the connected account can add events to. */
export async function listCalendars(token?: string): Promise<CalendarChoice[]> {
  const data = await api<{
    items?: {
      id: string;
      summary: string;
      summaryOverride?: string;
      primary?: boolean;
      accessRole: string;
      timeZone?: string;
    }[];
  }>('GET', '/users/me/calendarList?minAccessRole=writer&maxResults=250', undefined, token);
  return (data?.items ?? []).map((c) => ({
    id: c.id,
    name: c.summaryOverride ?? c.summary,
    primary: Boolean(c.primary),
    timeZone: c.timeZone ?? null,
  }));
}

export async function setCalendar(calendar: CalendarChoice) {
  await prisma.googleConnection.update({
    where: { id: ID },
    data: { calendarId: calendar.id, calendarName: calendar.name, timeZone: calendar.timeZone },
  });
}

/** Google Calendar's event colors, by colorId. */
export const GOOGLE_COLORS: Record<string, string> = {
  '1': 'Lavender',
  '2': 'Sage',
  '3': 'Grape',
  '4': 'Flamingo',
  '5': 'Banana',
  '6': 'Tangerine',
  '7': 'Peacock',
  '8': 'Graphite',
  '9': 'Blueberry',
  '10': 'Basil',
  '11': 'Tomato',
};

/** Where reminders go (null: with appointments) and their color (null: the calendar's own). */
export async function setReminders(calendar: CalendarChoice | null, color: string | null) {
  await prisma.googleConnection.update({
    where: { id: ID },
    data: { remindersCalendarId: calendar?.id ?? null, remindersCalendarName: calendar?.name ?? null, remindersColor: color },
  });
}

/** The chosen calendar's time zone, looked up once for connections made before it was stored. */
export async function calendarTimeZone(calendarId: string, stored: string | null): Promise<string | null> {
  if (stored) return stored;
  const calendar = (await listCalendars()).find((c) => c.id === calendarId);
  if (!calendar?.timeZone) return null;
  await prisma.googleConnection.update({ where: { id: ID }, data: { timeZone: calendar.timeZone } });
  return calendar.timeZone;
}

export type EventBody = Record<string, unknown>;

const eventsPath = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}/events`;

export async function insertEvent(calendarId: string, event: EventBody): Promise<string> {
  const created = await api<{ id: string }>('POST', eventsPath(calendarId), event);
  return created!.id;
}

export async function updateEvent(calendarId: string, eventId: string, event: EventBody) {
  await api('PUT', `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`, event);
}

export interface CalendarEvent {
  title: string;
  /** Timed events; all-day ones have `allDayDate` ("YYYY-MM-DD") instead, and `allDayEnd` (exclusive). */
  start: Date | null;
  end: Date | null;
  allDayDate: string | null;
  allDayEnd: string | null;
  location: string | null;
  /** Marked "free" in Google Calendar (like the app's own reminders). */
  free: boolean;
  /** Set on events this app wrote (see calendarSync.ts). */
  noteId: string | null;
}

/**
 * Events between two instants, with repeating ones expanded into single occurrences.
 * `q` limits it to events with that text in the title, description, location or attendees.
 */
export async function listEvents(calendarId: string, from: Date, to: Date, q?: string): Promise<CalendarEvent[]> {
  type Item = {
    status?: string;
    summary?: string;
    transparency?: string;
    location?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    extendedProperties?: { private?: { noteId?: string } };
  };
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      ...(q ? { q } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await api<{ items?: Item[]; nextPageToken?: string }>('GET', `${eventsPath(calendarId)}?${params}`);
    for (const e of data?.items ?? []) {
      if (e.status === 'cancelled' || !e.start) continue;
      events.push({
        title: e.summary?.trim() || '(no title)',
        start: e.start.dateTime ? new Date(e.start.dateTime) : null,
        end: e.end?.dateTime ? new Date(e.end.dateTime) : null,
        allDayDate: e.start.date ?? null,
        allDayEnd: e.end?.date ?? null,
        location: e.location?.trim() || null,
        free: e.transparency === 'transparent',
        noteId: e.extendedProperties?.private?.noteId ?? null,
      });
    }
    pageToken = data?.nextPageToken;
  } while (pageToken);
  return events;
}

/** Deleting an event that's already gone counts as done. */
export async function deleteEvent(calendarId: string, eventId: string) {
  try {
    await api('DELETE', `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`);
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}
