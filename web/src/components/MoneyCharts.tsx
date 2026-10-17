import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { MoneyOverview } from '../types';

/**
 * The Money overview's charts, drawn as plain SVG: spending through the month
 * against a typical month, and money in vs. out by month. Colors come from CSS
 * tokens (--series-in, --series-out), validated for both themes.
 */

export const usd = (n: number, cents = false) =>
  Math.abs(n).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });

/** $12.4k style, for axis ticks and end labels. */
const compact = (n: number) =>
  Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(Math.abs(n) >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : `$${Math.round(n)}`;

export const monthLabel = (month: string, style: 'short' | 'long' = 'long') =>
  new Date(`${month}-15T12:00:00`).toLocaleDateString(undefined, { month: style, ...(style === 'long' ? { year: 'numeric' } : {}) });

/** Clean axis ticks from 0 to at least max. */
function ticks(max: number, count = 3) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// ---------- Spending through the month ----------

const PACE_H = 170;
const PAD = { top: 10, right: 58, bottom: 22, left: 40 };

/** What spending is measured against: a usual month, or this month's budget spread the way a usual month goes. */
export interface PaceReference {
  values: number[];
  /** Short, at the line's end: "Usual", "Budget". */
  label: string;
  /** In the legend and the readout. */
  legend: string;
}

/** Spending added up day by day, this month against a reference line. Touch or hover to read a day. */
export function PaceChart({ data, reference }: { data: MoneyOverview; reference: PaceReference | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { actual } = data.pace;
  const typical = reference?.values ?? null;
  const days = data.daysInMonth;
  const last = actual.length - 1;
  const i = hover ?? last;

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = PACE_H - PAD.top - PAD.bottom;
  const yTicks = ticks(Math.max(...actual, ...(typical ?? []), 1));
  const yMax = yTicks[yTicks.length - 1];
  const x = (d: number) => PAD.left + (days > 1 ? (d / (days - 1)) * plotW : 0);
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const path = (values: number[]) => values.map((v, d) => `${d ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join('');

  function move(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const d = Math.round(((e.clientX - box.left) / box.width) * (days - 1));
    setHover(Math.max(0, Math.min(last, d)));
  }

  const dayName = new Date(`${data.month}-${String(i + 1).padStart(2, '0')}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  // End labels sit at the right edge; nudge apart when the lines end close together.
  const endTypical = typical ? y(typical[typical.length - 1]) : null;
  let endActual = y(actual[last] ?? 0);
  const sameEdge = !data.current || last >= days - 5;
  const labelsClose = endTypical !== null && sameEdge && Math.abs(endTypical - endActual) < 14;

  return (
    <div className="chart">
      <p className="chart-readout">
        <strong>{dayName}</strong> · spent {usd(actual[i] ?? 0)}
        {typical && (
          <>
            {' '}
            · {reference!.label.toLowerCase()} by then {usd(typical[i])}
          </>
        )}
      </p>
      <div ref={ref} className="chart-frame" style={{ height: PACE_H }}>
        {width > 0 && (
          <svg width={width} height={PACE_H} role="img" aria-label="Spending through the month compared with a typical month">
            {yTicks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} />
                <text className="chart-tick" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {[1, 8, 15, 22, days].map((d) => (
              <text key={d} className="chart-tick" x={x(d - 1)} y={PACE_H - 6} textAnchor="middle">
                {d}
              </text>
            ))}
            {typical && <path className="chart-line chart-line-typical" d={path(typical)} />}
            <path className="chart-line chart-line-out" d={path(actual)} />
            {hover !== null && <line className="chart-crosshair" x1={x(i)} x2={x(i)} y1={PAD.top} y2={PAD.top + plotH} />}
            {typical && hover !== null && <circle className="chart-dot chart-dot-typical" cx={x(i)} cy={y(typical[i])} r={4} />}
            {actual.length > 0 && <circle className="chart-dot chart-dot-out" cx={x(i)} cy={y(actual[i])} r={4} />}
            {typical && endTypical !== null && (
              <text className="chart-end" x={x(days - 1) + 8} y={(labelsClose ? endTypical - 7 : endTypical) + 4}>
                {reference!.label}
              </text>
            )}
            <text className="chart-end" x={(data.current ? x(last) : x(days - 1)) + 8} y={(labelsClose ? (endActual += 7) : endActual) + 4}>
              {data.current ? 'Now' : 'Spent'}
            </text>
            <rect
              className="chart-hit"
              x={PAD.left}
              y={0}
              width={plotW}
              height={PACE_H}
              onPointerMove={move}
              onPointerDown={move}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}
      </div>
      <div className="chart-legend">
        <span>
          <i className="key key-line key-out" /> {data.current ? 'This month so far' : monthLabel(data.month, 'short')}
        </span>
        {typical && (
          <span>
            <i className="key key-line key-typical" /> {reference!.legend}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------- Money in vs. out by month ----------

const MONTHS_H = 180;
const MPAD = { top: 10, right: 4, bottom: 22, left: 40 };

/** In and spent by month; tap a month to look at it. Months missing some accounts are faded. */
export function InOutChart({ data, onPick }: { data: MoneyOverview; onPick: (month: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const months = data.history;
  const plotW = Math.max(0, width - MPAD.left - MPAD.right);
  const plotH = MONTHS_H - MPAD.top - MPAD.bottom;
  const yTicks = ticks(Math.max(...months.flatMap((m) => [m.income, m.spending]), 1));
  const yMax = yTicks[yTicks.length - 1];
  const band = months.length ? plotW / months.length : 0;
  const barW = Math.max(3, Math.min(24, (band - 8) / 2));
  const y = (v: number) => MPAD.top + plotH - (Math.max(0, v) / yMax) * plotH;

  /** A column with a 4px rounded top, square at the baseline. */
  const column = (x0: number, value: number) => {
    const top = y(value);
    const base = MPAD.top + plotH;
    const r = Math.min(4, barW / 2, base - top);
    if (base - top < 0.5) return '';
    return `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barW - r}Q${x0 + barW},${top} ${x0 + barW},${top + r}V${base}Z`;
  };
  const anyPartial = months.some((m) => m.partial);

  return (
    <div className="chart">
      <div ref={ref} className="chart-frame" style={{ height: MONTHS_H }}>
        {width > 0 && (
          <svg width={width} height={MONTHS_H} role="img" aria-label="Money in and spent by month">
            {yTicks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={MPAD.left} x2={MPAD.left + plotW} y1={y(t)} y2={y(t)} />
                <text className="chart-tick" x={MPAD.left - 6} y={y(t) + 4} textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {months.map((m, i) => {
              const x0 = MPAD.left + i * band + (band - (barW * 2 + 2)) / 2;
              const selected = m.month === data.month;
              return (
                <g key={m.month} className={`chart-month ${m.partial ? 'partial' : ''} ${selected ? 'selected' : ''}`}>
                  {selected && <rect className="chart-selected" x={MPAD.left + i * band + 1} y={MPAD.top} width={band - 2} height={plotH} rx={4} />}
                  <path className="chart-bar chart-bar-in" d={column(x0, m.income)} />
                  <path className="chart-bar chart-bar-out" d={column(x0 + barW + 2, m.spending)} />
                  <text className={`chart-tick ${selected ? 'chart-tick-on' : ''}`} x={MPAD.left + i * band + band / 2} y={MONTHS_H - 6} textAnchor="middle">
                    {monthLabel(m.month, 'short').slice(0, band < 26 ? 1 : 3)}
                  </text>
                  <rect
                    className="chart-hit"
                    x={MPAD.left + i * band}
                    y={0}
                    width={band}
                    height={MONTHS_H}
                    onClick={() => onPick(m.month)}
                  >
                    <title>
                      {`${monthLabel(m.month)}: in ${usd(m.income)}, spent ${usd(m.spending)}${m.partial ? ' (missing some accounts)' : ''}`}
                    </title>
                  </rect>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <div className="chart-legend">
        <span>
          <i className="key key-in" /> In
        </span>
        <span>
          <i className="key key-out" /> Spent
        </span>
        {anyPartial && <span className="muted">Faded: missing some accounts</span>}
      </div>
      <details className="chart-table">
        <summary>Numbers by month</summary>
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th>In</th>
              <th>Spent</th>
              <th>Left over</th>
            </tr>
          </thead>
          <tbody>
            {[...months].reverse().map((m) => (
              <tr key={m.month} className={m.partial ? 'muted' : ''}>
                <td>
                  {monthLabel(m.month, 'short')} {m.month.slice(2, 4)}
                  {m.partial ? '*' : m.current ? ' (so far)' : ''}
                </td>
                <td>{usd(m.income)}</td>
                <td>{usd(m.spending)}</td>
                <td>
                  {m.income - m.spending < 0 ? '−' : ''}
                  {usd(m.income - m.spending)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {anyPartial && <p className="muted small">* Missing some accounts, so not counted in averages.</p>}
      </details>
    </div>
  );
}

// ---------- One category: habit and one-offs by month ----------

const HABIT_H = 170;
const HPAD = { top: 12, right: 4, bottom: 22, left: 40 };

/**
 * A category's months: the habit as the column, one-offs stacked on top in
 * gray, and the budget (or usual month) as a line. Tap a month to look at it.
 */
export function HabitChart({
  history,
  selected,
  line,
  onPick,
}: {
  history: { month: string; habit: number; oneOffs: number; partial: boolean }[];
  selected: string;
  line: { value: number; label: string } | null;
  onPick: (month: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const plotW = Math.max(0, width - HPAD.left - HPAD.right);
  const plotH = HABIT_H - HPAD.top - HPAD.bottom;
  const yTicks = ticks(Math.max(...history.map((m) => Math.max(0, m.habit) + m.oneOffs), line?.value ?? 0, 1));
  const yMax = yTicks[yTicks.length - 1];
  const band = history.length ? plotW / history.length : 0;
  const barW = Math.max(4, Math.min(24, band - 8));
  const y = (v: number) => HPAD.top + plotH - (Math.max(0, v) / yMax) * plotH;

  /** A column segment from `from` to `to`, rounded on top when it's the top of the stack. */
  const segment = (x0: number, from: number, to: number, roundTop: boolean) => {
    const top = y(to);
    const bottom = y(from);
    if (bottom - top < 0.5) return '';
    const r = roundTop ? Math.min(4, barW / 2, bottom - top) : 0;
    return `M${x0},${bottom}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barW - r}Q${x0 + barW},${top} ${x0 + barW},${top + r}V${bottom}Z`;
  };
  const anyOneOffs = history.some((m) => m.oneOffs > 0);

  return (
    <div className="chart">
      <div ref={ref} className="chart-frame" style={{ height: HABIT_H }}>
        {width > 0 && (
          <svg width={width} height={HABIT_H} role="img" aria-label="Spending in this category by month">
            {yTicks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={HPAD.left} x2={HPAD.left + plotW} y1={y(t)} y2={y(t)} />
                <text className="chart-tick" x={HPAD.left - 6} y={y(t) + 4} textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {history.map((m, i) => {
              const x0 = HPAD.left + i * band + (band - barW) / 2;
              const habit = Math.max(0, m.habit);
              const isSelected = m.month === selected;
              return (
                <g key={m.month} className={`chart-month ${m.partial ? 'partial' : ''}`}>
                  {isSelected && <rect className="chart-selected" x={HPAD.left + i * band + 1} y={HPAD.top} width={band - 2} height={plotH} rx={4} />}
                  <path className="chart-bar chart-bar-out" d={segment(x0, 0, habit, m.oneOffs <= 0)} />
                  {m.oneOffs > 0 && (
                    // A 2px surface gap between the habit and the one-offs above it.
                    <path className="chart-bar chart-bar-oneoff" d={segment(x0, habit + (2 * yMax) / plotH, habit + m.oneOffs, true)} />
                  )}
                  <text className={`chart-tick ${isSelected ? 'chart-tick-on' : ''}`} x={HPAD.left + i * band + band / 2} y={HABIT_H - 6} textAnchor="middle">
                    {monthLabel(m.month, 'short').slice(0, band < 26 ? 1 : 3)}
                  </text>
                  <rect className="chart-hit" x={HPAD.left + i * band} y={0} width={band} height={HABIT_H} onClick={() => onPick(m.month)}>
                    <title>{`${monthLabel(m.month)}: ${usd(m.habit)} habit${m.oneOffs ? `, ${usd(m.oneOffs)} one-offs` : ''}`}</title>
                  </rect>
                </g>
              );
            })}
            {line && line.value > 0 && (
              <g>
                <line className="chart-target" x1={HPAD.left} x2={HPAD.left + plotW} y1={y(line.value)} y2={y(line.value)} />
                {/* At the left, clear of the recent months people look at. */}
                <text className="chart-target-label" x={HPAD.left + 4} y={y(line.value) - 5} textAnchor="start">
                  {line.label} {compact(line.value)}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>
      <div className="chart-legend">
        <span>
          <i className="key key-out" /> Habit
        </span>
        {anyOneOffs && (
          <span>
            <i className="key key-oneoff" /> One-offs
          </span>
        )}
        {line && line.value > 0 && (
          <span>
            <i className="key key-line key-target" /> {line.label}
          </span>
        )}
        {history.some((m) => m.partial) && <span className="muted">Faded: missing some accounts</span>}
      </div>
    </div>
  );
}
