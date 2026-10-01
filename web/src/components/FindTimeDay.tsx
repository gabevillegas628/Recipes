import type { CSSProperties } from 'react';
import type { FindTimeDayView, FindTimeResult } from '../types';

/**
 * A find-a-time option's day at a glance: a lane per person with their busy
 * time (and school, for kids), the trip drawn across them (travel, the visit,
 * travel back), and below, that day's events in order with the new one slotted in.
 * Spans only: it sits inside the option's button.
 */
export function FindTimeDay({
  view,
  title,
  who,
  people,
}: {
  view: FindTimeDayView;
  title: string;
  /** Who has to be there (ids). */
  who: string[];
  people: FindTimeResult['people'];
}) {
  const span = view.to - view.from;
  const hours = span / 60;
  const at = (m: number) => `${(Math.min(Math.max(m - view.from, 0), span) / span) * 100}%`;
  const box = (start: number, end: number): CSSProperties => ({ left: at(start), right: `calc(100% - ${at(end)})` });
  const visible = (e: { start: number; end: number }) => e.end > view.from && e.start < view.to;
  const step = hours <= 6 ? 1 : hours <= 12 ? 2 : 3;
  const ticks: number[] = [];
  for (let m = view.from; m <= view.to; m += step * 60) ticks.push(m);

  const t = view.trip;
  const windowEnd = t.lastStart + (t.visitEnd - t.visitStart);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? '?';

  // The day in order, with the new appointment slotted in.
  type Row = { start: number; end: number; title: string; who: string; mine?: boolean };
  const rows: Row[] = view.events.map((e) => ({
    start: e.start,
    end: e.end,
    title: e.title,
    who: e.everyone ? 'Everyone' : e.people.map(nameOf).join(', '),
  }));
  rows.push({ start: t.visitStart, end: t.visitEnd, title, who: who.map(nameOf).join(', '), mine: true });
  rows.sort((a, b) => a.start - b.start || (a.mine ? 1 : 0) - (b.mine ? 1 : 0));

  return (
    <span className="day-view">
      {view.allDay.length > 0 && <span className="day-allday">All day: {view.allDay.join(' · ')}</span>}

      <span className="day-lanes" style={{ '--hours': hours } as CSSProperties}>
        {people.map((p, i) => (
          <span key={p.id} className="day-lane">
            <span className={`day-name ${who.includes(p.id) ? 'on' : ''}`} style={{ gridRow: i + 1 }}>
              {p.name}
            </span>
            <span className="day-track" style={{ gridRow: i + 1 }}>
              {view.school && !p.adult && visible(view.school) && (
                <span className="day-school" style={box(view.school.start, view.school.end)} title="School" />
              )}
              {view.events
                .filter((e) => visible(e) && (e.everyone || e.people.includes(p.id)))
                .map((e) => (
                  <span key={`${e.title}-${e.start}`} className="day-busy" style={box(e.start, e.end)} title={e.title} />
                ))}
            </span>
          </span>
        ))}
        <span className="day-trip" aria-hidden="true" style={{ gridRow: `1 / ${people.length + 1}` }}>
          {windowEnd > t.visitEnd && <span className="day-window" style={box(t.visitStart, windowEnd)} />}
          {t.start < t.visitStart && <span className="day-travel" style={box(t.start, t.visitStart)} />}
          <span className="day-visit" style={box(t.visitStart, t.visitEnd)} />
          {t.end > t.visitEnd && <span className="day-travel" style={box(t.visitEnd, t.end)} />}
        </span>
        <span className="day-axis" aria-hidden="true" style={{ gridRow: people.length + 1 }}>
          {ticks.map((m) => (
            <span key={m} style={{ left: at(m) }}>
              {hourLabel(m)}
            </span>
          ))}
        </span>
      </span>

      <span className="day-list">
        {rows.map((r) => (
          <span key={`${r.title}-${r.start}-${r.mine ? 'new' : ''}`} className={`day-row ${r.mine ? 'mine' : ''}`}>
            <span className="day-time">{range(r.start, r.end)}</span>
            <span className="day-what">
              {r.title}
              {r.who && <span className="day-who"> · {r.who}</span>}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

function hourLabel(m: number) {
  const h = Math.floor(m / 60) % 24;
  return `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
}

function clock(m: number, meridiem = true) {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${((h + 11) % 12) + 1}${min ? `:${String(min).padStart(2, '0')}` : ''}${meridiem ? (h < 12 ? ' AM' : ' PM') : ''}`;
}

/** "9–10:30 AM", "11:30 AM–1 PM". */
function range(start: number, end: number) {
  const sameHalf = end < 24 * 60 && Math.floor(start / 720) === Math.floor(end / 720);
  return `${clock(start, !sameHalf)}–${clock(end)}`;
}
