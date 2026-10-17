import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { InOutChart, monthLabel, PaceChart, type PaceReference } from '../components/MoneyCharts';
import { WatchingCard } from '../components/Watch';
import type { FinanceCategory, MoneyKind, MoneyRecap, MoneyTransaction, ReviewGroup } from '../types';

/**
 * The Money tab: a month of transactions with in / spent / saved totals, and
 * the needs-a-look list of transactions sorting couldn't settle. Tapping one
 * sorts it: for every charge from that merchant, or just this one.
 */

const KIND_LABELS: Record<MoneyKind, string> = {
  SPENDING: 'Spending',
  INCOME: 'Income',
  SAVING: 'Saving',
  TRANSFER: 'Transfer',
};
const KIND_HELP: Record<MoneyKind, string> = {
  SPENDING: 'A purchase or bill. Money coming back (a refund, someone paying us back) lowers that category.',
  INCOME: 'Pay, interest, other money earned.',
  SAVING: 'Into savings or investments. Money coming back out counts against saving.',
  TRANSFER: 'Between our own accounts, like paying a card. Not counted.',
};

const usd = (n: number, cents = true) =>
  Math.abs(n).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const monthName = (month: string) =>
  new Date(`${month}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const dayName = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

type View = 'overview' | 'list' | 'review';

export function MoneyPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get('view');
  const view: View = raw === 'review' || raw === 'list' ? raw : 'overview';
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : thisMonth();
  const status = useQuery({ queryKey: ['money'], queryFn: api.moneyStatus });
  const categories = useQuery({ queryKey: ['money-categories'], queryFn: api.moneyCategories });
  const review = useQuery({ queryKey: ['money-review'], queryFn: api.moneyReview });
  const lookCount = review.data?.reduce((n, g) => n + g.count, 0) ?? 0;

  /** Keeps view, month and category in the URL, so Back and reloads land where you were. */
  const go = (next: { view?: View; month?: string; category?: string | null }) => {
    const v = next.view ?? view;
    const m = next.month ?? month;
    const out: Record<string, string> = {};
    if (v !== 'overview') out.view = v;
    if (m !== thisMonth()) out.month = m;
    const category = next.category === undefined ? params.get('category') : next.category;
    if (v === 'list' && category) out.category = category;
    // Opening a category from the overview is a step you can go Back from.
    setParams(out, { replace: !next.category });
  };

  if (status.data && !status.data.connected && !status.data.accounts.length) {
    return (
      <div className="page money">
        <h1 className="form-title">Money</h1>
        <p>
          Connect your bank and card accounts in <Link to="/settings/money">Settings → Money</Link> to see where the
          money goes.
        </p>
      </div>
    );
  }

  return (
    <div className="page money">
      <div className="money-header">
        <h1 className="form-title">Money</h1>
        <span className="money-header-links">
          <Link to="/money/budget" className="btn btn-small">
            Budget
          </Link>
          <Link to="/settings/money" className="btn btn-small">
            Accounts
          </Link>
        </span>
      </div>
      <div className="segmented">
        <button type="button" className={view === 'overview' ? 'on' : ''} onClick={() => go({ view: 'overview', category: null })}>
          Overview
        </button>
        <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => go({ view: 'list', category: null })}>
          Transactions
        </button>
        <button type="button" className={view === 'review' ? 'on' : ''} onClick={() => go({ view: 'review', category: null })}>
          Review{lookCount ? ` (${lookCount})` : ''}
        </button>
      </div>
      {view !== 'review' && (
        <div className="money-month">
          <button type="button" className="btn btn-small" onClick={() => go({ month: shiftMonth(month, -1) })} aria-label="Previous month">
            ‹
          </button>
          <strong>{monthName(month)}</strong>
          <button
            type="button"
            className="btn btn-small"
            disabled={month >= thisMonth()}
            onClick={() => go({ month: shiftMonth(month, 1) })}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      )}
      {view === 'overview' && (
        <Overview month={month} onMonth={(m) => go({ month: m })} onCategory={(id) => navigate(`/money/c/${id}${month !== thisMonth() ? `?month=${month}` : ''}`)} />
      )}
      {view === 'list' && (
        <Transactions
          key={params.get('category') ?? ''}
          month={month}
          initialCategory={params.get('category') ?? ''}
          categories={categories.data ?? []}
        />
      )}
      {view === 'review' && <Review groups={review.data} categories={categories.data ?? []} />}
    </div>
  );
}

// ---------- Overview ----------

function Overview({
  month,
  onMonth,
  onCategory,
}: {
  month: string;
  onMonth: (month: string) => void;
  onCategory: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ['money-overview', month],
    queryFn: () => api.moneyOverview(month),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  if (q.error) return <p className="error">{q.error.message}</p>;
  if (!d) return null;

  const spentNow = d.pace.actual[d.pace.actual.length - 1] ?? 0;
  const b = d.budget;
  // This month's budget, spread over the month the way a usual month goes (rent early, groceries all along).
  const budgetPace =
    b && b.totals.budget > 0
      ? d.pace.typical && d.pace.typical[d.pace.typical.length - 1] > 0
        ? d.pace.typical.map((v) => (v / d.pace.typical![d.pace.typical!.length - 1]) * b.totals.budget)
        : Array.from({ length: d.daysInMonth }, (_, i) => ((i + 1) / d.daysInMonth) * b.totals.budget)
      : null;
  const reference: PaceReference | null = budgetPace
    ? { values: budgetPace, label: 'Budget', legend: 'This month’s budget' }
    : d.pace.typical
      ? {
          values: d.pace.typical,
          label: 'Usual',
          legend: `Usual (${d.typical!.months.map((m) => monthLabel(m, 'short')).join(', ')})`,
        }
      : null;
  const usualNow = reference?.values[d.day - 1] ?? null;
  const budgetOf = new Map(b?.categories.map((c) => [c.id, c.budget]) ?? []);
  /** What a category is measured against: its budget this month, its usual otherwise. */
  const markOf = (c: { id: string; typical: number | null }) => (b ? (budgetOf.get(c.id) ?? 0) : c.typical);
  const dayWord = new Date(`${d.month}-${String(d.day).padStart(2, '0')}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const leftOver = d.totals.income - d.totals.spending;
  const typicalLeftOver = d.typical ? d.typical.income - d.typical.spending : null;
  const scale = Math.max(1, ...d.categories.map((c) => Math.max(c.spent, markOf(c) ?? 0)));
  const span = d.typical ? `${monthLabel(d.typical.months[0], 'short')}–${monthLabel(d.typical.months.at(-1)!, 'short')}` : '';
  const groups = [
    { title: 'Fixed costs', rows: d.categories.filter((c) => c.fixed) },
    { title: 'Everyday spending', rows: d.categories.filter((c) => !c.fixed) },
  ];

  const partial = d.history.find((h) => h.month === d.month)?.partial ?? true;

  return (
    <div className="money-overview">
      {d.current && <WatchingCard watches={d.watches} />}
      {(d.recap || (!d.current && !partial)) && <RecapCard month={d.month} recap={d.recap} />}
      <section className="money-hero">
        <span className="muted small">{d.current ? 'Spent so far' : 'Spent'}</span>
        <div className="money-hero-value">{usd(d.totals.spending, false)}</div>
        {b && b.totals.budget > 0 && (
          <p className="money-verdict">
            {d.totals.spending <= b.totals.budget
              ? `${usd(b.totals.budget - d.totals.spending, false)} left of this month’s ${usd(b.totals.budget, false)} budget.`
              : `${usd(d.totals.spending - b.totals.budget, false)} over this month’s ${usd(b.totals.budget, false)} budget.`}
          </p>
        )}
        <p className={b ? 'muted' : 'money-verdict'}>
          {usualNow === null
            ? 'Comparisons start once a full month of every account is in.'
            : b
              ? pace(spentNow - usualNow, usualNow, dayWord)
              : verdict(spentNow - usualNow, usualNow, d.current ? `by ${dayWord}` : 'for a whole month')}
        </p>
      </section>
      {d.pace.actual.length > 0 && <PaceChart data={d} reference={reference} />}

      <div className="money-totals">
        <Tile label="In" value={d.totals.income} usual={b ? b.income.expected : d.typical?.income} word={b ? 'expected' : 'usual'} />
        <Tile label="Saved" value={d.totals.saving} usual={b ? b.saving : d.typical?.saving} word={b ? 'goal' : 'usual'} signed />
        <Tile label={d.current ? 'Left so far' : 'Left over'} value={leftOver} usual={b ? undefined : (typicalLeftOver ?? undefined)} signed />
      </div>
      {b && b.totals.unplanned < 0 && (
        <p className="money-plan-warning">
          <span aria-hidden>▲ </span>
          This month’s plan spends {usd(-b.totals.unplanned, false)} more than comes in.{' '}
          <Link to="/money/budget">Look at the budget</Link>
        </p>
      )}

      <h2 className="money-section-title">Where it went</h2>
      {(b || d.typical) && (
        <p className="muted small">
          <i className="key key-tick" /> marks {b ? 'this month’s budget' : `a usual month (${span})`}; gray is one-offs. Tap a category to
          see what drives it.
        </p>
      )}
      {groups.map(({ title, rows }) =>
        rows.length ? (
          <section key={title} className="money-cats">
            <h3>
              {title}
              <span>{usd(rows.reduce((n, c) => n + c.spent, 0), false)}</span>
            </h3>
            <ul>
              {rows.map((c) => {
                // The habit is what's measured; one-offs are shown on top of it, in gray.
                const habit = c.spent - c.oneOffs;
                const budget = budgetOf.get(c.id) ?? 0;
                const oneOffNote = c.oneOffs > 0 ? ` · + ${usd(c.oneOffs, false)} one-off` : '';
                return (
                  <li key={c.id}>
                    <button type="button" className="money-cat" onClick={() => onCategory(c.id)}>
                      <span className="money-cat-head">
                        <span>{c.name}</span>
                        <span>{c.spent < 0 ? `+${usd(c.spent, false)}` : usd(c.spent, false)}</span>
                      </span>
                      <span className="money-cat-track">
                        <span className="money-cat-fill" style={{ width: `${(Math.max(0, habit) / scale) * 100}%` }} />
                        {c.oneOffs > 0 && <span className="money-cat-oneoff" style={{ width: `${(c.oneOffs / scale) * 100}%` }} />}
                        {(markOf(c) ?? 0) > 0 && (
                          <span className="money-cat-usual" style={{ left: `${((markOf(c) ?? 0) / scale) * 100}%` }} />
                        )}
                      </span>
                      {b ? (
                        <span className="muted small">
                          {budget > 0
                            ? habit <= budget
                              ? `${usd(budget - habit, false)} left of ${usd(budget, false)}`
                              : `${usd(habit - budget, false)} over its ${usd(budget, false)} budget`
                            : 'no budget'}
                          {oneOffNote}
                        </span>
                      ) : (
                        <span className="muted small">
                          {c.typical !== null ? `usual ${usd(c.typical, false)}` : ''}
                          {oneOffNote}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null,
      )}

      <h2 className="money-section-title">Month by month</h2>
      {d.typical && typicalLeftOver !== null && (
        <p className="money-verdict">
          {span}: {usd(d.typical.income, false)} a month in, {usd(d.typical.spending, false)} spent.{' '}
          {Math.abs(typicalLeftOver) < 50
            ? 'About even.'
            : typicalLeftOver > 0
              ? `${usd(typicalLeftOver, false)} a month left over.`
              : `${usd(typicalLeftOver, false)} a month more went out than came in.`}
        </p>
      )}
      <p className="muted small">Tap a month to look at it.</p>
      <InOutChart data={d} onPick={onMonth} />
    </div>
  );
}

function pace(diff: number, planned: number, day: string) {
  if (Math.abs(diff) < Math.max(50, planned * 0.05)) return `On pace for ${day}.`;
  return `${usd(diff, false)} ${diff > 0 ? 'more' : 'less'} than the budget plans for by ${day}.`;
}

/** Claude's look back at a finished month, or a button to write one. */
function RecapCard({ month, recap }: { month: string; recap: MoneyRecap | null }) {
  const queryClient = useQueryClient();
  const write = useMutation({
    mutationFn: () => api.writeRecap(recap?.month ?? month),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['money-overview'] }),
  });
  const about = monthLabel(recap?.month ?? month, 'long').replace(/ \d{4}$/, '');

  if (!recap) {
    return (
      <section className="money-recap money-recap-empty">
        <button type="button" className="btn btn-small" disabled={write.isPending} onClick={() => write.mutate()}>
          {write.isPending ? 'Writing…' : `Write a recap of ${about}`}
        </button>
        {write.error && <p className="error">{write.error.message}</p>}
      </section>
    );
  }
  return (
    <section className="money-recap">
      <span className="money-recap-eyebrow">{about} in short</span>
      <p className="money-recap-headline">{recap.headline}</p>
      <ul>
        {recap.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <div className="money-recap-foot">
        <span className="muted small">Written by Claude from your numbers</span>
        <button type="button" className="btn btn-small" disabled={write.isPending} onClick={() => write.mutate()}>
          {write.isPending ? 'Rewriting…' : 'Rewrite'}
        </button>
      </div>
      {write.error && <p className="error">{write.error.message}</p>}
    </section>
  );
}

function verdict(diff: number, usual: number, when: string) {
  if (Math.abs(diff) < Math.max(50, usual * 0.05)) return `About usual ${when}.`;
  return `${usd(diff, false)} ${diff > 0 ? 'more' : 'less'} than usual ${when}.`;
}

function Tile({
  label,
  value,
  usual,
  word = 'usual',
  signed,
}: {
  label: string;
  value: number;
  usual?: number;
  word?: string;
  signed?: boolean;
}) {
  const show = (n: number) => `${signed && n < 0 ? '−' : ''}${usd(n, false)}`;
  return (
    <div>
      <span className="muted small">{label}</span>
      <strong>{show(value)}</strong>
      {usual !== undefined && (
        <span className="muted small">
          {word} {show(usual)}
        </span>
      )}
    </div>
  );
}

// ---------- Transactions ----------

type KindFilter = MoneyKind | '';

function Transactions({
  month,
  initialCategory,
  categories,
}: {
  month: string;
  initialCategory: string;
  categories: FinanceCategory[];
}) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<KindFilter>('');
  const [categoryId, setCategoryId] = useState(initialCategory);
  const [open, setOpen] = useState<string | null>(null);
  const search = q.trim().length >= 2 ? q.trim() : '';

  const data = useQuery({
    queryKey: ['money-txns', { month, search, kind, categoryId }],
    queryFn: () => api.moneyTransactions({ month, q: search, kind: kind || undefined, categoryId }),
    placeholderData: (prev) => prev,
  });
  const d = data.data;

  const byDay = new Map<string, MoneyTransaction[]>();
  for (const t of d?.transactions ?? []) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);

  return (
    <>
      {!search && d && (
        <div className="money-totals">
          <div>
            <span className="muted small">In</span>
            <strong>{usd(d.totals.income, false)}</strong>
          </div>
          <div>
            <span className="muted small">Spent</span>
            <strong>{usd(d.totals.spending, false)}</strong>
          </div>
          <div>
            <span className="muted small">Saved</span>
            <strong>
              {d.totals.saving < 0 && '−'}
              {usd(d.totals.saving, false)}
            </strong>
          </div>
        </div>
      )}

      <div className="money-filters">
        <input type="search" placeholder="Search all months" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} aria-label="Kind">
          <option value="">Everything</option>
          {(Object.keys(KIND_LABELS) as MoneyKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {data.error && <p className="error">{data.error.message}</p>}
      {d && !d.transactions.length && <p className="muted">Nothing here.</p>}
      {[...byDay.entries()].map(([date, txns]) => (
        <section key={date} className="money-day">
          <h2 className="money-day-title">{dayName(date)}</h2>
          <ul className="money-list">
            {txns.map((t) => (
              <li key={t.id}>
                <button type="button" className="money-row" onClick={() => setOpen(open === t.id ? null : t.id)}>
                  <span className="money-row-main">
                    <span className="money-row-merchant">{t.merchant}</span>
                    <span className="muted small">
                      {t.kind === 'SPENDING' ? (t.category ?? 'No category') : t.kind ? KIND_LABELS[t.kind] : 'Not sorted'}
                      {' · '}
                      {t.account}
                      {t.pending && ' · pending'}
                    </span>
                  </span>
                  <span className={`money-amount ${t.kind === 'TRANSFER' ? 'muted' : t.amount > 0 ? 'money-in' : ''}`}>
                    {t.amount > 0 ? '+' : ''}
                    {usd(t.amount)}
                    {t.needsLook && <span className="money-look" title="Needs a look" />}
                  </span>
                </button>
                {open === t.id && <TransactionEditor txn={t} categories={categories} onDone={() => setOpen(null)} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['money-txns', 'money-review', 'money-categories', 'money-overview', 'money-budget']) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

function TransactionEditor({ txn, categories, onDone }: { txn: MoneyTransaction; categories: FinanceCategory[]; onDone: () => void }) {
  const refresh = useRefresh();
  const [scope, setScope] = useState<'merchant' | 'one'>(txn.merchantKey && !txn.paired ? 'merchant' : 'one');
  const save = useMutation({
    mutationFn: ({ kind, categoryId }: { kind: MoneyKind; categoryId: string | null }) =>
      scope === 'merchant' && txn.merchantKey
        ? api.setMerchant([txn.merchantKey], kind, categoryId)
        : api.setTransaction(txn.id, kind, categoryId),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const reset = useMutation({
    mutationFn: () => api.setTransaction(txn.id, null, null),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });

  return (
    <div className="money-editor">
      <p className="muted small">
        {txn.description} · {txn.institution} {txn.account}
        {txn.paired && ' · matched with the same amount on another of your accounts'}
      </p>
      {txn.merchantKey && (
        <div className="segmented">
          <button type="button" className={scope === 'merchant' ? 'on' : ''} onClick={() => setScope('merchant')}>
            All from {txn.merchant}
          </button>
          <button type="button" className={scope === 'one' ? 'on' : ''} onClick={() => setScope('one')}>
            Just this one
          </button>
        </div>
      )}
      <SortPicker
        kind={txn.kind}
        categoryId={txn.categoryId}
        categories={categories}
        incoming={txn.amount > 0}
        saving={save.isPending}
        onSave={(kind, categoryId) => save.mutate({ kind, categoryId })}
        onCancel={onDone}
      />
      {txn.kind === 'SPENDING' && txn.amount < 0 && <OneOffToggle txn={txn} />}
      {txn.byHand && (
        <button type="button" className="btn btn-small" disabled={reset.isPending} onClick={() => reset.mutate()}>
          Sort it like the rest from {txn.merchant}
        </button>
      )}
      {(save.error || reset.error) && <p className="error">{(save.error ?? reset.error)!.message}</p>}
    </div>
  );
}

/** Marks a charge as a one-off (a special occasion), apart from the category's habit. */
function OneOffToggle({ txn }: { txn: MoneyTransaction }) {
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (oneOff: boolean) => api.setOneOff(txn.id, oneOff),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ['money-category'] });
    },
  });
  return (
    <label className="checkbox money-oneoff-toggle">
      <input type="checkbox" checked={Boolean(txn.oneOff)} disabled={set.isPending} onChange={(e) => set.mutate(e.target.checked)} />
      A one-off (a special occasion), not part of the usual habit
    </label>
  );
}

/** Kind, and a category for spending. */
function SortPicker({
  kind: initialKind,
  categoryId: initialCategory,
  categories,
  incoming,
  saving,
  onSave,
  onCancel,
}: {
  kind: MoneyKind | null;
  categoryId: string | null;
  categories: FinanceCategory[];
  incoming: boolean;
  saving: boolean;
  onSave: (kind: MoneyKind, categoryId: string | null) => void;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<MoneyKind | null>(initialKind);
  const [categoryId, setCategoryId] = useState(initialCategory ?? '');
  const ready = kind && (kind !== 'SPENDING' || categoryId);

  return (
    <div className="sort-picker">
      <div className="chips">
        {(Object.keys(KIND_LABELS) as MoneyKind[]).map((k) => (
          <button key={k} type="button" className={`chip ${kind === k ? 'chip-on' : ''}`} onClick={() => setKind(k)}>
            {k === 'SPENDING' && incoming ? 'Refund / paid back' : KIND_LABELS[k]}
          </button>
        ))}
      </div>
      {kind && <p className="muted small">{KIND_HELP[kind]}</p>}
      {kind === 'SPENDING' && (
        <label className="field">
          <span>{incoming ? 'Lowers spending on' : 'Category'}</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="" disabled>
              Choose a category
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || saving}
          onClick={() => kind && onSave(kind, kind === 'SPENDING' ? categoryId : null)}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- Needs a look ----------

function Review({ groups, categories }: { groups: ReviewGroup[] | undefined; categories: FinanceCategory[] }) {
  if (!groups) return null;
  if (!groups.length) return <p className="muted">Everything’s sorted.</p>;
  return (
    <>
      <p className="muted small">
        Sorting couldn’t settle these: payments to or from people, cash, or merchants it didn’t recognize. Your answer
        applies to everything from that merchant, now and later.
      </p>
      <ul className="money-review">
        {groups.map((g) => (
          <ReviewItem key={g.name} group={g} categories={categories} />
        ))}
      </ul>
    </>
  );
}

function ReviewItem({ group: g, categories }: { group: ReviewGroup; categories: FinanceCategory[] }) {
  const refresh = useRefresh();
  const save = useMutation({
    mutationFn: async ({ kind, categoryId }: { kind: MoneyKind; categoryId: string | null }) => {
      // Without a merchant key (rare), each transaction is sorted on its own.
      if (g.keys.length) await api.setMerchant(g.keys, kind, categoryId);
      else await Promise.all(g.ids.map((id) => api.setTransaction(id, kind, categoryId)));
    },
    onSuccess: refresh,
  });
  const when = g.count === 1 ? dayName(g.lastDate) : `${dayName(g.firstDate)} – ${dayName(g.lastDate)}`;

  return (
    <li className="money-review-item">
      <div className="money-account-head">
        <strong>{g.name}</strong>
        <span className={g.total > 0 ? 'money-in' : ''}>
          {g.total > 0 ? '+' : ''}
          {usd(g.total)}
        </span>
      </div>
      <p className="muted small">
        {g.count} × · {when} · {g.accounts.join(', ')}
        <br />“{g.example}”
      </p>
      <SortPicker
        kind={g.kind}
        categoryId={g.categoryId}
        categories={categories}
        incoming={g.total > 0}
        saving={save.isPending}
        onSave={(kind, categoryId) => save.mutate({ kind, categoryId })}
      />
      {save.error && <p className="error">{save.error.message}</p>}
    </li>
  );
}
