import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { dayLabel, dayOf, firstLine, isOverdue, isTodo, localDate, missedToday, movedToDay, reminderDue, repeatLabel } from '../notes';
import type { EventOwner, Note, TodayCalendar, User, Weather } from '../types';
import { OwnerEditor } from '../components/OwnerEditor';
import { NoteRow } from './NotesPage';

type CalendarEvent = TodayCalendar['events'][number];
type Household = { people: NonNullable<TodayCalendar['people']>; me: string | null };

/** One line on a day: a calendar event or a reminder from the app. */
type Item =
  | { type: 'event'; event: CalendarEvent; allDay: boolean; sort: string }
  | { type: 'reminder'; note: Note; sort: string };

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
  const todayItems = byDay.get(base) ?? [];
  const upcoming = days.slice(1).filter((d) => byDay.get(d)!.length);
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
        {!picked && <h2 className="day-card-head">Today</h2>}
        {todayItems.length ? (
          <ul className="agenda-list">
            {todayItems.map((item, i) => (
              <AgendaRow key={i} item={item} now={now} isToday={!picked} household={household} onToggle={(n) => toggle.mutate(n)} />
            ))}
          </ul>
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
              </h2>
              <ul className="agenda-list">
                {byDay.get(day)!.map((item, i) => (
                  <AgendaRow key={i} item={item} now={now} household={household} onToggle={(n) => toggle.mutate(n)} />
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
  onToggle,
}: {
  item: Item;
  now: Date;
  isToday?: boolean;
  household: Household;
  onToggle: (n: Note) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  if (item.type === 'reminder') {
    const n = item.note;
    const overdue = isOverdue(n);
    const repeats = repeatLabel(n);
    const detail = firstLine(n.body);
    return (
      <li className="agenda-row">
        <span className="agenda-time">{n.allDay ? 'Due' : clock(n.startsAt!)}</span>
        <button type="button" className="check-circle" aria-label="Mark done" onClick={() => onToggle(n)} />
        <Link to={`/n/${n.id}`} className="agenda-body">
          <span className="agenda-title">{n.title}</span>
          <span className={`agenda-meta ${overdue ? 'overdue' : ''}`}>
            {overdue ? `Overdue since ${dayLabel(dayOf(n.startsAt!, n.allDay))}` : n.endsAt ? `Reminder · until ${clock(n.endsAt)}` : 'Reminder'}
            {repeats ? ` · ↻ ${repeats}` : ''}
          </span>
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
    <li className={`agenda-row ${past ? 'past' : ''} ${current ? 'now' : ''} ${theirs ? 'theirs' : ''}`}>
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

/**
 * How an event shows on Today for whoever's looking. Another adult's (or no one's)
 * is muted; a child's isn't, since it usually needs a grown-up. Events that aren't
 * yours are labelled with whose they are. Everyone's and unsure ones show as yours.
 */
function ownership(owner: EventOwner | null | undefined, { people, me }: Household): { theirs: boolean; names: string[] } {
  if (!owner || owner.everyone || owner.unsure) return { theirs: false, names: [] };
  if (owner.people.length === 0) return { theirs: true, names: [] };
  if (me && owner.people.includes(me)) return { theirs: false, names: [] };
  const named = owner.people.flatMap((id) => people.find((p) => p.id === id) ?? []);
  // Not in the household by name: nothing is muted, but whose it is still shows.
  return { theirs: Boolean(me) && named.every((p) => p.adult), names: named.map((p) => p.name) };
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
