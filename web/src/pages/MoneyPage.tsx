import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { FinanceCategory, MoneyKind, MoneyTransaction, ReviewGroup } from '../types';

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

export function MoneyPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'review' ? 'review' : 'list';
  const status = useQuery({ queryKey: ['money'], queryFn: api.moneyStatus });
  const categories = useQuery({ queryKey: ['money-categories'], queryFn: api.moneyCategories });
  const review = useQuery({ queryKey: ['money-review'], queryFn: api.moneyReview });
  const lookCount = review.data?.reduce((n, g) => n + g.count, 0) ?? 0;

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
        <Link to="/settings/money" className="btn btn-small">
          Accounts
        </Link>
      </div>
      <div className="segmented">
        <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setParams({}, { replace: true })}>
          Transactions
        </button>
        <button
          type="button"
          className={view === 'review' ? 'on' : ''}
          onClick={() => setParams({ view: 'review' }, { replace: true })}
        >
          Needs a look{lookCount ? ` (${lookCount})` : ''}
        </button>
      </div>
      {view === 'list' ? (
        <Transactions categories={categories.data ?? []} />
      ) : (
        <Review groups={review.data} categories={categories.data ?? []} />
      )}
    </div>
  );
}

// ---------- Transactions ----------

type KindFilter = MoneyKind | '';

function Transactions({ categories }: { categories: FinanceCategory[] }) {
  const [month, setMonth] = useState(thisMonth);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<KindFilter>('');
  const [categoryId, setCategoryId] = useState('');
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
      {!search && (
        <>
          <div className="money-month">
            <button type="button" className="btn btn-small" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month">
              ‹
            </button>
            <strong>{monthName(month)}</strong>
            <button
              type="button"
              className="btn btn-small"
              disabled={month >= thisMonth()}
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              aria-label="Next month"
            >
              ›
            </button>
          </div>
          {d && (
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
        </>
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
    for (const key of ['money-txns', 'money-review', 'money-categories']) queryClient.invalidateQueries({ queryKey: [key] });
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
      {txn.byHand && (
        <button type="button" className="btn btn-small" disabled={reset.isPending} onClick={() => reset.mutate()}>
          Sort it like the rest from {txn.merchant}
        </button>
      )}
      {(save.error || reset.error) && <p className="error">{(save.error ?? reset.error)!.message}</p>}
    </div>
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
