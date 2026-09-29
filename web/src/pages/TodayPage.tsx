import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dayLabel, dayOf, isOverdue, localDate, reminderDue, repeatLabel } from '../notes';
import type { Note, TodayCalendar, User } from '../types';

type CalendarEvent = TodayCalendar['events'][number];

/** One line on a day: a calendar event or a reminder from the app. */
type Item =
  | { type: 'event'; event: CalendarEvent; allDay: boolean; sort: string }
  | { type: 'reminder'; note: Note; sort: string };

const DAYS_AHEAD = 7;

/**
 * Home: the whole family calendar for today and the week ahead, reminders that
 * are due, and at-a-glance cards for this week's meals and the grocery list.
 */
export function TodayPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const calendar = useQuery({ queryKey: ['today'], queryFn: api.today, refetchInterval: 5 * 60_000 });
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

  const now = new Date();
  const today = localDate(now);
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)));
  const byDay = new Map<string, Item[]>(days.map((d) => [d, []]));
  const add = (day: string, item: Item) => byDay.get(day)?.push(item);

  for (const e of calendar.data?.events ?? []) {
    if (e.allDayDate) {
      // All-day events show on every day they cover.
      for (const d of days) if (d >= e.allDayDate && d < (e.allDayEnd ?? e.allDayDate)) add(d, { type: 'event', event: e, allDay: true, sort: '' });
      if (!e.allDayEnd) add(e.allDayDate, { type: 'event', event: e, allDay: true, sort: '' });
    } else if (e.start) {
      const start = new Date(e.start);
      // Already under way from an earlier day: show it today.
      const day = localDate(start) < today ? today : localDate(start);
      add(day, { type: 'event', event: e, allDay: false, sort: localDate(start) < today ? '00:00' : start.toTimeString().slice(0, 5) });
    }
  }
  for (const n of notes.data ?? []) {
    if (n.kind !== 'REMINDER' || !n.startsAt) continue;
    const due = n.recurrence ? reminderDue(n) : n.doneAt ? null : dayOf(n.startsAt, n.allDay);
    if (!due) continue;
    const sort = n.allDay ? '' : new Date(n.startsAt).toTimeString().slice(0, 5);
    add(due < today ? today : due, { type: 'reminder', note: n, sort });
  }
  for (const items of byDay.values()) items.sort((a, b) => a.sort.localeCompare(b.sort));

  const todayItems = byDay.get(today) ?? [];
  const upcoming = days.slice(1).filter((d) => byDay.get(d)!.length);
  const toCook = (plan.data ?? []).filter((p) => !p.cookedAt);
  const toBuy = (groceries.data ?? []).filter((g) => !g.checked).length;

  return (
    <div className="page today">
      <header className="today-header">
        <div>
          <p className="today-eyebrow">Today</p>
          <h1>{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
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

      <section className="agenda">
        {todayItems.length ? (
          <ul className="agenda-list">
            {todayItems.map((item, i) => (
              <AgendaRow key={i} item={item} now={now} isToday onToggle={(n) => toggle.mutate(n)} />
            ))}
          </ul>
        ) : (
          calendar.data && <p className="muted agenda-empty">Nothing on the calendar today.</p>
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
            <div key={day} className="aisle">
              <h2>{dayLabel(day)}</h2>
              <ul className="agenda-list">
                {byDay.get(day)!.map((item, i) => (
                  <AgendaRow key={i} item={item} now={now} onToggle={(n) => toggle.mutate(n)} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function AgendaRow({
  item,
  now,
  isToday = false,
  onToggle,
}: {
  item: Item;
  now: Date;
  isToday?: boolean;
  onToggle: (n: Note) => void;
}) {
  if (item.type === 'reminder') {
    const n = item.note;
    const overdue = isOverdue(n);
    const repeats = repeatLabel(n);
    return (
      <li className="agenda-row">
        <span className="agenda-time">{n.allDay ? 'Due' : clock(n.startsAt!)}</span>
        <button type="button" className="check-circle" aria-label="Mark done" onClick={() => onToggle(n)} />
        <Link to={`/n/${n.id}`} className="agenda-body">
          <span className="agenda-title">{n.title}</span>
          <span className={`agenda-meta ${overdue ? 'overdue' : ''}`}>
            {overdue ? `Overdue since ${dayLabel(dayOf(n.startsAt!, n.allDay))}` : 'Reminder'}
            {repeats ? ` · ↻ ${repeats}` : ''}
          </span>
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
