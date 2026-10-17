import { prisma } from '../db.js';
import { wallTime, zonedInstant } from '../zone.js';
import { budgetPlan } from './budget.js';
import { homeTimeZone } from './connection.js';
import { overview } from './overview.js';
import { watchStatuses, type WatchStatus } from './watch.js';

/**
 * One category up close, for spotting what drives it: 12 months of habit
 * against one-offs and the budget, and for a chosen month how many charges,
 * their average, where they went and on which days. Plus the charges that look
 * like one-offs (far bigger than the category's usual charge) for a decision.
 */

/** A charge this much bigger than the category's median charge, and at least MIN_ONE_OFF, looks like a one-off. */
const ONE_OFF_TIMES = 4;
const MIN_ONE_OFF = 150;

export interface CategoryDetail {
  category: { id: string; name: string; fixed: boolean };
  month: string;
  current: boolean;
  /** This month's budget for it (null without one). */
  budget: number | null;
  /** Its usual month, habit only. */
  usual: number | null;
  usualMonths: string[];
  history: { month: string; habit: number; oneOffs: number; partial: boolean; current: boolean }[];
  /** The chosen month, habit only (one-offs apart). */
  stats: {
    habit: number;
    oneOffs: number;
    charges: number;
    average: number | null;
    merchants: { name: string; charges: number; total: number }[];
    /** Monday first. */
    weekdays: { total: number; charges: number }[];
  };
  /** Undecided charges from the last 12 months that look like one-offs. */
  maybeOneOffs: Charge[];
  /** Charges marked one-off in the last 12 months. */
  oneOffs: Charge[];
  /** Being brought down to a target, if it is. */
  watch: WatchStatus | null;
  /** For starting to watch: a pace that cuts about a tenth a month. */
  canWatch: boolean;
}

interface Charge {
  id: string;
  date: string;
  merchant: string;
  amount: number;
}

const shift = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const round = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export async function categoryDetail(id: string, requested?: string): Promise<CategoryDetail | null> {
  const category = await prisma.financeCategory.findUnique({ where: { id } });
  if (!category) return null;
  const timeZone = await homeTimeZone();
  const now = await overview();
  const month = requested && requested <= now.month ? requested : now.month;
  const first = shift(now.month, -11);
  const plan = await budgetPlan(now);

  const txns = await prisma.financeTransaction.findMany({
    where: { categoryId: id, kind: 'SPENDING', transactedAt: { gte: zonedInstant(`${first}-01T00:00:00`, timeZone) } },
    select: { id: true, amount: true, transactedAt: true, oneOff: true, merchantKey: true, description: true },
    orderBy: { transactedAt: 'desc' },
  });
  const names = new Map(
    (
      await prisma.financeMerchant.findMany({
        where: { key: { in: [...new Set(txns.flatMap((t) => (t.merchantKey ? [t.merchantKey] : [])))] } },
        select: { key: true, name: true },
      })
    ).map((m) => [m.key, m.name]),
  );
  const rows = txns.map((t) => {
    const date = wallTime(t.transactedAt, timeZone).slice(0, 10);
    return {
      id: t.id,
      date,
      month: date.slice(0, 7),
      merchant: (t.merchantKey && names.get(t.merchantKey)) || t.description,
      // Spending is negative in the data: here a charge is positive and a refund negative.
      amount: -t.amount.toNumber(),
      oneOff: t.oneOff,
    };
  });

  const partial = new Set(now.history.filter((h) => h.partial).map((h) => h.month));
  const history = Array.from({ length: 12 }, (_, i) => shift(first, i)).map((m) => {
    const inMonth = rows.filter((r) => r.month === m);
    const oneOffs = inMonth.filter((r) => r.oneOff).reduce((n, r) => n + r.amount, 0);
    const total = inMonth.reduce((n, r) => n + r.amount, 0);
    return { month: m, habit: round(total - oneOffs), oneOffs: round(oneOffs), partial: partial.has(m), current: m === now.month };
  });

  const habit = rows.filter((r) => r.month === month && !r.oneOff);
  const charges = habit.filter((r) => r.amount > 0);
  const merchants = new Map<string, { charges: number; total: number }>();
  for (const r of habit) {
    const m = merchants.get(r.merchant) ?? { charges: 0, total: 0 };
    if (r.amount > 0) m.charges++;
    m.total += r.amount;
    merchants.set(r.merchant, m);
  }
  const weekdays = Array.from({ length: 7 }, () => ({ total: 0, charges: 0 }));
  for (const r of charges) {
    // getUTCDay on the date at noon: 0 is Sunday; Monday first here.
    const d = (new Date(`${r.date}T12:00:00Z`).getUTCDay() + 6) % 7;
    weekdays[d].total = round(weekdays[d].total + r.amount);
    weekdays[d].charges++;
  }

  const typicalCharge = median(rows.filter((r) => !r.oneOff && r.amount > 0).map((r) => r.amount));
  const threshold = Math.max(MIN_ONE_OFF, (typicalCharge || 0) * ONE_OFF_TIMES);
  const pick = (r: (typeof rows)[number]): Charge => ({ id: r.id, date: r.date, merchant: r.merchant, amount: round(r.amount) });
  const planned = plan.categories.find((c) => c.id === id);
  const usualRow = now.categories.find((c) => c.id === id);
  const habitTotal = habit.reduce((n, r) => n + r.amount, 0);

  return {
    category: { id: category.id, name: category.name, fixed: category.fixed },
    month,
    current: month === now.month,
    budget: planned && planned.budget > 0 ? planned.budget : null,
    usual: usualRow?.typical ?? planned?.usual ?? null,
    usualMonths: now.typical?.months ?? [],
    history,
    stats: {
      habit: round(habitTotal),
      oneOffs: round(rows.filter((r) => r.month === month && r.oneOff).reduce((n, r) => n + r.amount, 0)),
      charges: charges.length,
      average: charges.length ? round(charges.reduce((n, r) => n + r.amount, 0) / charges.length) : null,
      merchants: [...merchants.entries()]
        .map(([name, m]) => ({ name, charges: m.charges, total: round(m.total) }))
        .filter((m) => m.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 6),
      weekdays,
    },
    // Fixed costs (rent, a car payment) are big by nature, not occasions.
    maybeOneOffs: category.fixed ? [] : rows.filter((r) => r.oneOff === null && r.amount >= threshold).map(pick),
    oneOffs: rows.filter((r) => r.oneOff).map(pick),
    watch: (await watchStatuses()).find((w) => w.categoryId === id) ?? null,
    canWatch: !category.fixed,
  };
}

/** Marks a charge as a one-off (true), part of the habit (false), or undecided again (null). */
export async function setOneOff(id: string, oneOff: boolean | null) {
  const updated = await prisma.financeTransaction.updateMany({ where: { id, kind: 'SPENDING' }, data: { oneOff } });
  return updated.count > 0;
}
