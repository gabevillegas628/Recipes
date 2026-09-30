import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dayOf, localDate, repeatLabel } from '../notes';
import type { Note, SearchResult } from '../types';

type Hit =
  | { type: 'note'; note: Note; at: string }
  | { type: 'event'; event: SearchResult['calendar'][number]; at: string };

const KIND: Record<Note['kind'], string> = { NOTE: 'Note', REMINDER: 'Reminder', APPOINTMENT: 'Appointment' };

/**
 * Search results in Notes: Mise's notes, reminders and appointments (past ones
 * too) and matching events from the family calendar, newest first by month.
 */
export function NotesSearch({ query }: { query: string }) {
  const result = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search(query),
    placeholderData: keepPreviousData,
  });
  const data = result.data;

  const hits: Hit[] = [
    ...(data?.notes ?? []).map((note): Hit => ({ type: 'note', note, at: note.startsAt ?? note.updatedAt })),
    ...(data?.calendar ?? []).map((event): Hit => ({
      type: 'event',
      event,
      // All-day dates sort as noon, like Mise's own.
      at: event.start ?? `${event.allDayDate}T12:00:00.000Z`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const months = new Map<string, Hit[]>();
  for (const hit of hits) {
    const key = monthOf(hit);
    months.set(key, [...(months.get(key) ?? []), hit]);
  }

  return (
    <section className="notes-results">
      {result.isPending && <p className="muted">Searching…</p>}
      {result.error && <p className="error">{result.error.message}</p>}
      {data?.calendarError && <p className="muted small">Couldn’t search the calendar: {data.calendarError}</p>}
      {data && !data.calendarConnected && (
        <p className="muted small">
          Only searching Mise. <Link to="/settings/calendar">Connect Google Calendar</Link> to search its history too.
        </p>
      )}
      {data && hits.length === 0 && <p className="muted">Nothing matches “{query}”.</p>}
      {[...months].map(([month, list]) => (
        <div key={month} className="aisle">
          <h2>{month}</h2>
          <ul className="note-list">
            {list.map((hit, i) => (hit.type === 'note' ? <NoteHit key={hit.note.id} note={hit.note} /> : <EventHit key={i} event={hit.event} />))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** "October 2026". */
function monthOf(hit: Hit) {
  const day =
    hit.type === 'note'
      ? hit.note.startsAt
        ? dayOf(hit.note.startsAt, hit.note.allDay)
        : localDate(new Date(hit.note.updatedAt))
      : hit.event.allDayDate ?? localDate(new Date(hit.event.start!));
  const [y, m] = day.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** "Tue, Oct 6, 2026 · 3:30 PM". */
function when(day: string, time: string | null) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return time ? `${date} · ${new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : date;
}

function NoteHit({ note }: { note: Note }) {
  const date = note.startsAt ? when(dayOf(note.startsAt, note.allDay), note.allDay ? null : note.startsAt) : null;
  const repeats = repeatLabel(note);
  const meta = [KIND[note.kind], date, note.location, note.kind === 'NOTE' ? note.body?.split('\n').find((l) => l.trim()) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="note-row">
      <Link to={`/n/${note.id}`} className="note-link">
        <span className="note-text">
          <span className="note-title">{note.title}</span>
          <span className="note-meta">{meta}</span>
          {repeats && <span className="note-meta">↻ {repeats}</span>}
        </span>
      </Link>
    </li>
  );
}

function EventHit({ event }: { event: SearchResult['calendar'][number] }) {
  const date = event.allDayDate ? when(event.allDayDate, null) : when(localDate(new Date(event.start!)), event.start);
  const body = (
    <span className="note-text">
      <span className="note-title">{event.title}</span>
      <span className="note-meta">{['Calendar', date, event.location].filter(Boolean).join(' · ')}</span>
    </span>
  );
  return (
    <li className="note-row">
      {event.noteId ? (
        <Link to={`/n/${event.noteId}`} className="note-link">
          {body}
        </Link>
      ) : (
        <div className="note-link">{body}</div>
      )}
    </li>
  );
}
