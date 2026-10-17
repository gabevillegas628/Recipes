import { prisma } from '../db.js';
import { wallTime } from '../zone.js';
import { homeTimeZone } from './connection.js';
import { MAX_DAYS } from './simplefin.js';

/**
 * The Money tab's overview of a month: what came in, went out and was saved;
 * spending by day against a typical month; each category against its usual;
 * and the last 12 months of in vs. out.
 *
 * "Typical" averages complete months only. A month is complete once every
 * checking account and card has data for it: before that (history imported for
 * some accounts but not others) totals undercount, so those months are shown
 * as partial and kept out of the averages. An account's data can only be cut
 * short by how far back the first sync reached; one that starts later than that
 * is simply new (a card first used in November) and doesn't make earlier months
 * partial.
 *
 * Charges marked one-off (a birthday dinner) count in what was spent, but a
 * category's usual month is its habit: one-offs are left out of it and shown
 * on their own.
 */

/** How many complete months "typical" averages. */
const TYPICAL_MONTHS = 6;

export interface Overview {
  month: string;
  current: boolean;
  /** Days of the month so far (all of them for a past month). */
  day: number;
  daysInMonth: number;
  totals: Totals;
  /** oneOffs: what usual months spent on one-offs, all categories together. */
  typical: (Totals & { months: string[]; oneOffs: number }) | null;
  /** Spending added up day by day: this month so far, and a typical month. */
  pace: { actual: number[]; typical: number[] | null };
  /** spent includes one-offs (oneOffs, this month); typical is the habit, one-offs left out. */
  categories: { id: string; name: string; fixed: boolean; spent: number; oneOffs: number; typical: number | null }[];
  history: (Totals & { month: string; partial: boolean; current: boolean })[];
  /** The first complete month, if any. */
  completeFrom: string | null;
}

interface Totals {
  income: number;
  /** Net of refunds. */
  spending: number;
  /** Net of money taken back out. */
  saving: number;
}

const shift = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const daysIn = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const round = (n: number) => Math.round(n * 100) / 100;

