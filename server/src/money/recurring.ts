import { prisma } from '../db.js';
import { wallTime } from '../zone.js';
import { homeTimeZone } from './connection.js';

/**
 * What recurs: the fixed bills being paid now, and the paychecks coming in.
 * The budget starts from these rather than from averages, so a new car payment
 * counts in full from the month it starts and a cancelled bill drops off.
 *
 * A bill is a merchant in a fixed category charged in at least two of the last
 * three months and again last month or this month; it costs what it cost in the
 * latest of those two months (several charges in a month, like four student
 * loans, add up). A merchant charged for the first time last month or this
 * month is offered as a possible new bill.
 *
 * A paycheck source is income from the same payer at least twice in recent
 * months; it brings in its usual (median) deposit times how often it comes.
 * Medians keep a bonus from raising the baseline.
 */

const DAY = 86_400_000;
const AVG_MONTH_DAYS = 30.44;
/** Income below this a month (interest) isn't worth listing as a source. */
const MIN_SOURCE = 20;

export interface Bill {
  name: string;
  categoryId: string;
  /** Per month, as of the latest month it was charged. */
  amount: number;
  /** This month so far. */
  paid: number;
  /** Day of the month it usually comes. */
  day: number;
  /** Charged only last month or this month so far: maybe new, maybe a one-off. */
  isNew: boolean;
}

export interface IncomeSource {
  name: string;
  /** Usual deposit. */
  amount: number;
  perMonth: number;
  monthly: number;
  /** Deposits well above the usual one (bonuses), in the window looked at. */
  extra: number;
  lastDate: string;
}

const shift = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round = (n: number) => Math.round(n * 100) / 100;

/** Recent transactions of a kind, with the merchant's name and the local date. */
async function recent(kind: 'SPENDING' | 'INCOME', since: Date, timeZone: string) {
  const txns = await prisma.financeTransaction.findMany({
    where: { kind, transactedAt: { gte: since } },
    select: { amount: true, transactedAt: true, merchantKey: true, description: true, categoryId: true, category: { select: { fixed: true } } },
  });
  const keys = [...new Set(txns.flatMap((t) => (t.merchantKey ? [t.merchantKey] : [])))];
  const names = new Map(
    (await prisma.financeMerchant.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } })).map((m) => [
      m.key,
      m.name,
    ]),
  );
  return txns.map((t) => ({
    name: (t.merchantKey && names.get(t.merchantKey)) || t.merchantKey || t.description,
    date: wallTime(t.transactedAt, timeZone).slice(0, 10),
    amount: t.amount.toNumber(),
    categoryId: t.categoryId,
    fixed: t.category?.fixed ?? false,
  }));
}

export async function findRecurring(): Promise<{ month: string; bills: Bill[]; income: IncomeSource[] }> {
  const timeZone = await homeTimeZone();
  const month = wallTime(new Date(), timeZone).slice(0, 7);
  const months = [-3, -2, -1, 0].map((by) => shift(month, by));
  const since = new Date(Date.now() - 130 * DAY);

  // ---------- Bills ----------
  const spending = (await recent('SPENDING', since, timeZone)).filter((t) => t.fixed && t.categoryId);
  const groups = new Map<string, typeof spending>();
  for (const t of spending) {
    const key = `${t.name}|${t.categoryId}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const bills: Bill[] = [];
  for (const rows of groups.values()) {
    const byMonth = months.map((m) => -rows.filter((r) => r.date.startsWith(m)).reduce((n, r) => n + r.amount, 0));
    const [m3, m2, m1, m0] = byMonth;
    const earlier = [m3, m2, m1].filter((v) => v > 0).length;
    const current = m1 > 0 || m0 > 0;
    if (!current) continue;
    const isNew = m3 <= 0 && m2 <= 0;
    if (!isNew && earlier < 2) continue;
    const latest = rows.map((r) => r.date).sort().at(-1)!;
    bills.push({
      name: rows[0].name,
      categoryId: rows[0].categoryId!,
      amount: round(Math.max(m0, m1)),
      paid: round(Math.max(0, m0)),
      day: Number(latest.slice(8, 10)),
      isNew,
    });
  }
  bills.sort((a, b) => a.day - b.day);

  // ---------- Paychecks ----------
  const deposits = (await recent('INCOME', since, timeZone)).filter((t) => t.amount > 0);
  const payers = new Map<string, typeof deposits>();
  for (const t of deposits) payers.set(t.name, [...(payers.get(t.name) ?? []), t]);
  const income: IncomeSource[] = [];
  for (const [name, rows] of payers) {
    if (rows.length < 2) continue;
    const dates = rows.map((r) => Date.parse(r.date)).sort((a, b) => a - b);
    const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / DAY).filter((g) => g >= 5);
    if (!gaps.length) continue;
    const usual = median(rows.map((r) => r.amount));
    const perMonth = Math.min(4.35, AVG_MONTH_DAYS / median(gaps));
    const monthly = usual * perMonth;
    if (monthly < MIN_SOURCE) continue;
    // A source that has stopped (nothing for two of its usual gaps) no longer counts.
    const lastDate = rows.map((r) => r.date).sort().at(-1)!;
    if (Date.now() - Date.parse(lastDate) > Math.max(45, median(gaps) * 2.5) * DAY) continue;
    income.push({
      name,
      amount: round(usual),
      perMonth: round(perMonth),
      monthly: round(monthly),
      extra: round(rows.filter((r) => r.amount > usual * 1.5).reduce((n, r) => n + r.amount - usual, 0)),
      lastDate,
    });
  }
  income.sort((a, b) => b.monthly - a.monthly);

  return { month, bills, income };
}
