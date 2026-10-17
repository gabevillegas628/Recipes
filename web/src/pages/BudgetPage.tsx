import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usd } from '../components/MoneyCharts';
import type { BudgetBill, BudgetPlan, IncomeSource } from '../types';

/**
 * Money → Budget: a month's plan set against what comes in. Expected income,
 * minus fixed bills and saving, leaves what everyday spending has to fit in;
 * the everyday budgets either fit or don't, and the page says by how much.
 */

const signed = (n: number) => `${n < 0 ? '−' : ''}${usd(n)}`;
const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;

function howOften(perMonth: number) {
  if (Math.abs(perMonth - 2.17) < 0.25) return 'every 2 weeks';
  if (Math.abs(perMonth - 4.35) < 0.4) return 'every week';
  if (Math.abs(perMonth - 2) < 0.1) return 'twice a month';
  if (Math.abs(perMonth - 1) < 0.15) return 'once a month';
  return `about ${perMonth.toFixed(1)} times a month`;
}

/** A dollar amount typed in: "1,200" or "$85.50" → number; blank → null. */
function readAmount(text: string): number | null | undefined {
  const t = text.replace(/[$,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
}

export function BudgetPage() {
  const queryClient = useQueryClient();
  const budget = useQuery({ queryKey: ['money-budget'], queryFn: api.moneyBudget });
  const categories = useQuery({ queryKey: ['money-categories'], queryFn: api.moneyCategories });
  const onPlan = (next: BudgetPlan) => {
    queryClient.setQueryData(['money-budget'], next);
    queryClient.invalidateQueries({ queryKey: ['money-overview'] });
  };
  const fit = useMutation({ mutationFn: api.fitBudget, onSuccess: onPlan });
  const reset = useMutation({ mutationFn: api.resetEverydayBudgets, onSuccess: onPlan });

  const b = budget.data;
  if (budget.error) return <div className="page money">{<p className="error">{budget.error.message}</p>}</div>;
  if (!b) return <div className="page money" />;

  const t = b.totals;
  const over = t.unplanned < 0;
  const handEveryday = b.categories.some((c) => !c.fixed && c.from === 'hand');
  const fixedCategories = (categories.data ?? []).filter((c) => c.fixed);

  return (
    <div className="page money budget">
      <Link to="/money" className="back-link">
        ‹ Money
      </Link>
      <h1 className="form-title">Budget</h1>
      <p className="muted">A month’s plan, set against what comes in.</p>

      <section className="budget-ledger" aria-label="Does it add up">
        <div className="budget-line">
          <span>Coming in</span>
          <span>{usd(b.income.expected)}</span>
        </div>
        <div className="budget-line">
          <span>Fixed bills</span>
          <span>−{usd(t.fixed)}</span>
        </div>
        <div className="budget-line">
          <span>Saving</span>
          <span>−{usd(b.saving)}</span>
        </div>
        <div className="budget-line">
          <span>One-offs &amp; events</span>
          <span>−{usd(b.oneOffs.planned)}</span>
        </div>
        <div className="budget-line budget-subtotal">
          <span>Left for everyday spending</span>
          <span>{signed(t.forEveryday)}</span>
        </div>
        <div className="budget-line">
          <span>Everyday budget</span>
          <span>{usd(t.everyday)}</span>
        </div>
        <p className={`budget-verdict ${over ? 'budget-over' : 'budget-ok'}`}>
          <span aria-hidden>{over ? '▲' : '✓'}</span>
          {over
            ? `The plan spends ${usd(t.unplanned)} a month more than comes in.`
            : t.unplanned < 50
              ? 'It adds up, with nothing to spare.'
              : `It adds up, with ${usd(t.unplanned)} a month unplanned.`}
        </p>
        {over && t.forEveryday > 0 && (
          <p className="muted small">
            Lowering everyday budgets to fit means spending {usd(t.forEveryday)} a month on them instead of {usd(t.everyday)}.
            “Fit” scales every everyday category down by the same share; adjust any of them after.
          </p>
        )}
        {over && t.forEveryday <= 0 && (
          <p className="muted small">Bills, saving and one-offs alone take more than comes in, so everyday spending can’t fit until one of those changes.</p>
        )}
        <div className="settings-actions">
          {over && t.forEveryday > 0 && (
            <button type="button" className="btn btn-primary" disabled={fit.isPending} onClick={() => fit.mutate()}>
              Fit everyday to {usd(t.forEveryday)}
            </button>
          )}
          {handEveryday && (
            <button type="button" className="btn" disabled={reset.isPending} onClick={() => reset.mutate()}>
              Everyday back to usual
            </button>
          )}
        </div>
        {(fit.error || reset.error) && <p className="error">{(fit.error ?? reset.error)!.message}</p>}
      </section>

      <Income plan={b} onPlan={onPlan} />
      <Saving plan={b} onPlan={onPlan} />
      <OneOffRoom plan={b} onPlan={onPlan} />
      <Bills plan={b} onPlan={onPlan} fixedCategories={fixedCategories} />
      <Everyday plan={b} onPlan={onPlan} />
      <Recurring plan={b} onPlan={onPlan} />
    </div>
  );
}

// ---------- Coming in ----------

function Income({ plan: b, onPlan }: { plan: BudgetPlan; onPlan: (p: BudgetPlan) => void }) {
  const [text, setText] = useState('');
  const save = useMutation({
    mutationFn: (income: number | null) => api.setBudgetSettings({ income }),
    onSuccess: (p) => {
      setText('');
      onPlan(p);
    },
  });
  const extra = b.income.sources.reduce((n, s) => n + s.extra, 0);
  const typed = readAmount(text);

  return (
    <section className="budget-section">
      <h2>
        Coming in <span>{usd(b.income.expected)} a month</span>
      </h2>
      {b.income.sources.length ? (
        <ul className="budget-list">
          {b.income.sources.map((s: IncomeSource) => (
            <li key={s.name}>
              <span>
                {s.name}
                <span className="muted small">
                  {usd(s.amount)} {howOften(s.perMonth)}
                </span>
              </span>
              <span>{usd(s.monthly)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No regular paychecks found yet.</p>
      )}
      {extra > 0 && (
        <p className="muted small">Paychecks well above the usual (bonuses, {usd(extra)} recently) aren’t counted on.</p>
      )}
      {b.income.byHand && (
        <p className="muted small">
          Using {usd(b.income.expected)} typed in; the paychecks found add up to {usd(b.income.found)}.
        </p>
      )}
      <form
        className="budget-amount-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (typed !== undefined && typed !== null) save.mutate(typed);
        }}
      >
        <input
          inputMode="decimal"
          placeholder={b.income.byHand ? 'A different amount' : 'Expect a different amount?'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Expected income a month"
        />
        <button className="btn" disabled={typed === undefined || typed === null || save.isPending}>
          Use
        </button>
        {b.income.byHand && (
          <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Use paychecks found
          </button>
        )}
      </form>
      {save.error && <p className="error">{save.error.message}</p>}
    </section>
  );
}

// ---------- Saving ----------

function Saving({ plan: b, onPlan }: { plan: BudgetPlan; onPlan: (p: BudgetPlan) => void }) {
  const [text, setText] = useState(b.saving ? String(b.saving) : '');
  const save = useMutation({ mutationFn: (saving: number) => api.setBudgetSettings({ saving }), onSuccess: onPlan });
  const typed = readAmount(text);
  const changed = (typed ?? 0) !== b.saving;

  return (
    <section className="budget-section">
      <h2>
        Saving <span>{usd(b.saving)} a month</span>
      </h2>
      <p className="muted small">What you mean to put into savings or Fidelity each month. It comes off the top, before everyday spending.</p>
      <form
        className="budget-amount-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (typed !== undefined) save.mutate(typed ?? 0);
        }}
      >
        <input inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(e.target.value)} aria-label="Saving a month" />
        <button className="btn" disabled={typed === undefined || !changed || save.isPending}>
          Save
        </button>
      </form>
      {save.error && <p className="error">{save.error.message}</p>}
    </section>
  );
}

// ---------- One-offs ----------

function OneOffRoom({ plan: b, onPlan }: { plan: BudgetPlan; onPlan: (p: BudgetPlan) => void }) {
  const [text, setText] = useState('');
  const save = useMutation({
    mutationFn: (oneOffs: number | null) => api.setBudgetSettings({ oneOffs }),
    onSuccess: (p) => {
      setText('');
      onPlan(p);
    },
  });
  const typed = readAmount(text);
  const o = b.oneOffs;

  return (
    <section className="budget-section">
      <h2>
        One-offs &amp; events <span>{usd(o.planned)} a month</span>
      </h2>
      <p className="muted small">
        Room for special occasions (birthdays, parties, a big night out), kept apart from everyday habits. Mark a charge as a
        one-off on its category’s page.
        {o.usual !== null && ` Usual months spent ${usd(o.usual)} a month on them.`}
      </p>
      <form
        className="budget-amount-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (typed !== undefined && typed !== null) save.mutate(typed);
        }}
      >
        <input inputMode="decimal" placeholder="A different amount" value={text} onChange={(e) => setText(e.target.value)} aria-label="One-offs a month" />
        <button className="btn" disabled={typed === undefined || typed === null || save.isPending}>
          Use
        </button>
        {o.byHand && (
          <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Use the usual
          </button>
        )}
      </form>
      {save.error && <p className="error">{save.error.message}</p>}
    </section>
  );
}

