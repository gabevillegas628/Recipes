import { closestCenter, DndContext, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type Ref } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { blockOn, dayLabel, dayOf, firstLine, isOverdue, isTodo, localDate, missedToday, movedToDay, reminderDue, repeatLabel } from '../notes';
import type { Note, NoteInput, TodayCalendar, User, Weather } from '../types';
import { OwnerEditor } from '../components/OwnerEditor';
import { SortOutDay, type DayClashes } from '../components/SortOutDay';
import { busyOn, clashingReminders, dropStart, freeBetween, hhmm, minutesInto, minutesOf, overlaps, ownership, remindersOn, type Household, type Span } from '../freeTime';
import { NoteRow } from './NotesPage';

type CalendarEvent = TodayCalendar['events'][number];

/** One line on a day: a calendar event or a reminder from the app. */
type Item =
  | { type: 'event'; event: CalendarEvent; allDay: boolean; sort: string }
  | { type: 'reminder'; note: Note; sort: string }
  | { type: 'free'; free: Span; day: string; sort: string };

const DAYS_AHEAD = 7;
/** To-dos listed on Today; the rest are a tap away on Notes. */
const TODOS_SHOWN = 5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Home: reminders that were missed, at the top so they get dealt with; the whole
 * family calendar for today and the week ahead, reminders that are due, and
 * at-a-glance cards for this week's meals, the grocery list and to-dos.
 * Tapping the date looks at any other day instead (?date=YYYY-MM-DD).
 */