export async function overview(requested?: string): Promise<Overview> {
  const timeZone = await homeTimeZone();
  const today = wallTime(new Date(), timeZone);
  const thisMonth = today.slice(0, 7);
  const month = requested && requested <= thisMonth ? requested : thisMonth;
  const current = month === thisMonth;
  const daysInMonth = daysIn(month);
  const day = current ? Number(today.slice(8, 10)) : daysInMonth;
  const first = shift(month, -11);

  // Local time of each transaction. transactedAt is stored as UTC.
  const local = `(t."transactedAt" AT TIME ZONE 'UTC') AT TIME ZONE '${timeZone.replace(/'/g, '')}'`;

  const [coverage, firstSync, monthly, byCategory, daily, categories] = await Promise.all([
    prisma.$queryRawUnsafe<{ first: string }[]>(
      `SELECT min(to_char(${local}, 'YYYY-MM')) AS first
       FROM "FinanceTransaction" t JOIN "FinanceAccount" a ON a.id = t."accountId"
       WHERE a.kind IN ('CHECKING', 'CREDIT_CARD')
       GROUP BY a.id`,
    ),
    // Accounts are created on the first sync and kept through reconnects.
    prisma.financeAccount.aggregate({ _min: { createdAt: true } }),
    prisma.$queryRawUnsafe<{ month: string; kind: string; total: string }[]>(
      `SELECT to_char(${local}, 'YYYY-MM') AS month, t.kind::text AS kind, sum(t.amount)::text AS total
       FROM "FinanceTransaction" t
       WHERE t.kind IN ('INCOME', 'SPENDING', 'SAVING')
       GROUP BY 1, 2`,
    ),
    prisma.$queryRawUnsafe<{ month: string; categoryId: string | null; total: string; oneOff: string }[]>(
      `SELECT to_char(${local}, 'YYYY-MM') AS month, t."categoryId", sum(t.amount)::text AS total,
         sum(CASE WHEN t."oneOff" THEN t.amount ELSE 0 END)::text AS "oneOff"
       FROM "FinanceTransaction" t WHERE t.kind = 'SPENDING'
       GROUP BY 1, 2`,
    ),
    prisma.$queryRawUnsafe<{ month: string; day: number; total: string }[]>(
      `SELECT to_char(${local}, 'YYYY-MM') AS month, extract(day FROM ${local})::int AS day, sum(t.amount)::text AS total
       FROM "FinanceTransaction" t WHERE t.kind = 'SPENDING'
       GROUP BY 1, 2`,
    ),
    prisma.financeCategory.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
  ]);

  const reach = firstSync._min.createdAt
    ? wallTime(new Date(firstSync._min.createdAt.getTime() - MAX_DAYS * 86_400_000), timeZone).slice(0, 7)
    : null;
  const completeFrom = coverage.length
    ? coverage
        .map((c) => (reach && c.first > reach ? reach : c.first))
        .sort()
        .at(-1)!
    : null;
  const isComplete = (m: string) => Boolean(completeFrom && m >= completeFrom && m < thisMonth);

  const totalsFor = (m: string): Totals => {
    const sum = (kind: string) => Number(monthly.find((r) => r.month === m && r.kind === kind)?.total ?? 0);
    return { income: round(sum('INCOME')), spending: round(-sum('SPENDING')), saving: round(-sum('SAVING')) };
  };

  const typicalMonths = [...new Set(monthly.map((r) => r.month))]
    .filter((m) => isComplete(m) && m < month)
    .sort()
    .slice(-TYPICAL_MONTHS);
  const average = (values: number[]) => round(values.reduce((a, b) => a + b, 0) / values.length);

  const oneOffsIn = (m: string) => -byCategory.filter((r) => r.month === m).reduce((n, r) => n + Number(r.oneOff), 0);

  let typical: Overview['typical'] = null;
  if (typicalMonths.length) {
    const each = typicalMonths.map(totalsFor);
    typical = {
      months: typicalMonths,
      income: average(each.map((t) => t.income)),
      spending: average(each.map((t) => t.spending)),
      saving: average(each.map((t) => t.saving)),
      oneOffs: average(typicalMonths.map(oneOffsIn)),
    };
  }

  // Spending added up by day. A shorter month counts as finished by its last day.
  const cumulative = (m: string, upTo: number) => {
    const spent = new Map(daily.filter((r) => r.month === m).map((r) => [r.day, -Number(r.total)]));
    const out: number[] = [];
    let running = 0;
    for (let d = 1; d <= upTo; d++) {
      running += spent.get(d) ?? 0;
      out.push(round(running));
    }
    return out;
  };
  const actual = cumulative(month, day);
  const typicalPace = typicalMonths.length
    ? Array.from({ length: daysInMonth }, (_, i) =>
        average(typicalMonths.map((m) => cumulative(m, daysIn(m))[Math.min(i, daysIn(m) - 1)])),
      )
    : null;

  const row = (m: string, id: string) => byCategory.find((r) => r.month === m && r.categoryId === id);
  const categorySpend = (m: string, id: string) => -Number(row(m, id)?.total ?? 0);
  const categoryOneOffs = (m: string, id: string) => -Number(row(m, id)?.oneOff ?? 0);
  const categoryRows = categories
    .map((c) => ({
      id: c.id,
      name: c.name,
      fixed: c.fixed,
      spent: round(categorySpend(month, c.id)),
      oneOffs: round(categoryOneOffs(month, c.id)),
      typical: typicalMonths.length
        ? average(typicalMonths.map((m) => categorySpend(m, c.id) - categoryOneOffs(m, c.id)))
        : null,
    }))
    .filter((c) => c.spent !== 0 || (c.typical ?? 0) !== 0)
    .sort((a, b) => b.spent - a.spent);

  const history = Array.from({ length: 12 }, (_, i) => shift(first, i))
    .filter((m) => monthly.some((r) => r.month === m) || m === month)
    .map((m) => ({ month: m, ...totalsFor(m), partial: !isComplete(m) && m !== thisMonth, current: m === thisMonth }));

  return {
    month,
    current,
    day,
    daysInMonth,
    totals: totalsFor(month),
    typical,
    pace: { actual, typical: typicalPace },
    categories: categoryRows,
    history,
    completeFrom,
  };
}
