import { prisma } from '../db.js';
import type { Overview } from './overview.js';
import { findRecurring, type Bill, type IncomeSource } from './recurring.js';
import { stepFor } from './watch.js';

/**
 * The monthly budget, as a plan that has to add up against income:
 *
 *   expected income − fixed bills − saving − one-offs = what's there for everyday spending
 *
 * - Expected income: the paychecks found (recurring.ts), or a figure typed in.
 * - Fixed categories: the bills being paid now, plus any added by hand. New
 *   ones (first charged last month or this month) wait to be confirmed.
 * - Everyday categories: the usual month, or an amount typed in; a watched
 *   category's budget is its step for the month (watch.ts).
 * - Saving: a monthly goal typed in (none at first).
 * - One-offs (celebrations, events): what usual months spent on them, or an
 *   amount typed in. Everyday budgets are habits, so one-offs need their own room.
 * The plan says how much of income is left unplanned, or how far over it goes.
 */

export type BillState = 'counted' | 'suggested' | 'ignored' | 'added';

export interface BudgetPlan {
  month: string;
  income: { expected: number; found: number; byHand: boolean; sources: IncomeSource[] };
  saving: number;
  oneOffs: { planned: number; usual: number | null; byHand: boolean };
  bills: (Bill & { state: BillState })[];
  categories: {
    id: string;
    name: string;
    fixed: boolean;
    budget: number;
    /** Where the budget comes from. */
    from: 'bills' | 'usual' | 'hand' | 'watch';
    usual: number | null;
    /** This month so far, habit only. */
    spent: number;
    /** This month's one-offs here. */
    oneOffs: number;
  }[];
  totals: {
    fixed: number;
    everyday: number;
    /** Income minus fixed bills, saving and one-offs: what everyday spending has to fit in. */
    forEveryday: number;
    /** Income minus everything planned. Negative when the plan spends more than comes in. */
    unplanned: number;
    /** All spending planned for the month. */
    budget: number;
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
/** Budgets from averages read better in round numbers. */
const roundTen = (n: number) => Math.round(n / 10) * 10;

/** The plan for the current month. `current` is the overview of the current month (for usual and spent). */
export async function budgetPlan(current: Overview): Promise<BudgetPlan> {
  const [{ bills: found, income }, settings, overrides, decided, categories, watches] = await Promise.all([
    findRecurring(),
    prisma.financeBudgetSettings.findUnique({ where: { id: 'default' } }),
    prisma.financeBudget.findMany(),
    prisma.financeBill.findMany(),
    prisma.financeCategory.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
    prisma.financeWatch.findMany(),
  ]);
  const watched = new Map(watches.map((w) => [w.categoryId, stepFor(w, current.month)?.amount]));
  const decision = new Map(decided.map((d) => [d.name, d]));

  const bills: BudgetPlan['bills'] = found.map((b) => {
    const d = decision.get(b.name)?.state;
    const state: BillState = d === 'ignore' ? 'ignored' : d === 'keep' || !b.isNew ? 'counted' : 'suggested';
    return { ...b, state };
  });
  // Bills added by hand that haven't shown up (by name) among those found.
  for (const d of decided) {
    if (d.state !== 'added' || !d.categoryId || !d.amount || found.some((b) => b.name === d.name)) continue;
    bills.push({
      name: d.name,
      categoryId: d.categoryId,
      amount: d.amount.toNumber(),
      paid: 0,
      day: d.day ?? 1,
      isNew: false,
      state: 'added',
    });
  }
  bills.sort((a, b) => a.day - b.day);

  const found$ = round(income.reduce((n, s) => n + s.monthly, 0));
  const expected = settings?.income ? settings.income.toNumber() : found$;
  const saving = settings?.saving.toNumber() ?? 0;
  const byCategory = new Map(current.categories.map((c) => [c.id, c]));
  const override = new Map(overrides.map((o) => [o.categoryId, o.amount.toNumber()]));

  const rows: BudgetPlan['categories'] = categories.map((c) => {
    const seen = byCategory.get(c.id);
    const usual = seen?.typical ?? null;
    const billsHere = round(
      bills.filter((b) => b.categoryId === c.id && (b.state === 'counted' || b.state === 'added')).reduce((n, b) => n + b.amount, 0),
    );
    const hand = override.get(c.id);
    const step = watched.get(c.id);
    const [budget, from]: [number, BudgetPlan['categories'][number]['from']] =
      step !== undefined
        ? [step, 'watch']
        : hand !== undefined
          ? [hand, 'hand']
          : c.fixed
            ? [billsHere, 'bills']
            : [roundTen(Math.max(0, usual ?? 0)), 'usual'];
    const oneOffs = seen?.oneOffs ?? 0;
    return { id: c.id, name: c.name, fixed: c.fixed, budget, from, usual, spent: round((seen?.spent ?? 0) - oneOffs), oneOffs };
  });

  const fixed = round(rows.filter((r) => r.fixed).reduce((n, r) => n + r.budget, 0));
  const everyday = round(rows.filter((r) => !r.fixed).reduce((n, r) => n + r.budget, 0));
  const usualOneOffs = current.typical ? current.typical.oneOffs : null;
  const oneOffs = settings?.oneOffs ? settings.oneOffs.toNumber() : roundTen(Math.max(0, usualOneOffs ?? 0));
  return {
    month: current.month,
    income: { expected, found: found$, byHand: Boolean(settings?.income), sources: income },
    saving,
    oneOffs: { planned: oneOffs, usual: usualOneOffs, byHand: Boolean(settings?.oneOffs) },
    bills,
    categories: rows,
    totals: {
      fixed,
      everyday,
      forEveryday: round(expected - fixed - saving - oneOffs),
      unplanned: round(expected - fixed - everyday - saving - oneOffs),
      budget: round(fixed + everyday + oneOffs),
    },
  };
}
