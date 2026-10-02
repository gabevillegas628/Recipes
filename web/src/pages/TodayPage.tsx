import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { freeFor, layoutDay, type Entry, type Line } from '../agenda';
import { api } from '../api';
import { dayLabel, dayOf, firstLine, isOverdue, localDate, movedToDay, reminderDue, repeatLabel } from '../notes';
import type { Note, TodayCalendar, User } from '../types';

type CalendarEvent = TodayCalendar['events'][number];

/** One line on a day: a calendar event or a reminder from the app. */
type Item =
  | { type: 'event'; event: CalendarEvent; allDay: boolean; sort: string }
  | { type: 'reminder'; note: Note; sort: string };

const DAYS_AHEAD = 7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Home: reminders that were missed, at the top so they get dealt with; the whole
 * family calendar for today and the week ahead, reminders that are due, and
 * at-a-glance cards for this week's meals and the grocery list.
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

  // Same as the Notes tab: a repeating reminder ticks off one occurrence and moves on.
  const toggle = useMutation({
    mutationFn: (n: Note) => api.updateNote(n.id, { done: Boolean(n.recurrence) || !n.doneAt }),
    onMutate: (n) =>
      queryClient.setQueryData<Note[]>(['notes'], (prev) =>
        prev?.map((x) => (x.id === n.id ? { ...x, doneAt: new Date().toISOString() } : x)),
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
    if (isOverdue(n)) {
      missed.push(n);
      continue;
    }
    const due = n.recurrence ? reminderDue(n) : n.doneAt ? null : dayOf(n.startsAt, n.allDay);
    if (!due) continue;
    const sort = n.allDay ? '' : new Date(n.startsAt).toTimeString().slice(0, 5);
    add(due < today ? today : due, { type: 'reminder', note: n, sort });
  }
  for (const items of byDay.values()) items.sort((a, b) => a.sort.localeCompare(b.sort));
  missed.sort((a, b) => a.startsAt!.localeCompare(b.startsAt!));

  const travelMinutes = calendar.data?.travelMinutes ?? 0;
  const lay = (day: string, main: boolean) =>
    layoutDay(
      byDay.get(day)!.map((item) => entryOf(item, day)),
      { now: main && !picked ? now : null, gaps: main, travelMinutes },
    );
  const todayItems = byDay.get(base) ?? [];
  const upcoming = days.slice(1).filter((d) => byDay.get(d)!.length);
  const toCook = (plan.data ?? []).filter((p) => !p.cookedAt);
  const toBuy = (groceries.data ?? []).filter((g) => !g.checked).length;

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

      {calendar.data && !calendar.data.connected && (
        <div className="banner">
          {calendar.data.error ?? 'See the family calendar here.'}{' '}
          <Link to="/settings/calendar">{calendar.data.error ? 'Reconnect' : 'Connect Google Calendar'}</Link>
        </div>
      )}
      {calendar.error && <p className="error">Couldn’t load the calendar: {calendar.error.message}</p>}

      {missed.length > 0 && (
        <section className="missed">
          <h2 className="notes-section-title">Missed</h2>
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

      <section className="agenda">
        {todayItems.length ? (
          <AgendaLines lines={lay(base, true)} now={now} isToday={!picked} onToggle={(n) => toggle.mutate(n)} />
        ) : (
          calendar.data && <p className="muted agenda-empty">Nothing on the calendar {picked ? 'that day' : 'today'}.</p>
        )}
      </section>

      {!picked && (
      <>
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
            <div key={day} className="aisle">
              <h2>{dayLabel(day)}</h2>
              <AgendaLines lines={lay(day, false)} now={now} onToggle={(n) => toggle.mutate(n)} />
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

/** An item placed in time on its day, for laying the day out (see agenda.ts). */
function entryOf(item: Item, day: string): Entry<Item> {
  if (item.type === 'event') {
    const e = item.event;
    return {
      item,
      title: e.title,
      start: item.allDay || !e.start ? null : new Date(e.start).getTime(),
      end: item.allDay || !e.end ? null : new Date(e.end).getTime(),
      who: e.who ?? [],
      everyone: Boolean(e.everyone),
      free: Boolean(e.free),
      place: e.location,
    };
  }
  const n = item.note;
  // A repeating reminder's occurrence on this day, at its usual time.
  const start = n.allDay || !n.startsAt ? null : new Date(`${day}T${item.sort}`).getTime();
  const length = n.endsAt && n.startsAt ? new Date(n.endsAt).getTime() - new Date(n.startsAt).getTime() : 0;
  return { item, title: n.title, start, end: start === null ? null : start + length, who: [], everyone: false, free: false, place: null };
}

/** A day's lines: things in order, overlaps grouped, and the free time between. */
function AgendaLines({
  lines,
  now,
  isToday = false,
  onToggle,
}: {
  lines: Line<Item>[];
  now: Date;
  isToday?: boolean;
  onToggle: (n: Note) => void;
}) {
  return (
    <ul className="agenda-list">
      {lines.map((line, i) => {
        if (line.type === 'gap') {
          return (
            <li
              key={i}
              className={`agenda-gap ${line.now ? 'now' : isToday && line.until !== null && line.until < now.getTime() ? 'past' : ''}`}
            >
              {line.now
                ? line.until === null
                  ? 'Now · nothing else on'
                  : `Now · free for ${freeFor(line.minutes)}`
                : `Free ${freeFor(line.minutes)}`}
            </li>
          );
        }
        if (line.type === 'overlap') {
          return (
            <li key={i} className={`agenda-overlap ${line.clash.length ? 'clash' : ''}`}>
              <span className="agenda-overlap-head">
                {line.clash.length ? `Double-booked: ${line.clash.join(', ')}` : 'At the same time'}
              </span>
              <ul className="agenda-list">
                {line.rows.map((row, j) => (
                  <AgendaRow key={j} item={row.item} tight={row.tight} now={now} isToday={isToday} onToggle={onToggle} />
                ))}
              </ul>
            </li>
          );
        }
        return <AgendaRow key={i} item={line.row.item} tight={line.row.tight} now={now} isToday={isToday} onToggle={onToggle} />;
      })}
    </ul>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** A reminder whose time has passed: tick it off, move it to tomorrow, or find it a new free time. */
function MissedRow({ note: n, tomorrow, onToggle }: { note: Note; tomorrow: string; onToggle: () => void }) {
  const queryClient = useQueryClient();
  const move = useMutation({
    mutationFn: () => api.updateNote(n.id, movedToDay(n, tomorrow)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });
  const day = dayOf(n.startsAt!, n.allDay);
  return (
    <li className="agenda-row missed-row">
      <span className="agenda-time">{n.allDay ? 'Due' : clock(n.startsAt!)}</span>
      <button type="button" className="check-circle" aria-label="Mark done" onClick={onToggle} />
      <div className="agenda-body">
        <Link to={`/n/${n.id}`} className="agenda-title">
          {n.title}
        </Link>
        <span className="agenda-meta overdue">{day === localDate(new Date()) ? 'Earlier today' : `Since ${dayLabel(day).replace('Yesterday', 'yesterday')}`}</span>
        {firstLine(n.body) && <span className="agenda-meta">{firstLine(n.body)}</span>}
        <span className="missed-actions">
          <button type="button" className="btn btn-small" disabled={move.isPending} onClick={() => move.mutate()}>
            Tomorrow
          </button>
          <Link to={`/n/${n.id}/time`} className="btn btn-small">
            Another time
          </Link>
        </span>
        {move.error && <span className="error">{move.error.message}</span>}
      </div>
    </li>
  );
}

function AgendaRow({
  item,
  tight,
  now,
  isToday = false,
  onToggle,
}: {
  item: Item;
  /** Too little time to get here from the last place (see agenda.ts). */
  tight: string | null;
  now: Date;
  isToday?: boolean;
  onToggle: (n: Note) => void;
}) {
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
          {tight && <span className="agenda-meta overdue">⚠ {tight}</span>}
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
  const body = (
    <>
      <span className="agenda-title">{e.title}</span>
      {meta && <span className="agenda-meta">{meta}</span>}
      {tight && <span className="agenda-meta overdue">⚠ {tight}</span>}
    </>
  );
  return (
    <li className={`agenda-row ${past ? 'past' : ''} ${current ? 'now' : ''}`}>
      <span className="agenda-time">{item.allDay ? 'All day' : clock(e.start!)}</span>
      {e.noteId ? (
        <Link to={`/n/${e.noteId}`} className="agenda-body">
          {body}
        </Link>
      ) : (
        <span className="agenda-body">{body}</span>
      )}
    </li>
  );
}
