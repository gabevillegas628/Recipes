import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { HabitChart, monthLabel, usd } from '../components/MoneyCharts';
import type { CategoryDetail, OneOffCharge } from '../types';

/**
 * Money → one category, to see what drives it: months of habit against the
 * budget, and for one month how many charges, their average, where they went
 * and on which days. One-offs (a birthday dinner) are set apart so the habit,
 * the part that can change, is what's measured.
 */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayName = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function CategoryPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : undefined;
  const detail = useQuery({
    queryKey: ['money-category', id, month ?? 'now'],
    queryFn: () => api.categoryDetail(id, month),
    placeholderData: (prev) => prev,
  });
  const d = detail.data;
  if (detail.error) return <div className="page money"><p className="error">{detail.error.message}</p></div>;
  if (!d) return <div className="page money" />;

  const s = d.stats;
  const line = d.budget ? { value: d.budget, label: 'Budget' } : d.usual ? { value: d.usual, label: 'Usual' } : null;
  const maxWeekday = Math.max(1, ...s.weekdays.map((w) => w.total));
  const maxMerchant = Math.max(1, ...s.merchants.map((m) => m.total));
  const busiest = s.weekdays.map((w, i) => ({ ...w, day: DAYS[i] })).sort((a, b) => b.total - a.total);
  const weekendish = s.weekdays.slice(3).reduce((n, w) => n + w.total, 0);
  const pick = (m: string) => setParams(m === d.history.at(-1)?.month ? {} : { month: m }, { replace: true });

  return (
    <div className="page money category">
      <Link to={`/money${month ? `?month=${month}` : ''}`} className="back-link">
        ‹ Money
      </Link>
      <h1 className="form-title">{d.category.name}</h1>
      <Worth detail={d} />

      <HabitChart history={d.history} selected={d.month} line={line} onPick={pick} />

      <h2 className="money-section-title">
        {monthLabel(d.month)}
        {d.current ? ' so far' : ''}
      </h2>
      <div className="money-totals">
        <div>
          <span className="muted small">Habit</span>
          <strong>{usd(s.habit)}</strong>
          {d.budget ? <span className="muted small">budget {usd(d.budget)}</span> : d.usual !== null && <span className="muted small">usual {usd(d.usual)}</span>}
        </div>
        <div>
          <span className="muted small">Charges</span>
          <strong>{s.charges}</strong>
          {s.oneOffs > 0 && <span className="muted small">+ {usd(s.oneOffs)} one-offs</span>}
        </div>
        <div>
          <span className="muted small">Average</span>
          <strong>{s.average === null ? '—' : usd(s.average)}</strong>
          <span className="muted small">a charge</span>
        </div>
      </div>
      {s.average !== null && s.charges >= 4 && (
        <p className="muted small">
          Each charge averages {usd(s.average)}, so one fewer a week is about {usd(s.average * 4.33)} a month.
        </p>
      )}

      {s.merchants.length > 0 && (
        <>
          <h3 className="category-subtitle">Where it went</h3>
          <ul className="category-bars">
            {s.merchants.map((m) => (
              <li key={m.name}>
                <span className="category-bar-head">
                  <span>{m.name}</span>
                  <span>
                    {m.charges}× · {usd(m.total)}
                  </span>
                </span>
                <span className="money-cat-track">
                  <span className="money-cat-fill" style={{ width: `${(m.total / maxMerchant) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {s.charges >= 3 && (
        <>
          <h3 className="category-subtitle">Which days</h3>
          {busiest[0].total > 0 && (
            <p className="muted small">
              Most on {busiest[0].day}
              {busiest[1].total > 0 ? ` and ${busiest[1].day}` : ''}. Thursday to Sunday:{' '}
              {Math.round((weekendish / Math.max(1, s.habit)) * 100)}% of it.
            </p>
          )}
          <ul className="category-days">
            {s.weekdays.map((w, i) => (
              <li key={DAYS[i]}>
                <span className="category-day-name">{DAYS[i]}</span>
                <span className="money-cat-track">
                  <span className="money-cat-fill" style={{ width: `${(w.total / maxWeekday) * 100}%` }} />
                </span>
                <span className="category-day-value">{w.total > 0 ? `${usd(w.total)} · ${w.charges}×` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <OneOffs detail={d} />

      <p>
        <Link to={`/money?view=list&month=${d.month}&category=${d.category.id}`}>See every charge in {monthLabel(d.month, 'long')} ›</Link>
      </p>
    </div>
  );
}

/** What keeping to the budget is worth, when the habit runs above it. */
function Worth({ detail: d }: { detail: CategoryDetail }) {
  if (!d.budget || d.usual === null || d.usual <= d.budget + 10) {
    if (d.usual !== null) {
      return (
        <p className="money-verdict">
          Usually {usd(d.usual)} a month{d.budget ? `, against a ${usd(d.budget)} budget` : ''}, one-offs left out.
        </p>
      );
    }
    return null;
  }
  const gap = d.usual - d.budget;
  return (
    <p className="money-verdict">
      Usually {usd(d.usual)} a month. Keeping to the {usd(d.budget)} budget is {usd(gap)} a month, {usd(gap * 12)} a year.
    </p>
  );
}

function OneOffs({ detail: d }: { detail: CategoryDetail }) {
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: ({ id, oneOff }: { id: string; oneOff: boolean | null }) => api.setOneOff(id, oneOff),
    onSuccess: () => {
      for (const key of ['money-category', 'money-overview', 'money-budget']) queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!d.maybeOneOffs.length && !d.oneOffs.length) return null;

  const row = (c: OneOffCharge, actions: React.ReactNode) => (
    <li key={c.id}>
      <span>
        {c.merchant}
        <span className="muted small">{dayName(c.date)}</span>
      </span>
      <span className="budget-bill-end">
        {usd(c.amount)}
        {actions}
      </span>
    </li>
  );

  return (
    <section className="category-oneoffs">
      <h3 className="category-subtitle">One-offs</h3>
      <p className="muted small">
        Special occasions (a birthday dinner, a party) count in what you spent, but not in the habit or its usual month.
      </p>
      {d.maybeOneOffs.length > 0 && (
        <div className="budget-suggested">
          <h3>These look like one-offs</h3>
          <ul className="budget-list">
            {d.maybeOneOffs.map((c) =>
              row(
                c,
                <>
                  <button type="button" className="btn btn-small btn-primary" disabled={set.isPending} onClick={() => set.mutate({ id: c.id, oneOff: true })}>
                    One-off
                  </button>
                  <button type="button" className="btn btn-small" disabled={set.isPending} onClick={() => set.mutate({ id: c.id, oneOff: false })}>
                    Habit
                  </button>
                </>,
              ),
            )}
          </ul>
        </div>
      )}
      {d.oneOffs.length > 0 && (
        <ul className="budget-list">
          {d.oneOffs.map((c) =>
            row(
              c,
              <button type="button" className="btn btn-small" disabled={set.isPending} onClick={() => set.mutate({ id: c.id, oneOff: false })}>
                Not a one-off
              </button>,
            ),
          )}
        </ul>
      )}
      {set.error && <p className="error">{set.error.message}</p>}
    </section>
  );
}
