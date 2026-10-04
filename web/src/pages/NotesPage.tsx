import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import { NotesSearch } from '../components/NotesSearch';
import { comingUpOn, dayLabel, dayOf, firstLine, isOverdue, reminderDue, repeatLabel, timeLabel } from '../notes';
import type { Note } from '../types';

type Section = 'notes' | 'todos' | 'reminders' | 'appointments';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'notes', label: 'Notes' },
  { key: 'todos', label: 'To-dos' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'appointments', label: 'Appointments' },
];

const SHOWN_KEY = 'notes-shown';
const SORT_KEY = 'notes-sort';
const FOLDED_KEY = 'notes-folded-groups';

type NoteSort = 'edited' | 'created';

/** This phone's saved setting; private browsing just doesn't remember. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered.
  }
}

/** The groups folded shut on this phone. */
function foldedGroups(): string[] {
  try {
    const list: unknown = JSON.parse(stored(FOLDED_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Everything saved from the Add tab: notes (by group), to-dos (reminders with no date),
 * reminders, then appointments coming up (by day), with chips to show just one
 * kind. Ticked-off items fold away; past appointments only show up in search,
 * which also looks through the family calendar's history.
 */
export function NotesPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim(), 300);
  const [params] = useSearchParams();
  // Which section to show: asked for in the link (?show=todos), or remembered on this phone.
  const [shown, setShown] = useState<Section | 'all'>(() => {
    try {
      const saved = params.get('show') ?? localStorage.getItem(SHOWN_KEY);
      return SECTIONS.some((x) => x.key === saved) ? (saved as Section) : 'all';
    } catch {
      return 'all';
    }
  });
  const pick = (section: Section | 'all') => {
    setShown(section);
    try {
      localStorage.setItem(SHOWN_KEY, section);
    } catch {
      // Private browsing: it just isn't remembered.
    }
  };

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
  const todos: Note[] = [];
  const doneReminders: Note[] = [];
  const doneTodos: Note[] = [];
  for (const n of notes) {
    if (n.kind !== 'REMINDER') continue;
    if (n.recurrence && n.startsAt) {
      const due = reminderDue(n);
      if (due) open.push({ note: n, day: due });
      else doneReminders.push(n);
    } else if (n.doneAt) {
      (n.startsAt ? doneReminders : doneTodos).push(n);
    } else if (n.startsAt) {
      open.push({ note: n, day: dayOf(n.startsAt, n.allDay) });
    } else {
      todos.push(n);
    }
  }
  // Reminders soonest first; to-dos newest first; done ones most recently done first.
  open.sort(bySoonest);
  todos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const byDone = (a: Note, b: Note) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt);
  doneReminders.sort(byDone);
  doneTodos.sort(byDone);

  // Notes newest first, by when they were last edited or when they were made.
  const [noteSort, setNoteSort] = useState<NoteSort>(() => (stored(SORT_KEY) === 'created' ? 'created' : 'edited'));
  const sortBy = (s: NoteSort) => {
    setNoteSort(s);
    store(SORT_KEY, s);
  };
  const sortField = noteSort === 'created' ? 'createdAt' : 'updatedAt';
  const plain = notes
    .filter((n) => n.kind === 'NOTE')
    .sort((a, b) => b[sortField].localeCompare(a[sortField]));
  // Notes in a card per group, biggest group first; ungrouped ones last.
  const groups = new Map<string, Note[]>();
  for (const n of plain) if (n.group) groups.set(n.group, [...(groups.get(n.group) ?? []), n]);
  const grouped = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const ungrouped = plain.filter((n) => !n.group);

  const rename = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => api.renameNoteGroup(from, to),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['note-groups'] });
    },
  });
  function askRename(group: string) {
    const to = prompt(`Rename "${group}" to (an existing group's name merges them; empty ungroups):`, group);
    if (to !== null && to.trim() !== group) rename.mutate({ from: group, to: to.trim() });
  }

  // Upcoming appointments under a heading per day.
  const days = new Map<string, Note[]>();
  for (const { note, day } of upcoming) days.set(day, [...(days.get(day) ?? []), note]);
  const shownOn = new Map(upcoming.map(({ note, day }) => [note.id, day]));

  // Open items per section, for the chips; a section with only done items still shows.
  const counts: Record<Section, number> = {
    notes: plain.length,
    todos: todos.length,
    reminders: open.length,
    appointments: upcoming.length,
  };
  const has: Record<Section, boolean> = {
    notes: plain.length > 0,
    todos: todos.length + doneTodos.length > 0,
    reminders: open.length + doneReminders.length > 0,
    appointments: upcoming.length > 0,
  };
  const present = SECTIONS.filter((x) => has[x.key]);
  // A remembered section that has since emptied out shows everything instead.
  const showing = shown !== 'all' && has[shown] ? shown : 'all';
  const show = (section: Section) => has[section] && (showing === 'all' || showing === section);

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
            Use <Link to="/add">Add</Link> to save a note, a to-do, a reminder or an appointment. Type it,
            say it, or snap a photo of a flyer.
          </p>
        </div>
      )}

      {present.length > 1 && (
        <div className="chips notes-filter" role="group" aria-label="Show">
          {[{ key: 'all' as const, label: 'All' }, ...present].map((x) => (
            <button
              key={x.key}
              type="button"
              className={`chip ${showing === x.key ? 'chip-on' : ''}`}
              aria-pressed={showing === x.key}
              onClick={() => pick(x.key)}
            >
              {x.label}
              {x.key !== 'all' && counts[x.key] > 0 && <span className="chip-count">{counts[x.key]}</span>}
            </button>
          ))}
        </div>
      )}

      {show('notes') && (
        <section className="notes-section">
          <div className="notes-section-head">
            <h2 className="notes-section-title">Notes</h2>
            <div className="chips notes-sort" role="group" aria-label="Sort notes by">
              {(['edited', 'created'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip ${noteSort === s ? 'chip-on' : ''}`}
                  aria-pressed={noteSort === s}
                  onClick={() => sortBy(s)}
                >
                  {s === 'edited' ? 'Edited' : 'Created'}
                </button>
              ))}
            </div>
          </div>
          {rename.error && <p className="error">{rename.error.message}</p>}
          {grouped.length === 0 ? (
            <ul className="note-list">
              {ungrouped.map((n) => (
                <NoteRow key={n.id} note={n} meta={firstLine(n.body)} />
              ))}
            </ul>
          ) : (
            <>
              {grouped.map(([group, items]) => (
                <NoteGroup key={group} name={group} items={items} onRename={() => askRename(group)} />
              ))}
              {ungrouped.length > 0 && <NoteGroup name="Other" items={ungrouped} />}
            </>
          )}
        </section>
      )}

      {show('todos') && (
        <section className="notes-section">
          <h2 className="notes-section-title">To-dos</h2>
          {todos.length > 0 ? (
            <ul className="note-list">
              {todos.map((n) => (
                <NoteRow key={n.id} note={n} meta="" onToggle={() => toggle.mutate(n)} />
              ))}
            </ul>
          ) : (
            <p className="muted small">All done.</p>
          )}
          <DoneFold items={doneTodos} onToggle={(n) => toggle.mutate(n)} />
        </section>
      )}

      {show('reminders') && (
        <section className="notes-section">
          <h2 className="notes-section-title">Reminders</h2>
          {open.length > 0 ? (
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
            </ul>
          ) : (
            <p className="muted small">All done.</p>
          )}
          <DoneFold items={doneReminders} onToggle={(n) => toggle.mutate(n)} />
        </section>
      )}

      {show('appointments') && (
        <section className="notes-section">
          <h2 className="notes-section-title">Appointments</h2>
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

      </>
      )}
    </div>
  );
}

/** Ticked-off reminders or to-dos, folded away under the open ones. */
function DoneFold({ items, onToggle }: { items: Note[]; onToggle: (n: Note) => void }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <>
      <button type="button" className="link-btn notes-fold" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Done ({items.length})
      </button>
      {open && (
        <ul className="note-list">
          {items.map((n) => (
            // A finished repeating series has nothing left to untick.
            <NoteRow key={n.id} note={n} meta="" onToggle={n.recurrence ? undefined : () => onToggle(n)} />
          ))}
        </ul>
      )}
    </>
  );
}

/** A group of notes as a card that folds shut; which ones are shut is remembered on this phone. */
function NoteGroup({ name, items, onRename }: { name: string; items: Note[]; onRename?: () => void }) {
  const [folded, setFolded] = useState(() => foldedGroups().includes(name));
  const toggle = () => {
    const next = !folded;
    setFolded(next);
    const rest = foldedGroups().filter((g) => g !== name);
    store(FOLDED_KEY, JSON.stringify(next ? [...rest, name] : rest));
  };
  return (
    <div className={`note-group ${folded ? 'folded' : ''}`}>
      <div className="note-group-head">
        <button type="button" className="note-group-toggle" aria-expanded={!folded} onClick={toggle}>
          <span className="note-group-caret" aria-hidden>
            {folded ? '▸' : '▾'}
          </span>
          <span className="note-group-name">{name}</span>
          <span className="note-group-count">{items.length}</span>
        </button>
        {onRename && !folded && (
          <button type="button" className="link-btn" onClick={onRename}>
            Rename
          </button>
        )}
      </div>
      {!folded && (
        <ul className="note-list">
          {items.map((n) => (
            <NoteRow key={n.id} note={n} meta={firstLine(n.body)} />
          ))}
        </ul>
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
  // A plain note's details are already its meta line.
  const detail = note.kind === 'NOTE' ? '' : firstLine(note.body);
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
          {detail && <span className="note-meta">{detail}</span>}
        </span>
        {thumb && <img className="note-thumb" src={thumb} alt="" />}
      </Link>
    </li>
  );
}