export function TodayPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const now = new Date();
  const today = localDate(now);
  const asked = params.get('date') ?? '';
  const picked = DATE.test(asked) && asked !== today ? asked : null;

  const calendar = useQuery({
    queryKey: ['today', picked ?? 'now'],
    queryFn: () => (picked ? api.today(picked, 1) : api.today()),
    refetchInterval: 5 * 60_000,
  });
  const notes = useQuery({ queryKey: ['notes'], queryFn: api.notes });
  const plan = useQuery({ queryKey: ['plan'], queryFn: api.plan });
  const groceries = useQuery({ queryKey: ['groceries'], queryFn: api.groceries });
  const weather = useQuery({ queryKey: ['weather'], queryFn: api.weather, refetchInterval: 30 * 60_000 });

  // To-dos ticked off here stay listed (ticked) until the page is left, so a mis-tap can be undone.
  const [ticked, setTicked] = useState<string[]>([]);
  // The day whose clashes are being sorted out, under its heading.
  const [sorting, setSorting] = useState<string | null>(null);

  // A reminder dragged to a new time: moved at once, with a moment to undo it.
  const [moved, setMoved] = useState<{ note: Note; start: number } | null>(null);
  const move = useMutation({
    mutationFn: ({ note, at }: { note: Note; at: Pick<NoteInput, 'startsAt' | 'endsAt'> }) => api.updateNote(note.id, at),
    onMutate: ({ note, at }) =>
      queryClient.setQueryData<Note[]>(['notes'], (prev) =>
        prev?.map((x) => (x.id === note.id ? { ...x, startsAt: at.startsAt ?? null, endsAt: at.endsAt ?? null } : x)),
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
  useEffect(() => {
    if (!moved) return;
    const t = setTimeout(() => setMoved(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [moved]);
  /** Moves a one-off reminder to `start` minutes into `day`, keeping its length. */
  function moveTo(note: Note, day: string, start: number) {
    const length = lengthOf(note);
    const at = blockOn(day, start, start + length);
    move.mutate({ note, at: { startsAt: at.startsAt, endsAt: length ? at.endsAt : null } });
    setMoved({ note, start });
  }
  function undoMove() {
    if (!moved) return;
    move.mutate({ note: moved.note, at: { startsAt: moved.note.startsAt, endsAt: moved.note.endsAt } });
    setMoved(null);
  }

  // Same as the Notes tab: a repeating reminder ticks off one occurrence and moves on.
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

  // The day at the top, and the days listed: a week from today, or just the picked day.
  const base = picked ?? today;
  const days = picked
    ? [picked]
    : Array.from({ length: DAYS_AHEAD }, (_, i) => localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)));
  const byDay = new Map<string, Item[]>(days.map((d) => [d, []]));
  const add = (day: string, item: Item) => byDay.get(day)?.push(item);

  for (const e of calendar.data?.events ?? []) {
    if (e.allDayDate) {
      // All-day events show on every day they cover.
      for (const d of days) if (d >= e.allDayDate && d < (e.allDayEnd ?? e.allDayDate)) add(d, { type: 'event', event: e, allDay: true, sort: '' });
      if (!e.allDayEnd) add(e.allDayDate, { type: 'event', event: e, allDay: true, sort: '' });
    } else if (e.start) {
      const start = new Date(e.start);
      // Already under way from an earlier day: show it on the first day listed.
      const day = localDate(start) < base ? base : localDate(start);
      add(day, { type: 'event', event: e, allDay: false, sort: localDate(start) < base ? '00:00' : start.toTimeString().slice(0, 5) });
    }
  }
  // Reminders to tick off only belong on today's view; another day shows them as they were on the calendar.
  const missed: Note[] = [];
  for (const n of picked ? [] : (notes.data ?? [])) {
    if (n.kind !== 'REMINDER' || !n.startsAt) continue;
    if (isOverdue(n) || missedToday(n, now)) {
      missed.push(n);
      continue;
    }
    const due = n.recurrence ? reminderDue(n) : n.doneAt ? null : dayOf(n.startsAt, n.allDay);
    if (!due) continue;
    const sort = n.allDay ? '' : new Date(n.startsAt).toTimeString().slice(0, 5);
    add(due < today ? today : due, { type: 'reminder', note: n, sort });
  }
  for (const items of byDay.values()) items.sort((a, b) => a.sort.localeCompare(b.sort));
  // A repeating reminder was missed at today's occurrence, not its first one.
  const missedAt = (n: Note) =>
    n.recurrence ? new Date(`${today}T${new Date(n.startsAt!).toTimeString().slice(0, 5)}`).getTime() : new Date(n.startsAt!).getTime();
  missed.sort((a, b) => missedAt(a) - missedAt(b));

  const household: Household = { people: calendar.data?.people ?? [], me: calendar.data?.me ?? null };
  const myDay = calendar.data?.day;
  // Clashes per day, for today (from now on) and the days coming up.
  const clashes = new Map<string, DayClashes>();
  if (!picked && myDay && calendar.data?.connected && notes.data) {
    const { events: calendarEvents } = calendar.data;
    const allNotes = notes.data;
    const minuteNow = now.getHours() * 60 + now.getMinutes();
    const dayHours = { from: minutesOf(myDay.start), to: minutesOf(myDay.end) };
    const busyFor = (day: string) => busyOn(day, calendarEvents, allNotes, household, user.name);

    // Free time each day between your own busy times, within your day's hours (today, from now on).
    const todayWindow = { from: Math.max(dayHours.from, Math.ceil(minuteNow / 5) * 5), to: dayHours.to };
    for (const day of days) {
      const { from, to } = day === today ? todayWindow : dayHours;
      for (const free of freeBetween(busyFor(day), from, to)) add(day, { type: 'free', free, day, sort: hhmm(free.start) });
      byDay.get(day)?.sort((a, b) => a.sort.localeCompare(b.sort));
    }

    days.forEach((day, i) => {
      // Your reminders still to come that run into an event or each other.
      const reminders = remindersOn(day, allNotes, user.name).filter((r) => day !== today || r.start >= minuteNow);
      const events = busyFor(day).filter((b) => !b.noteId);
      const clashing = new Map<string, string>();
      for (const id of clashingReminders(reminders, events)) {
        const r = reminders.find((x) => x.note.id === id)!;
        clashing.set(id, events.find((e) => overlaps(r, e))?.title ?? reminders.find((o) => o !== r && overlaps(r, o))!.note.title);
      }
      // Repeating reminders can't be moved one day at a time, so they alone leave nothing to sort out.
      if (!reminders.some((r) => clashing.has(r.note.id) && !r.note.recurrence)) return;
      // What doesn't fit can go to the next day, if the calendar's been read that far.
      const next = days[i + 1];
      clashes.set(day, {
        day,
        reminders,
        events,
        window: day === today ? todayWindow : dayHours,
        next: next ? { day: next, busy: busyFor(next), ...dayHours } : null,
        clashing,
      });
    });
  }
  const todayItems = byDay.get(base) ?? [];
  // Days with something on; a day that's all free time isn't worth a card.
  const upcoming = days.slice(1).filter((d) => byDay.get(d)!.some((item) => item.type !== 'free'));
  const toCook = (plan.data ?? []).filter((p) => !p.cookedAt);
  const toBuy = (groceries.data ?? []).filter((g) => !g.checked).length;
  // Open to-dos (and ones just ticked here), newest first, as on the Notes tab.
  const todos = (notes.data ?? [])
    .filter((n) => isTodo(n) && (!n.doneAt || ticked.includes(n.id)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const openTodos = todos.filter((n) => !n.doneAt).length;

  return (
    <div className="page today">
      <header className="today-header">
        <div>
          <p className="today-eyebrow">{eyebrow(picked, today)}</p>
          {/* The date is a date picker: an invisible date input laid over it. */}
          <label className="today-date">
            <h1>
              {dateOf(base).toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                ...(base.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
              })}
              <span className="today-date-caret" aria-hidden>
                ▾
              </span>
            </h1>
            <input
              type="date"
              aria-label="Go to a date"
              value={base}
              onClick={(e) => e.currentTarget.showPicker?.()}
              onChange={(e) => setParams(e.target.value && e.target.value !== today ? { date: e.target.value } : {})}
            />
          </label>
          {picked && (
            <button type="button" className="link-btn" onClick={() => setParams({})}>
              ‹ Back to today
            </button>
          )}
        </div>
        <Link to="/settings" className="avatar" aria-label="Settings">
          {user.name.charAt(0).toUpperCase()}
        </Link>
      </header>

      {!picked && weather.data?.weather && <WeatherLine weather={weather.data.weather} />}

      {calendar.data && !calendar.data.connected && (
        <div className="banner">
          {calendar.data.error ?? 'See the family calendar here.'}{' '}
          <Link to="/settings/calendar">{calendar.data.error ? 'Reconnect' : 'Connect Google Calendar'}</Link>
        </div>
      )}
      {calendar.error && <p className="error">Couldn’t load the calendar: {calendar.error.message}</p>}

      {missed.length > 0 && (
        <section className="day-card missed">
          <h2 className="day-card-head">Missed</h2>
          <ul className="agenda-list">
            {missed.map((n) => (
              <MissedRow
                key={n.id}
                note={n}
                tomorrow={localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))}
                onToggle={() => toggle.mutate(n)}
              />
            ))}
          </ul>
        </section>
      )}

      <section className={`day-card ${picked ? '' : 'day-card-today'}`}>
        {/* A picked day's date is already the page heading. */}
        {!picked && (
          <h2 className="day-card-head">
            Today
            {clashes.has(today) && sorting !== today && (
              <button type="button" className="link-btn day-card-action" onClick={() => setSorting(today)}>
                ⚠ Sort out my day
              </button>
            )}
          </h2>
        )}
        {sorting === today && clashes.has(today) && <SortOutDay clashes={clashes.get(today)!} onClose={() => setSorting(null)} />}
        {todayItems.length ? (
          <DayList
            day={base}
            items={todayItems}
            canDrag={!picked}
            now={now}
            isToday={!picked}
            household={household}
            clashing={clashes.get(base)?.clashing}
            onToggle={(n) => toggle.mutate(n)}
            onMove={moveTo}
          />
        ) : (
          calendar.data && <p className="muted agenda-empty">Nothing on the calendar {picked ? 'that day' : 'today'}.</p>
        )}
      </section>

      {!picked && (
      <>
      <section className="today-card today-todos">
        <Link to="/notes?show=todos" className="today-todos-head">
          <span className="today-card-value">
            {openTodos ? `${openTodos} ${openTodos === 1 ? 'Todo' : 'Todo’s'}` : 'Todo’s'}
          </span>
          <span className="today-card-label">See all ›</span>
        </Link>
        {notes.data && todos.length === 0 && <span className="today-card-detail">Nothing to do</span>}
        {todos.length > 0 && (
          <ul className="note-list">
            {todos.slice(0, TODOS_SHOWN).map((n) => (
              <NoteRow
                key={n.id}
                note={n}
                meta=""
                onToggle={() => {
                  setTicked((prev) => (prev.includes(n.id) ? prev : [...prev, n.id]));
                  toggle.mutate(n);
                }}
              />
            ))}
          </ul>
        )}
        {todos.length > TODOS_SHOWN && (
          <Link to="/notes?show=todos" className="today-card-detail">
            {todos.length - TODOS_SHOWN} more
          </Link>
        )}
      </section>

      <div className="today-cards">
        <Link to="/week" className="today-card">
          <span className="today-card-label">This week’s meals</span>
          {plan.data &&
            (toCook.length ? (
              <>
                <span className="today-card-value">{toCook.length} to cook</span>
                <span className="today-card-detail">{toCook.slice(0, 2).map((p) => p.recipe.title).join(' · ')}</span>
              </>
            ) : (
              <span className="today-card-detail">Nothing planned yet</span>
            ))}
        </Link>
        <Link to="/groceries" className="today-card">
          <span className="today-card-label">Groceries</span>
          {groceries.data &&
            (toBuy ? (
              <span className="today-card-value">
                {toBuy} {toBuy === 1 ? 'item' : 'items'}
              </span>
            ) : (
              <span className="today-card-detail">List is empty</span>
            ))}
        </Link>
      </div>

      {upcoming.length > 0 && (
        <section className="agenda-upcoming">
          <h2 className="notes-section-title">Coming up</h2>
          {upcoming.map((day) => (
            <div key={day} className="day-card">
              <h2 className="day-card-head">
                {dayLabel(day)}
                {/* Days further off are already labelled with their date. */}
                {!/\d/.test(dayLabel(day)) && <span className="day-card-date">{shortDate(day)}</span>}
                {clashes.has(day) && sorting !== day && (
                  <button type="button" className="link-btn day-card-action" onClick={() => setSorting(day)}>
                    ⚠ Sort out this day
                  </button>
                )}
              </h2>
              {sorting === day && clashes.has(day) && <SortOutDay clashes={clashes.get(day)!} onClose={() => setSorting(null)} />}
              <DayList
                day={day}
                items={byDay.get(day)!}
                canDrag
                now={now}
                household={household}
                clashing={clashes.get(day)?.clashing}
                onToggle={(n) => toggle.mutate(n)}
                onMove={moveTo}
              />
            </div>
          ))}
        </section>
      )}
      </>
      )}

      {(moved || move.error) && (
        <div className="toast" role="status">
          <span>{move.error ? `Couldn’t move it: ${move.error.message}` : `Moved ${moved!.note.title} to ${clockAt(moved!.start)}`}</span>
          {moved && !move.error && (
            <button type="button" className="link-btn" onClick={undoMove}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** How long Undo stays offered after a drag. */
const UNDO_MS = 6000;

/** A reminder's length in minutes; 0 for a plain one. */
const lengthOf = (n: Note) => (n.endsAt ? Math.round((new Date(n.endsAt).getTime() - new Date(n.startsAt!).getTime()) / 60_000) : 0);

/** Reminders that can be dragged to another time: one-offs at a time of day. Repeating ones would move the whole series. */
const movable = (item: Item) =>
  item.type === 'reminder' && !item.note.recurrence && !item.note.allDay && Boolean(item.note.startsAt) && !item.note.doneAt;

/** A stable id per row while dragging. */
function rowId(item: Item, i: number) {
  if (item.type === 'reminder') return `r:${item.note.id}`;
  if (item.type === 'free') return `f:${item.free.start}`;
  return `e:${i}:${item.event.title}`;
}

/** A row's span of your time on `day`, for working out where a dropped reminder goes; null if it takes none. */
function rowSpan(item: Item, day: string, household: Household): Span | null {
  if (item.type === 'free') return { start: item.free.start, end: item.free.start };
  if (item.type === 'reminder') {
    if (item.note.allDay || !item.note.startsAt) return null;
    const start = minutesInto(day, new Date(item.note.startsAt));
    return { start, end: start + lengthOf(item.note) };
  }
  const e = item.event;
  if (item.allDay || !e.start || !e.end || ownership(e.owner, household).theirs) return null;
  return { start: minutesInto(day, new Date(e.start)), end: minutesInto(day, new Date(e.end)) };
}

/** What a row in a DayList gets from it: where it is, how it moves, and the time it would drop at. */
interface Drag {
  ref: Ref<HTMLLIElement>;
  style: CSSProperties;
  props: HTMLAttributes<HTMLLIElement>;
  dragging: boolean;
  /** Minutes since midnight it would start at if dropped now. */
  preview: number | null;
}

/** A row's <li> attributes, drag wiring included. */
type RowElement = HTMLAttributes<HTMLLIElement> & { ref?: Ref<HTMLLIElement> };

type RowProps = Omit<Parameters<typeof AgendaRow>[0], 'item' | 'drag' | 'clashWith'>;

/**
 * A day's rows. Press and hold a one-off reminder to drag it among them; it
 * starts when the row above it ends (see dropStart), keeping its length.
 */
function DayList({
  day,
  items,
  canDrag,
  clashing,
  onMove,
  ...row
}: RowProps & {
  day: string;
  items: Item[];
  canDrag: boolean;
  clashing?: Map<string, string>;
  onMove: (note: Note, day: string, start: number) => void;
}) {
  // Held, not just touched, so scrolling the page still works.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
  );
  const ids = items.map(rowId);
  const [preview, setPreview] = useState<{ id: string; start: number } | null>(null);
  // A drop can end with a click on whatever's under the pointer; that click isn't meant.
  const droppedAt = useRef(0);

  const startOf = (item: Item) => rowSpan(item, day, row.household)?.start ?? 0;
  /** Where the dragged reminder would start if dropped over `overId`. */
  function startFor(activeId: string, overId: string): number {
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    const dragged = items[from];
    if (from < 0 || to < 0 || from === to || dragged.type !== 'reminder') return startOf(dragged);
    const arranged = arrayMove(items, from, to).map((item) => rowSpan(item, day, row.household));
    return dropStart(arranged.slice(0, to), arranged.slice(to + 1), lengthOf(dragged.note)) ?? startOf(dragged);
  }

  const onDragStart = ({ active }: DragStartEvent) =>
    setPreview({ id: String(active.id), start: startOf(items[ids.indexOf(String(active.id))]) });
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (over) setPreview({ id: String(active.id), start: startFor(String(active.id), String(over.id)) });
  };
  function onDragEnd({ active, over }: DragEndEvent) {
    setPreview(null);
    droppedAt.current = Date.now();
    const item = items[ids.indexOf(String(active.id))];
    if (!over || !item || item.type !== 'reminder') return;
    const start = startFor(String(active.id), String(over.id));
    if (start !== startOf(item)) onMove(item.note, day, start);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setPreview(null)}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul
          className="agenda-list"
          onClickCapture={(e) => {
            if (Date.now() - droppedAt.current < 400) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          {items.map((item, i) => (
            <SortableRow
              key={ids[i]}
              id={ids[i]}
              item={item}
              canDrag={canDrag && movable(item)}
              preview={preview?.id === ids[i] ? preview.start : null}
              clashWith={item.type === 'reminder' ? clashing?.get(item.note.id) : undefined}
              {...row}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

/** A row in a DayList: every row makes way for a dragged one; only movable reminders can be picked up. */
function SortableRow({
  id,
  canDrag,
  preview,
  ...rest
}: RowProps & { id: string; item: Item; canDrag: boolean; preview: number | null; clashWith?: string }) {
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({ id, disabled: { draggable: !canDrag, droppable: false } });
  const drag: Drag = {
    ref: setNodeRef,
    // Up and down only.
    style: { transform: CSS.Transform.toString(transform && { ...transform, x: 0, scaleX: 1, scaleY: 1 }), transition },
    // Holding a link would otherwise open the phone's link menu.
    props: canDrag ? { ...listeners, onContextMenu: (e) => e.preventDefault(), className: 'draggable' } : {},
    dragging: isDragging,
    preview,
  };
  return <AgendaRow {...rest} drag={drag} />;
}

/** "Today", "Yesterday", "Friday" for days nearby; further off, which way you're looking. */
function eyebrow(picked: string | null, today: string) {
  if (!picked) return 'Today';
  const near = dayLabel(picked);
  // dayLabel gives words for nearby days and a date otherwise, which the heading already shows.
  return /\d/.test(near) ? (picked < today ? 'Looking back' : 'Looking ahead') : near;
}

/** A local Date for "YYYY-MM-DD". */
function dateOf(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "Oct 9", beside a day's name in its card. */
const shortDate = (day: string) => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** A reminder whose time has passed: tick it off, move it to tomorrow, or find it a new free time. */
function MissedRow({ note: n, tomorrow, onToggle }: { note: Note; tomorrow: string; onToggle: () => void }) {
  const queryClient = useQueryClient();
  const move = useMutation({
    mutationFn: () => api.updateNote(n.id, movedToDay(n, tomorrow)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });
  // Repeating reminders are only missed today; moving one would move the whole series, so ticking it is the way on.
  const day = n.recurrence ? localDate(new Date()) : dayOf(n.startsAt!, n.allDay);
  const repeats = repeatLabel(n);
  return (
    <li className="agenda-row missed-row">
      <span className="agenda-time">{n.allDay ? 'Due' : clock(n.startsAt!)}</span>
      <button type="button" className="check-circle" aria-label="Mark done" onClick={onToggle} />
      <div className="agenda-body">
        <Link to={`/n/${n.id}`} className="agenda-title">
          {n.title}
        </Link>
        <span className="agenda-meta overdue">
          {day === localDate(new Date()) ? 'Earlier today' : `Since ${dayLabel(day).replace('Yesterday', 'yesterday')}`}
          {repeats ? ` · ↻ ${repeats}` : ''}
        </span>
        {firstLine(n.body) && <span className="agenda-meta">{firstLine(n.body)}</span>}
        {!n.recurrence && <span className="missed-actions">
          <button type="button" className="btn btn-small" disabled={move.isPending} onClick={() => move.mutate()}>
            Tomorrow
          </button>
          <Link to={`/n/${n.id}/time`} className="btn btn-small">
            Another time
          </Link>
        </span>}
        {move.error && <span className="error">{move.error.message}</span>}
      </div>
    </li>
  );
}

function AgendaRow({
  item,
  now,
  isToday = false,
  household,
  clashWith,
  onToggle,
  drag,
}: {
  item: Item;
  now: Date;
  isToday?: boolean;
  household: Household;
  /** What a reminder runs into, when it clashes. */
  clashWith?: string;
  onToggle: (n: Note) => void;
  /** Set in a DayList. */
  drag?: Drag;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  // The list's drag wiring goes on the row itself, with how it looks while dragged.
  const { className: dragClass = '', ...dragProps } = drag?.props ?? {};
  const li = (className: string): RowElement => ({
    ref: drag?.ref,
    style: drag?.style,
    ...dragProps,
    className: `${className} ${dragClass} ${drag?.dragging ? 'dragging' : ''}`,
  });
  if (item.type === 'free') return <FreeRow free={item.free} day={item.day} now={now} li={li('agenda-row free-row')} />;

  if (item.type === 'reminder') {
    const n = item.note;
    const overdue = isOverdue(n);
    const repeats = repeatLabel(n);
    const detail = firstLine(n.body);
    return (
      <li {...li('agenda-row')}>
        {drag?.preview != null ? (
          <span className="agenda-time drag-time">→ {clockAt(drag.preview)}</span>
        ) : (
          <span className="agenda-time">{n.allDay ? 'Due' : clock(n.startsAt!)}</span>
        )}
        <button type="button" className="check-circle" aria-label="Mark done" onClick={() => onToggle(n)} />
        <Link to={`/n/${n.id}`} className="agenda-body" draggable={false}>
          <span className="agenda-title">{n.title}</span>
          <span className={`agenda-meta ${overdue ? 'overdue' : ''}`}>
            {overdue ? `Overdue since ${dayLabel(dayOf(n.startsAt!, n.allDay))}` : n.endsAt ? `Reminder · until ${clock(n.endsAt)}` : 'Reminder'}
            {repeats ? ` · ↻ ${repeats}` : ''}
          </span>
          {clashWith && <span className="agenda-meta clash">⚠ Runs into {clashWith}</span>}
          {detail && <span className="agenda-meta">{detail}</span>}
        </Link>
      </li>
    );
  }

  const e = item.event;
  const start = e.start ? new Date(e.start) : null;
  const end = e.end ? new Date(e.end) : null;
  const past = isToday && end !== null && end < now;
  const current = isToday && start !== null && end !== null && start <= now && now < end;
  const meta = [!item.allDay && end ? `until ${clock(e.end!)}` : null, e.location].filter(Boolean).join(' · ');
  const { theirs, names } = ownership(e.owner, household);
  const body = (
    <>
      <span className="agenda-title">
        {e.title}
        {names.map((name) => (
          <span key={name} className="owner-tag">
            {name}
          </span>
        ))}
      </span>
      {meta && <span className="agenda-meta">{meta}</span>}
    </>
  );
  return (
    <li {...li(`agenda-row ${past ? 'past' : ''} ${current ? 'now' : ''} ${theirs ? 'theirs' : ''}`)}>
      <span className="agenda-time">{item.allDay ? 'All day' : clock(e.start!)}</span>
      {e.noteId ? (
        <Link to={`/n/${e.noteId}`} className="agenda-body">
          {body}
        </Link>
      ) : e.owner && household.people.length ? (
        // Tap a calendar event to say whose it is.
        <button type="button" className="agenda-body agenda-body-btn" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
          {body}
        </button>
      ) : (
        <span className="agenda-body">{body}</span>
      )}
      {editing && e.owner && (
        <OwnerEditor
          title={e.title}
          people={household.people}
          owner={e.owner}
          onSaved={() => {
            setEditing(false);
            queryClient.invalidateQueries({ queryKey: ['today'] });
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

/** "1:30 PM" for minutes since midnight. */
const clockAt = (minutes: number) =>
  new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "1 h 30 min", "45 min". */
function howLong(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

/** Appointments made from free time start out this long, or shorter if the gap is. */
const APPOINTMENT_MINUTES = 60;

/** Free time between your busy times on a day: tap it to add a reminder or appointment then. */
function FreeRow({ free, day, now, li }: { free: Span; day: string; now: Date; li: RowElement }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const add = (kind: 'reminder' | 'appointment') => {
    const end = kind === 'appointment' ? Math.min(free.end, free.start + APPOINTMENT_MINUTES) : null;
    const params = new URLSearchParams({ add: kind, date: day, time: hhmm(free.start), ...(end ? { end: hhmm(end) } : {}) });
    navigate(`/add?${params}`);
  };
  return (
    <li {...li}>
      <span className="agenda-time">{day === localDate(now) && free.start <= nowMinutes + 5 ? 'Now' : clockAt(free.start)}</span>
      <button type="button" className="agenda-body agenda-body-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="agenda-title">Free until {clockAt(free.end)}</span>
        <span className="agenda-meta">{howLong(free.end - free.start)}</span>
      </button>
      {open && (
        <div className="free-actions">
          <button type="button" className="btn btn-small" onClick={() => add('reminder')}>
            + Reminder
          </button>
          <button type="button" className="btn btn-small" onClick={() => add('appointment')}>
            + Appointment
          </button>
        </div>
      )}
    </li>
  );
}

/** What to know when packing: an umbrella (or boots) if it's likely, and the high and low. */
function WeatherLine({ weather }: { weather: Weather }) {
  const { wet, high, low } = weather;
  return (
    <p className={`weather-line${wet ? ' weather-line-wet' : ''}`} title={weather.place}>
      {wet && (
        <span className="weather-wet">
          <span aria-hidden>{wet.kind === 'snow' ? '❄️' : '☂️'}</span> {wet.kind === 'snow' ? 'Snow' : 'Rain'} likely {wet.when}
          <span className="weather-chance"> · {wet.chance}%</span>
        </span>
      )}
      <span className="weather-temps">
        High {high}° · Low {low}°
      </span>
    </p>
  );
}
