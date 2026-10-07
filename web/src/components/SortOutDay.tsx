import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { planMoves, type Busy, type Move, type ReminderOn } from '../freeTime';
import { blockOn, dayLabel } from '../notes';

/** A day's clashes, as Today found them, for sorting out. */
export interface DayClashes {
  day: string;
  /** Your reminders still to come that day. */
  reminders: ReminderOn[];
  /** Calendar events that take your time that day. */
  events: Busy[];
  /** Where moved reminders can go that day: your day's hours (from now, today). */
  window: { from: number; to: number };
  /** The day after, for what doesn't fit; null past what Today has read of the calendar. */
  next: { day: string; busy: Busy[]; from: number; to: number } | null;
  /** The reminders that clash, and the first thing each runs into. */
  clashing: Map<string, string>;
}

const clockAt = (minutes: number) =>
  new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * "Sort out my day": the reminders that clash, each with a lock, and where the
 * unlocked ones would go (see planMoves). Nothing changes until Apply. Repeating
 * reminders stay locked: moving one would move the whole series.
 */
export function SortOutDay({ clashes, onClose }: { clashes: DayClashes; onClose: () => void }) {
  const queryClient = useQueryClient();
  const involved = clashes.reminders.filter((r) => clashes.clashing.has(r.note.id));
  const [locked, setLocked] = useState<Set<string>>(() => new Set(involved.filter((r) => r.note.recurrence).map((r) => r.note.id)));
  const moves = planMoves(clashes.reminders, clashes.events, locked, clashes.window, clashes.next, clashes.day);
  const placed = moves.filter((m) => m.to);

  const apply = useMutation({
    mutationFn: () =>
      Promise.all(
        placed.map((m) => {
          const at = blockOn(m.day, m.to!.start, m.to!.end);
          // A plain reminder stays a moment, with no end.
          return api.updateNote(m.note.id, { startsAt: at.startsAt, endsAt: m.to!.end > m.to!.start ? at.endsAt : null });
        }),
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['today'] });
    },
    onSuccess: onClose,
  });

  const toggle = (id: string) =>
    setLocked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="sort-day">
      <p className="muted small">Locked ones keep their time. The rest move to the nearest free time.</p>
      <ul className="sort-day-list">
        {involved.map((r) => (
          <li key={r.note.id} className={`sort-day-row ${locked.has(r.note.id) ? 'locked' : ''}`}>
            <div className="sort-day-text">
              <span className="agenda-title">{r.note.title}</span>
              <span className="agenda-meta">
                {clockAt(r.start)} · runs into {clashes.clashing.get(r.note.id)}
                {r.note.recurrence ? ' · repeats, so it stays' : ''}
              </span>
              <span className="sort-day-move">{describe(moves.find((m) => m.note.id === r.note.id), locked.has(r.note.id), clashes.day, r.start)}</span>
            </div>
            {/* Spelled out: the open and shut lock emoji look too alike at this size. */}
            <button
              type="button"
              className={`lock-btn ${locked.has(r.note.id) ? 'on' : ''}`}
              aria-pressed={locked.has(r.note.id)}
              disabled={Boolean(r.note.recurrence)}
              onClick={() => toggle(r.note.id)}
            >
              {locked.has(r.note.id) ? '🔒 Locked' : 'Can move'}
            </button>
          </li>
        ))}
      </ul>
      {apply.error && <p className="error">{apply.error.message}</p>}
      <div className="settings-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={!placed.length || apply.isPending} onClick={() => apply.mutate()}>
          {apply.isPending ? 'Moving…' : placed.length ? `Apply ${placed.length === 1 ? 'move' : `${placed.length} moves`}` : 'Nothing to move'}
        </button>
        <button type="button" className="btn btn-small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What happens to one reminder: "→ 3:15 PM", "→ Friday 2:30 PM", or why it stays. */
function describe(move: Move | undefined, locked: boolean, day: string, at: number) {
  if (locked) return `Stays at ${clockAt(at)}`;
  if (!move) return 'Stays (clear once the others move)';
  if (!move.to) return 'No free time that day or the next: stays';
  const length = move.to.end > move.to.start ? `–${clockAt(move.to.end)}` : '';
  return `→ ${move.day === day ? '' : `${dayLabel(move.day)} `}${clockAt(move.to.start)}${length}`;
}
