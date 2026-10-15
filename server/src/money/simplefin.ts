/**
 * SimpleFIN Bridge (https://www.simplefin.org/protocol.html). A setup token,
 * pasted once in Settings → Money, is base64 for a claim URL; claiming it returns
 * the access URL, which has credentials in it and works until revoked in
 * SimpleFIN. Everything after that is GET <access URL>/accounts.
 */

/** SimpleFIN no longer accepts the access URL (revoked, or the token was bad). Needs a new setup token. */
export class SimpleFinAuthError extends Error {}

/** Bridge serves at most this many days per request; longer ranges are cut short. */
export const MAX_DAYS = 90;

export interface SfTransaction {
  id: string;
  posted: number;
  amount: string;
  description: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
  transacted_at?: number;
}

export interface SfAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  'available-balance'?: string;
  'balance-date': number;
  org?: { name?: string; domain?: string };
  conn_id?: string;
  transactions?: SfTransaction[];
  holdings?: unknown[];
}

export interface SfResponse {
  accounts: SfAccount[];
  /** Messages to show the user, such as a bank needing its sign-in redone. */
  problems: string[];
  /** Institution names by connection id (protocol v2). */
  connections: Map<string, string>;
}

/** Trades a setup token for an access URL. */
export async function claim(setupToken: string): Promise<string> {
  let claimUrl: URL;
  try {
    claimUrl = new URL(Buffer.from(setupToken.trim(), 'base64').toString('utf8'));
  } catch {
    throw new SimpleFinAuthError("That doesn't look like a SimpleFIN setup token. Copy the whole thing.");
  }
  // The token decodes to any URL at all; only send the request to SimpleFIN.
  if (claimUrl.protocol !== 'https:' || !/(^|\.)simplefin\.org$/.test(claimUrl.hostname)) {
    throw new SimpleFinAuthError("That doesn't look like a SimpleFIN setup token. Copy the whole thing.");
  }
  const res = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  if (res.status === 403) {
    throw new SimpleFinAuthError('SimpleFIN says that token was already used. Make a new one and paste that.');
  }
  if (!res.ok) throw new Error(`SimpleFIN couldn't claim the token (${res.status}).`);
  const access = (await res.text()).trim();
  new URL(access);
  return access;
}

/** Accounts with transactions from `start` to `end` (at most MAX_DAYS apart), pending ones included. */
export async function fetchAccounts(accessUrl: string, start: Date, end?: Date): Promise<SfResponse> {
  const access = new URL(accessUrl);
  // fetch() refuses URLs with credentials in them, so they go in a header instead.
  const auth = Buffer.from(`${decodeURIComponent(access.username)}:${decodeURIComponent(access.password)}`).toString(
    'base64',
  );
  access.username = '';
  access.password = '';
  const url = new URL(`${access.href.replace(/\/$/, '')}/accounts`);
  url.searchParams.set('start-date', String(Math.floor(start.getTime() / 1000)));
  if (end) url.searchParams.set('end-date', String(Math.floor(end.getTime() / 1000)));
  url.searchParams.set('pending', '1');

  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (res.status === 401 || res.status === 403) {
    throw new SimpleFinAuthError('SimpleFIN stopped accepting Mise’s access. Make a new setup token and paste it here.');
  }
  if (!res.ok) throw new Error(`SimpleFIN returned ${res.status}.`);
  const body = (await res.json()) as {
    accounts?: SfAccount[];
    errors?: string[];
    errlist?: { code?: string; msg?: string }[];
    connections?: { conn_id: string; name?: string; org_id?: string }[];
  };
  const problems = [...(body.errors ?? []), ...(body.errlist ?? []).map((e) => e.msg ?? e.code ?? '')]
    .map((p) => p.trim())
    .filter(Boolean)
    // Expected whenever a range is asked for; not something to show anyone.
    .filter((p) => !/date range exceeds/i.test(p));
  return {
    accounts: body.accounts ?? [],
    problems,
    connections: new Map((body.connections ?? []).map((c) => [c.conn_id, c.name ?? c.org_id ?? ''])),
  };
}