// ---------- Fixed bills ----------

function Bills({
  plan: b,
  onPlan,
  fixedCategories,
}: {
  plan: BudgetPlan;
  onPlan: (p: BudgetPlan) => void;
  fixedCategories: { id: string; name: string }[];
}) {
  const set = useMutation({
    mutationFn: ({ name, state }: { name: string; state: 'keep' | 'ignore' | null }) => api.setBill(name, state),
    onSuccess: onPlan,
  });
  const remove = useMutation({ mutationFn: api.removeBill, onSuccess: onPlan });
  const [adding, setAdding] = useState(false);
  const suggested = b.bills.filter((x) => x.state === 'suggested');
  const ignored = b.bills.filter((x) => x.state === 'ignored');
  const fixed = b.categories.filter((c) => c.fixed && c.budget > 0);

  const billRow = (bill: BudgetBill) => (
    <li key={bill.name}>
      <span>
        {bill.name}
        <span className="muted small">
          {bill.state === 'added' ? 'added by hand · ' : ''}around the {ordinal(bill.day)}
          {bill.paid > 0 ? ` · paid ${usd(bill.paid)} this month` : ''}
        </span>
      </span>
      <span className="budget-bill-end">
        {usd(bill.amount)}
        {bill.state === 'added' ? (
          <button type="button" className="btn btn-small" onClick={() => remove.mutate(bill.name)} aria-label={`Remove ${bill.name}`}>
            ✕
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => set.mutate({ name: bill.name, state: 'ignore' })}
            aria-label={`${bill.name} isn't a monthly bill`}
            title="Not a monthly bill"
          >
            ✕
          </button>
        )}
      </span>
    </li>
  );

  return (
    <section className="budget-section">
      <h2>
        Fixed bills <span>{usd(b.totals.fixed)} a month</span>
      </h2>
      <p className="muted small">
        Bills charged most months, at what they cost now. A new one counts in full from its first month. ✕ takes out
        one that isn’t really monthly.
      </p>

      {suggested.length > 0 && (
        <div className="budget-suggested">
          <h3>New lately: monthly from now on?</h3>
          <ul className="budget-list">
            {suggested.map((bill) => (
              <li key={bill.name}>
                <span>
                  {bill.name}
                  <span className="muted small">
                    {b.categories.find((c) => c.id === bill.categoryId)?.name} · around the {ordinal(bill.day)}
                  </span>
                </span>
                <span className="budget-bill-end">
                  {usd(bill.amount)}
                  <button type="button" className="btn btn-small btn-primary" onClick={() => set.mutate({ name: bill.name, state: 'keep' })}>
                    Monthly
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => set.mutate({ name: bill.name, state: 'ignore' })}>
                    No
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {fixed.map((c) => (
        <div key={c.id} className="budget-group">
          <h3>
            {c.name}
            <span>{usd(c.budget)}</span>
          </h3>
          {c.from === 'hand' && <p className="muted small">Typed in; its bills add up differently.</p>}
          <ul className="budget-list">
            {b.bills.filter((x) => x.categoryId === c.id && (x.state === 'counted' || x.state === 'added')).map(billRow)}
          </ul>
        </div>
      ))}

      {ignored.length > 0 && (
        <details className="budget-ignored">
          <summary>Not counted as monthly ({ignored.length})</summary>
          <ul className="budget-list">
            {ignored.map((bill) => (
              <li key={bill.name}>
                <span>{bill.name}</span>
                <span className="budget-bill-end">
                  {usd(bill.amount)}
                  <button type="button" className="btn btn-small" onClick={() => set.mutate({ name: bill.name, state: 'keep' })}>
                    Count it
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {adding ? (
        <AddBill categories={fixedCategories} onPlan={onPlan} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn btn-small" onClick={() => setAdding(true)}>
          Add a bill that hasn’t come yet
        </button>
      )}
      {(set.error || remove.error) && <p className="error">{(set.error ?? remove.error)!.message}</p>}
    </section>
  );
}

function AddBill({
  categories,
  onPlan,
  onDone,
}: {
  categories: { id: string; name: string }[];
  onPlan: (p: BudgetPlan) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState('1');
  const add = useMutation({
    mutationFn: () => api.addBill({ name: name.trim(), categoryId, amount: readAmount(amount)!, day: Number(day) }),
    onSuccess: (p) => {
      onPlan(p);
      onDone();
    },
  });
  const ok = name.trim() && categoryId && (readAmount(amount) ?? 0) > 0;

  return (
    <form
      className="form budget-add"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (ok) add.mutate();
      }}
    >
      <label className="field">
        <span>Bill</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New car insurance" maxLength={200} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>A month</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0" />
        </label>
        <label className="field">
          <span>Around the</span>
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            {Array.from({ length: 31 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {ordinal(i + 1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Category</span>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="" disabled>
            Choose a fixed category
          </option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {add.error && <p className="error">{add.error.message}</p>}
      <div className="settings-actions">
        <button className="btn btn-primary" disabled={!ok || add.isPending}>
          Add bill
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------- Subscriptions and recurring charges ----------

function Recurring({ plan: b, onPlan }: { plan: BudgetPlan; onPlan: (p: BudgetPlan) => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['money-recurring'], queryFn: api.moneyRecurring });
  const set = useMutation({
    mutationFn: ({ name, state }: { name: string; state: 'ignore' | null }) => api.setBill(name, state),
    onSuccess: (p) => {
      onPlan(p);
      queryClient.invalidateQueries({ queryKey: ['money-recurring'] });
    },
  });
  const categoryName = new Map(b.categories.map((c) => [c.id, c.name]));
  if (!list.data) return null;
  const { charges, ignored } = list.data;
  const total = charges.reduce((n, c) => n + c.monthly, 0);

  return (
    <section className="budget-section">
      <h2>
        Subscriptions &amp; recurring <span>{usd(total)} a month</span>
      </h2>
      <p className="muted small">
        Everything charged about once a month, bills included, in any category. Price rises and new ones are marked. ✕ sets
        aside one that isn’t really recurring.
      </p>
      <ul className="budget-list">
        {charges.map((c) => (
          <li key={c.name}>
            <span>
              <span>
                {c.name}
                {c.isNew && <span className="budget-flag">new</span>}
                {c.was !== null && <span className="budget-flag">was {usd(c.was, true)}</span>}
              </span>
              <span className="muted small">
                {c.categoryId ? categoryName.get(c.categoryId) : 'No category'} · last {shortDay(c.lastDate)}
              </span>
            </span>
            <span className="budget-bill-end">
              {usd(c.amount, c.amount < 100 && c.amount % 1 !== 0)}
              <button
                type="button"
                className="btn btn-small"
                onClick={() => set.mutate({ name: c.name, state: 'ignore' })}
                aria-label={`${c.name} isn't recurring`}
                title="Not recurring"
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      {ignored.length > 0 && (
        <details className="budget-ignored">
          <summary>Set aside ({ignored.length})</summary>
          <ul className="budget-list">
            {ignored.map((c) => (
              <li key={c.name}>
                <span>{c.name}</span>
                <span className="budget-bill-end">
                  {usd(c.amount, c.amount < 100 && c.amount % 1 !== 0)}
                  <button type="button" className="btn btn-small" onClick={() => set.mutate({ name: c.name, state: null })}>
                    Put back
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {set.error && <p className="error">{set.error.message}</p>}
    </section>
  );
}

const shortDay = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ---------- Everyday ----------

function Everyday({ plan: b, onPlan }: { plan: BudgetPlan; onPlan: (p: BudgetPlan) => void }) {
  const rows = b.categories.filter((c) => !c.fixed && (c.budget > 0 || (c.usual ?? 0) > 0 || c.spent > 0 || c.from === 'hand'));
  return (
    <section className="budget-section">
      <h2>
        Everyday spending <span>{usd(b.totals.everyday)} a month</span>
      </h2>
      <p className="muted small">Starts from a usual month. Type a different amount to set your own; clear it to go back to usual.</p>
      <ul className="budget-list budget-everyday">
        {rows.map((c) => (
          <EverydayRow key={`${c.id}-${c.budget}-${c.from}`} row={c} onPlan={onPlan} />
        ))}
      </ul>
    </section>
  );
}

function EverydayRow({ row: c, onPlan }: { row: BudgetPlan['categories'][number]; onPlan: (p: BudgetPlan) => void }) {
  const [text, setText] = useState(String(Math.round(c.budget)));
  const save = useMutation({ mutationFn: (amount: number | null) => api.setCategoryBudget(c.id, amount), onSuccess: onPlan });

  function commit() {
    const typed = readAmount(text);
    if (typed === undefined) return setText(String(Math.round(c.budget)));
    if (typed === null) {
      if (c.from === 'hand') save.mutate(null);
      else setText(String(Math.round(c.budget)));
      return;
    }
    if (typed !== c.budget) save.mutate(typed);
  }

  return (
    <li>
      <span>
        {c.name}
        <span className="muted small">
          {c.usual !== null ? `usual ${usd(c.usual)}` : 'no usual yet'}
          {c.from === 'hand' ? ' · set by you' : ''} · {usd(c.spent)} so far
          {c.oneOffs > 0 ? ` + ${usd(c.oneOffs)} one-off` : ''}
        </span>
      </span>
      <span className="budget-input">
        $
        <input
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label={`${c.name} budget a month`}
          disabled={save.isPending}
        />
      </span>
    </li>
  );
}
