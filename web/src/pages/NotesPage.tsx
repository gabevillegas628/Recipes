import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import { dayLabel, dayOf, isOverdue, localDate, timeLabel } from '../notes';
import type { Note } from '../types';

/**
 * Everything saved from the Add tab: appointments coming up (by day), open
 * reminders, then notes. Past appointments and ticked-off reminders fold away.
 */
export function NotesPage() {
  const queryClient = useQueryClient();
  const [showPast, setShowPast] = useState(false);
  const [showDone, setShowDone] = useState(false);

  // Poll gently so a note added on the other phone shows up.
  const list = useQuery({ queryKey: ['notes'], queryFn: api.notes, refetchInterval: 30_000 });
  const notes = list.data ?? [];

  const toggle = useMutation({
    mutationFn: (n: Note) => api.updateNote(n.id, { done: !n.doneAt }),
    onMutate: (n) =>
      queryClient.setQueryData<Note[]>(['notes'], (prev) =>
        prev?.map((x) => (x.id === n.id ? { ...x, doneAt: n.doneAt ? null : new Date().toISOString() } : x)),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });

  const today = localDate(new Date());
  const endDay = (n: Note) => dayOf(n.endsAt ?? n.startsAt!, n.allDay);
  const byStart = (a: Note, b: Note) => (a.startsAt ?? '').localeCompare(b.startsAt ?? '');

  const appointments = notes.filter((n) => n.kind === 'APPOINTMENT' && n.startsAt);
  const upcoming = appointments.filter((n) => endDay(n) >= today).sort(byStart);
  const past = appointments.filter((n) => endDay(n) < today).sort((a, b) => byStart(b, a));

  const reminders = notes.filter((n) => n.kind === 'REMINDER');
  // Dated reminders first, soonest first; then undated, newest first.
  const open = reminders
    .filter((n) => !n.doneAt)
    .sort((a, b) =>
      a.startsAt && b.startsAt ? byStart(a, b) : a.startsAt ? -1 : b.startsAt ? 1 : b.createdAt.localeCompare(a.createdAt),
    );
  const done = reminders.filter((n) => n.doneAt).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!));

  const plain = notes.filter((n) => n.kind === 'NOTE');

  // Upcoming appointments grouped under a heading per day (multi-day ones under their first day).
  const days = new Map<string, Note[]>();
  for (const n of upcoming) {
    const day = dayOf(n.startsAt!, n.allDay) < today ? today : dayOf(n.startsAt!, n.allDay);
    days.set(day, [...(days.get(day) ?? []), n]);
  }

  return (
    <div className="page">
      <header className="notes-header">
        <h1>Notes</h1>
        <Link to="/add" className="btn btn-small">
          + Add
        </Link>
      </header>

      {list.data && notes.length === 0 && (
        <div className="empty">
          <p>Nothing saved yet.</p>
          <p className="muted">
            Use <Link to="/add">Add</Link> to save an appointment, a reminder or a note. Type it, say
            it, or snap a photo of a flyer.
          </p>
        </div>
      )}

      {upcoming.length > 0 && (
        <section className="notes-section">
          <h2 className="notes-section-title">Coming up</h2>
          {[...days].map(([day, items]) => (
            <div key={day} className="aisle">
              <h2>{dayLabel(day)}</h2>
              <ul className="note-list">
                {items.map((n) => (
                  <NoteRow key={n.id} note={n} meta={[timeLabel(n, false), n.location].filter(Boolean).join(' · ')} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {(open.length > 0 || done.length > 0) && (
        <section className="notes-section">
          <h2 className="notes-section-title">Reminders</h2>
          <ul className="note-list">
            {open.map((n) => (
              <NoteRow
                key={n.id}
                note={n}
                meta={n.startsAt ? `Due ${timeLabel(n)}` : ''}
                overdue={isOverdue(n)}
                onToggle={() => toggle.mutate(n)}
              />
            ))}
          </ul>
          {done.length > 0 && (
            <>
              <button type="button" className="link-btn notes-fold" onClick={() => setShowDone((v) => !v)}>
                {showDone ? '▾' : '▸'} Done ({done.length})
              </button>
              {showDone && (
                <ul className="note-list">
                  {done.map((n) => (
                    <NoteRow key={n.id} note={n} meta="" onToggle={() => toggle.mutate(n)} />
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {plain.length > 0 && (
        <section className="notes-section">
          <h2 className="notes-section-title">Notes</h2>
          <ul className="note-list">
            {plain.map((n) => (
              <NoteRow key={n.id} note={n} meta={n.body?.split('\n').find((l) => l.trim()) ?? ''} />
            ))}
          </ul>
        </section>
      )}

      {past.length > 0 && (
        <section className="notes-section">
          <button type="button" className="link-btn notes-fold" onClick={() => setShowPast((v) => !v)}>
            {showPast ? '▾' : '▸'} Past appointments ({past.length})
          </button>
          {showPast && (
            <ul className="note-list">
              {past.map((n) => (
                <NoteRow key={n.id} note={n} meta={timeLabel(n)} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function NoteRow({
  note,
  meta,
  overdue = false,
  onToggle,
}: {
  note: Note;
  meta: string;
  overdue?: boolean;
  onToggle?: () => void;
}) {
  const thumb = thumbUrl(note.image);
  return (
    <li className={`note-row ${note.doneAt ? 'done' : ''}`}>
      {onToggle && (
        <button
          type="button"
          className={`check-circle ${note.doneAt ? 'on' : ''}`}
          onClick={onToggle}
          aria-label={note.doneAt ? 'Mark not done' : 'Mark done'}
        >
          {note.doneAt ? '✓' : ''}
        </button>
      )}
      <Link to={`/n/${note.id}`} className="note-link">
        <span className="note-text">
          <span className="note-title">{note.title}</span>
          {meta && <span className={`note-meta ${overdue ? 'overdue' : ''}`}>{meta}</span>}
        </span>
        {thumb && <img className="note-thumb" src={thumb} alt="" />}
      </Link>
    </li>
  );
}
