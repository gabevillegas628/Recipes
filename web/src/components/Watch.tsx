import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { WatchStatus } from '../types';
import { monthLabel, usd } from './MoneyCharts';

/**
 * Watched categories: the Watching card at the top of the Money overview (one
 * line each: what's left this week), and the panel on a category's page to
 * start, change, pause or stop watching it. Going over is shown plainly, not as
 * an alarm: no red, no warning signs.
 */

const dayName = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const weekLabel = (from: string, to: string) => (from === to ? dayName(from) : `${dayName(from)}–${new Date(`${to}T12:00:00`).getDate()}`);

function left(n: number) {
  return n >= 0 ? `${usd(n)} left` : `${usd(n)} over`;
}

/** This week's allowance as a meter: the fill is what's spent, the track what the week has. */
function WeekMeter({ w }: { w: WatchStatus }) {
  const share = w.week.allowance > 0 ? Math.min(1, w.week.spent / w.week.allowance) : w.week.spent > 0 ? 1 : 0;
  return (
    <span className={`watch-meter ${w.week.left < 0 ? 'watch-over' : ''}`} aria-hidden>
      <span style={{ width: `${share * 100}%` }} />
    </span>
  );
}

export function WatchingCard({ watches }: { watches: WatchStatus[] }) {
  if (!watches.length) return null;
  return (
    <section className="watching">
      <h2 className="watching-title">This week</h2>
      <ul>
        {watches.map((w) => (
          <li key={w.categoryId}>
            <Link to={`/money/c/${w.categoryId}`} className="watching-row">
              <span className="watching-head">
                <span>{w.name}</span>
                <strong>
                  {left(w.week.left)}
                </strong>
              </span>
              <WeekMeter w={w} />
              <span className="muted small">
                {usd(w.week.spent)} of {usd(Math.max(0, w.week.allowance))} this week · {usd(w.spent)} of {usd(w.monthAmount)} this month
                {w.months > 1 ? ` · step ${w.step + 1} of ${w.months}` : ''}
                {w.paused ? ' · paused' : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** On a category's page: start watching it, or see and change how it's going. */
export function WatchPanel({
  categoryId,
  watch,
  usual,
  budget,
}: {
  categoryId: string;
  watch: WatchStatus | null;
  usual: number | null;
  budget: number | null;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const refresh = () => {
    for (const key of ['money-category', 'money-overview', 'money-budget']) queryClient.invalidateQueries({ queryKey: [key] });
    setEditing(false);
  };
  const pause = useMutation({ mutationFn: (paused: boolean) => api.pauseWatch(categoryId, paused), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => api.stopWatch(categoryId), onSuccess: refresh });

  if (!watch || editing) {
    return (
      <section className="watch-panel">
        <h2 className="money-section-title">{watch ? 'Change the target' : 'Bring it down'}</h2>
        {!watch && (
          <p className="muted small">
            Set where you want this category to land each month. It comes down a step a month from your usual, with a weekly
            allowance so you see how it’s going mid-month. Unspent money carries into the next week.
          </p>
        )}
        <WatchForm
          categoryId={categoryId}
          initial={watch?.target ?? budget ?? usual ?? null}
          usual={usual}
          months={watch?.months}
          onDone={refresh}
          onCancel={watch ? () => setEditing(false) : undefined}
        />
      </section>
    );
  }

  const w = watch;
  const yearly = Math.max(0, (w.start - w.target) * 12);
  return (
    <section className="watch-panel">
      <h2 className="money-section-title">
        Watching: {usd(w.target)} a month{w.paused ? ' (paused)' : ''}
      </h2>
      {yearly > 0 && (
        <p className="muted small">
          From {usd(w.start)} a month to {usd(w.target)}: {usd(w.start - w.target)} a month, {usd(yearly)} a year.
        </p>
      )}
      {w.months > 1 && (
        <ol className="watch-steps">
          {w.steps.map((s, i) => (
            <li key={s.month} className={i === w.step ? 'on' : i < w.step ? 'done' : ''}>
              <span>{monthLabel(s.month, 'short')}</span>
              <strong>{usd(s.amount)}</strong>
            </li>
          ))}
        </ol>
      )}

      <div className="watch-week">
        <span className="watching-head">
          <span>This week ({weekLabel(w.week.from, w.week.to)})</span>
          <strong>{left(w.week.left)}</strong>
        </span>
        <WeekMeter w={w} />
        <span className="muted small">
          {usd(w.week.spent)} spent of {usd(Math.max(0, w.week.allowance))}, carry-over included · {usd(w.spent)} of {usd(w.monthAmount)}{' '}
          this month
        </span>
      </div>
      {w.weeks.length > 1 && (
        <ul className="watch-weeks">
          {w.weeks.slice(0, -1).map((wk) => (
            <li key={wk.from}>
              <span>{weekLabel(wk.from, wk.to)}</span>
              <span>
                {usd(wk.spent)} of {usd(Math.max(0, wk.allowance))}
              </span>
              <span className="muted">{wk.spent > wk.allowance ? 'over' : '✓'}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-actions">
        <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
          Change target
        </button>
        {w.months > 1 && (
          <button type="button" className="btn btn-small" disabled={pause.isPending} onClick={() => pause.mutate(!w.paused)}>
            {w.paused ? 'Resume stepping down' : 'Pause stepping down'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-small"
          disabled={stop.isPending}
          onClick={() => confirm(`Stop watching ${w.name}? Its budget goes back to its usual month.`) && stop.mutate()}
        >
          Stop watching
        </button>
      </div>
      {(pause.error || stop.error) && <p className="error">{(pause.error ?? stop.error)!.message}</p>}
    </section>
  );
}

function WatchForm({
  categoryId,
  initial,
  usual,
  months: initialMonths,
  onDone,
  onCancel,
}: {
  categoryId: string;
  initial: number | null;
  usual: number | null;
  months?: number;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial ? String(Math.round(initial)) : '');
  const [pace, setPace] = useState(initialMonths ? String(initialMonths) : 'suggested');
  const target = Number(text.replace(/[$,\s]/g, ''));
  const valid = text.trim() !== '' && Number.isFinite(target) && target >= 0;
  // The same pace the server suggests: about a tenth a month, at most six steps.
  const suggested = usual && valid && target < usual ? Math.min(6, Math.max(1, Math.ceil((usual - target) / (usual * 0.12)))) : 1;
  const save = useMutation({
    mutationFn: () => api.setWatch(categoryId, target, pace === 'suggested' ? undefined : Number(pace)),
    onSuccess: onDone,
  });

  return (
    <form
      className="form watch-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <div className="field-row">
        <label className="field">
          <span>A month</span>
          <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="$0" />
        </label>
        <label className="field">
          <span>Get there</span>
          <select value={pace} onChange={(e) => setPace(e.target.value)}>
            <option value="suggested">
              {suggested > 1 ? `Over ${suggested} months (suggested)` : 'Right away (suggested)'}
            </option>
            <option value="1">Right away</option>
            {[2, 3, 4, 6].map((n) => (
              <option key={n} value={n}>
                Over {n} months
              </option>
            ))}
          </select>
        </label>
      </div>
      {usual !== null && valid && (
        <p className="muted small">
          {target >= usual
            ? `That’s at or above your usual ${usd(usual)}, so it starts there right away.`
            : `From your usual ${usd(usual)}: ${usd(Math.round(usual) - target)} a month less, ${usd((Math.round(usual) - target) * 12)} a year.`}
        </p>
      )}
      {save.error && <p className="error">{save.error.message}</p>}
      <div className="settings-actions">
        <button className="btn btn-primary" disabled={!valid || save.isPending}>
          {onCancel ? 'Save' : 'Start watching'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
