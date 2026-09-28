import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { GoogleStatus } from '../types';

const RESULT_MESSAGES: Record<string, string> = {
  connected: 'Connected. Now pick the calendar to add events to.',
  cancelled: 'Google sign-in was cancelled.',
  expired: 'That sign-in took too long or started somewhere else. Try again.',
  unconfigured: "Google Calendar isn't set up on the server yet.",
};

/** Settings → Google Calendar: connect an account, pick the family calendar, see sync status. */
export function GoogleCalendarSection() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [result] = useState(() => {
    const code = params.get('google');
    if (!code) return null;
    return code === 'failed' ? `Couldn't connect: ${params.get('reason') ?? 'unknown error'}` : (RESULT_MESSAGES[code] ?? null);
  });
  // Clear ?google=… once shown, so a reload doesn't repeat it.
  useEffect(() => {
    if (params.has('google')) setParams({}, { replace: true });
  }, [params, setParams]);

  const status = useQuery({
    queryKey: ['google'],
    queryFn: api.googleStatus,
    // While events are being added, keep the count fresh.
    refetchInterval: (q) => ((q.state.data?.pending ?? 0) > 0 ? 3000 : false),
  });
  const s = status.data;
  const [choosing, setChoosing] = useState(false);
  const needsCalendar = Boolean(s?.connected && !s.error && !s.calendarId);
  const calendars = useQuery({
    queryKey: ['google-calendars'],
    queryFn: api.googleCalendars,
    enabled: needsCalendar || choosing,
  });
  const [picked, setPicked] = useState('');

  const onStatus = (next: GoogleStatus) => queryClient.setQueryData(['google'], next);
  const save = useMutation({
    mutationFn: (id: string) => api.setGoogleCalendar(id),
    onSuccess: (next) => {
      onStatus(next);
      setChoosing(false);
    },
  });
  const disconnect = useMutation({ mutationFn: api.disconnectGoogle, onSuccess: onStatus });

  if (!s) return null;

  const connectLink = (label: string, primary = true) => (
    <a className={`btn ${primary ? 'btn-primary' : ''}`} href="/api/google/connect">
      {label}
    </a>
  );

  return (
    <section className="settings-section">
      <h2>Google Calendar</h2>
      {result && <div className="banner">{result}</div>}

      {!s.configured ? (
        <p className="muted">
          Not set up on the server yet. It needs a Google Cloud OAuth client (GOOGLE_CLIENT_ID and
          GOOGLE_CLIENT_SECRET).
        </p>
      ) : !s.connected ? (
        <>
          <p>
            Put appointments and reminders on your family calendar automatically. Connect a Google
            account that can edit that calendar.
          </p>
          <p className="muted small">
            On iPhone, do this once in Safari or on a computer rather than the home-screen app, so the
            Google sign-in can come back here.
          </p>
          <div className="settings-actions">{connectLink('Connect Google Calendar')}</div>
        </>
      ) : s.error ? (
        <>
          <div className="banner">{s.error}</div>
          <div className="settings-actions">
            {connectLink('Reconnect')}
            <button type="button" className="btn btn-danger" onClick={() => disconnect.mutate()}>
              Disconnect
            </button>
          </div>
        </>
      ) : needsCalendar || choosing ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (picked) save.mutate(picked);
          }}
        >
          <label className="field">
            <span>Add events to</span>
            {calendars.isPending ? (
              <small>Loading calendars…</small>
            ) : calendars.error ? (
              <p className="error">{calendars.error.message}</p>
            ) : (
              <select value={picked} onChange={(e) => setPicked(e.target.value)} required>
                <option value="" disabled>
                  Choose a calendar
                </option>
                {calendars.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.primary ? ' (personal)' : ''}
                  </option>
                ))}
              </select>
            )}
            <small>Upcoming appointments and open reminders are added right away.</small>
          </label>
          {save.error && <p className="error">{save.error.message}</p>}
          <div className="settings-actions">
            <button className="btn btn-primary" disabled={!picked || save.isPending}>
              {save.isPending ? 'Saving…' : 'Use this calendar'}
            </button>
            {choosing && (
              <button type="button" className="btn" onClick={() => setChoosing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <>
          <p className="connector-status">
            <span className="dot dot-on" /> Adding to <strong>{s.calendarName}</strong>
          </p>
          <p className="muted small">
            As {s.email}
            {s.connectedBy ? `, connected by ${s.connectedBy}` : ''}.{' '}
            {s.pending > 0 && `Adding ${s.pending} now… `}
            {s.failed > 0 && `${s.failed} couldn't be added; open them in Notes to see why. `}
            Alerts follow each person's default notifications for that calendar in Google Calendar.
            Changes made in Google Calendar don't come back here.
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPicked(s.calendarId ?? '');
                setChoosing(true);
              }}
            >
              Change calendar
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() =>
                confirm('Stop adding events to Google Calendar? Events already there stay.') && disconnect.mutate()
              }
            >
              Disconnect
            </button>
          </div>
        </>
      )}
      {disconnect.error && <p className="error">{disconnect.error.message}</p>}
    </section>
  );
}
