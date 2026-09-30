import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import { NotesSearch } from '../components/NotesSearch';
import { comingUpOn, dayLabel, dayOf, isOverdue, reminderDue, repeatLabel, timeLabel } from '../notes';
import type { Note } from '../types';

/**
 * Everything saved from the Add tab: appointments coming up (by day), open
 * reminders, then notes. Ticked-off reminders fold away; past appointments only
 * show up in search, which also looks through the family calendar's history.
 */
export function NotesPage() {
  const queryClient = useQueryClient();
  const [showDone, setShowDone] = useState(false);
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim(), 300);

  // Poll gently so a note added on the other phone shows up.
  const list = useQuery({ queryKey: ['notes'], queryFn: api.notes, refetchInterval: 30_000 });
  const notes = list.data ?? [];

  // A repeating reminder is ticked off one occurrence at a time: always "done", and the next one shows.
  const toggle = useMutation({
    mutationFn: (n: Note) => api.updateNote(n.id, { done: Boolean(n.recurrence) || !n.doneAt }),
    onMutate: (n) =>
      queryClient.setQueryData<Note[]>(['notes'], (prev) =>
        prev?.map((x) =>
          x.id === n.id ? { ...x, doneAt: n.doneAt && !n.recurrence ? null : new Date().toISOString() } : x,
        ),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });

  // "15:30", local; sorts as text.
  const time = (n: Note) => (n.allDay || !n.startsAt ? '' : new Date(n.startsAt).toTimeString().slice(0, 5));
  // Soonest first; on the same day, all-day items first, then by time.
  const bySoonest = (a: Dated, b: Dated) => a.day.localeCompare(b.day) || time(a.note).localeCompare(time(b.note));

  type Dated = { note: Note; day: string };
  const upcoming: Dated[] = [];
  for (const n of notes) {
    if (n.kind !== 'APPOINTMENT' || !n.startsAt) continue;
    // Over as soon as it ends (all-day ones at midnight); then it's only found by searching.
    const day = comingUpOn(n);
    if (day) upcoming.push({ note: n, day });
  }
  upcoming.sort(bySoonest);

  const open: Dated[] = [];
  const undated: Note[] = [];
  const done: Note[] = [];
  for (const n of notes) {
    if (n.kind !== 'REMINDER') continue;
    if (n.recurrence && n.startsAt) {
      const due = reminderDue(n);
      if (due) open.push({ note: n, day: due });
      else done.push(n);
    } else if (n.doneAt) {
      done.push(n);
    } else if (n.startsAt) {
      open.push({ note: n, day: dayOf(n.startsAt, n.allDay) });
    } else {
      undated.push(n);
    }
  }
  // Dated reminders first, soonest first; then undated, newest first.
  open.sort(bySoonest);
  undated.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  done.sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt));

  const plain = notes.filter((n) => n.kind === 'NOTE');

  // Upcoming appointments under a heading per day.
  const days = new Map<string, Note[]>();
  for (const { note, day } of upcoming) days.set(day, [...(days.get(day) ?? []), note]);
  const shownOn = new Map(upcoming.map(({ note, day }) => [note.id, day]));

  return (
    <div className="page">
      <h1 className="form-title">Notes</h1>
      <input
        className="search notes-search"
        type="search"
        placeholder="Search notes and the calendar"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        enterKeyHint="search"
      />

      {search.length >= 2 ? (
        <NotesSearch query={search} />
      ) : (
      <>
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
                  <NoteRow
                    key={n.id}
                    note={n}
                    meta={[timeLabel(n, false, shownOn.get(n.id)), n.location].filter(Boolean).join(' · ')}
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {(open.length > 0 || undated.length > 0 || done.length > 0) && (
        <section className="notes-section">
          <h2 className="notes-section-title">Reminders</h2>
          <ul className="note-list">
            {open.map(({ note: n, day }) => (
              <NoteRow
                key={n.id}
                note={n}
                meta={`Due ${timeLabel(n, true, day)}`}
                overdue={isOverdue(n)}
                // The current occurrence of a repeating reminder is never shown ticked.
                checked={n.recurrence ? false : undefined}
                onToggle={() => toggle.mutate(n)}
              />
            ))}
            {undated.map((n) => (
              <NoteRow key={n.id} note={n} meta="" onToggle={() => toggle.mutate(n)} />
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
                    // A finished repeating series has nothing left to untick.
                    <NoteRow key={n.id} note={n} meta="" onToggle={n.recurrence ? undefined : () => toggle.mutate(n)} />
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

      </>
      )}
    </div>
  );
}

/** `value`, once it has stopped changing for `ms`. */
function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export function NoteRow({
  note,
  meta,
  overdue = false,
  checked = Boolean(note.doneAt),
  onToggle,
}: {
  note: Note;
  meta: string;
  overdue?: boolean;
  checked?: boolean;
  onToggle?: () => void;
}) {
  const thumb = thumbUrl(note.image);
  const repeats = repeatLabel(note);
  return (
    <li className={`note-row ${checked ? 'done' : ''}`}>
      {onToggle && (
        <button
          type="button"
          className={`check-circle ${checked ? 'on' : ''}`}
          onClick={onToggle}
          aria-label={checked ? 'Mark not done' : 'Mark done'}
        >
          {checked ? '✓' : ''}
        </button>
      )}
      <Link to={`/n/${note.id}`} className="note-link">
        <span className="note-text">
          <span className="note-title">{note.title}</span>
          {meta && <span className={`note-meta ${overdue ? 'overdue' : ''}`}>{meta}</span>}
          {repeats && <span className="note-meta">↻ {repeats}</span>}
        </span>
        {thumb && <img className="note-thumb" src={thumb} alt="" />}
      </Link>
    </li>
  );
}
