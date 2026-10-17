import { prisma } from '../db.js';
import type { FinanceWatch } from '../generated/prisma/client.js';
import { wallTime, zonedInstant } from '../zone.js';
import { homeTimeZone } from './connection.js';

/**
 * Watched categories: an everyday category brought down to a target a step at
 * a time, with a weekly allowance so it's noticed mid-month, not after.
 *
 * - Steps: evenly from where the habit was when watching started to the
 *   target, one a month; the last one is the target. Paused, the step holds.
 * - The month's step is the category's budget (budget.ts).
 * - Weekly allowance: the step spread evenly over the month's days, in weeks
 *   from Monday (the first and last are partial). Unspent money carries into the
 *   next week and overspending comes out of it, so this week has whatever the
 *   month so far allowed minus what the habit has spent; each month starts fresh.
 * Only the habit counts: one-offs don't use up the allowance.
 */

const round = (n: number) => Math.round(n * 100) / 100;
/** Steps come out in round numbers. */
const roundTen = (n: number) => Math.round(n / 10) * 10;

const shift = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthsBetween = (from: string, to: string) => {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
};
const daysIn = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

type WatchRow = Pick<FinanceWatch, 'target' | 'start' | 'months' | 'startMonth' | 'pausedSince'>;

/** The month's step (0-based) and amount. Before the first month there's no step. */
export function stepFor(w: WatchRow, month: string): { step: number; amount: number } | null {
  const held = w.pausedSince ? Math.max(0, monthsBetween(w.pausedSince, month)) : 0;
  const elapsed = monthsBetween(w.startMonth, month) - held;
  if (elapsed < 0) return null;
  const step = Math.min(elapsed, w.months - 1);
  return { step, amount: stepAmount(w, step) };
}

function stepAmount(w: WatchRow, step: number) {
  const start = w.start.toNumber();
  const target = w.target.toNumber();
  if (step >= w.months - 1) return target;
  return roundTen(start + ((target - start) * (step + 1)) / w.months);
}

/** A pace that cuts about a tenth a month: big drops get more steps. At most six. */
export function suggestedMonths(start: number, target: number) {
  if (target >= start) return 1;
  return Math.min(6, Math.max(1, Math.ceil((start - target) / (start * 0.12))));
}

export interface WatchStatus {
  categoryId: string;
  name: string;
  target: number;
  start: number;
  months: number;
  paused: boolean;
  /** 0-based. */
  step: number;
  /** This month's step: the category's budget. */
  monthAmount: number;
  /** Every step, from the first month. */
  steps: { month: string; amount: number }[];
  /** Habit this month so far. */
  spent: number;
  week: { from: string; to: string; allowance: number; spent: number; left: number };
  /** This month's weeks so far, for how each went. */
  weeks: { from: string; to: string; allowance: number; spent: number }[];
}

/** Every watch, as of today. */
export async function watchStatuses(): Promise<WatchStatus[]> {
  const watches = await prisma.financeWatch.findMany({ include: { category: { select: { name: true } } } });
  if (!watches.length) return [];
  const timeZone = await homeTimeZone();
  const today = wallTime(new Date(), timeZone).slice(0, 10);
  const month = today.slice(0, 7);
  const days = daysIn(month);
  const dayOfMonth = Number(today.slice(8, 10));

  // Habit spending this month, by category and day.
  const next = shift(month, 1);
  const txns = await prisma.financeTransaction.findMany({
    where: {
      kind: 'SPENDING',
      categoryId: { in: watches.map((w) => w.categoryId) },
      // Undecided (null) counts as habit; `not: true` alone would leave nulls out, as SQL does.
      OR: [{ oneOff: null }, { oneOff: false }],
      transactedAt: { gte: zonedInstant(`${month}-01T00:00:00`, timeZone), lt: zonedInstant(`${next}-01T00:00:00`, timeZone) },
    },
    select: { categoryId: true, amount: true, transactedAt: true },
  });
  const spentBy = (categoryId: string, fromDay: number, toDay: number) =>
    round(
      txns
        .filter((t) => {
          if (t.categoryId !== categoryId) return false;
          const d = Number(wallTime(t.transactedAt, timeZone).slice(8, 10));
          return d >= fromDay && d <= toDay;
        })
        .reduce((n, t) => n - t.amount.toNumber(), 0),
    );

  // Weeks run Monday to Sunday, cut at the month's edges.
  const weekday = (day: number) => (new Date(`${month}-${String(day).padStart(2, '0')}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weeks: { from: number; to: number }[] = [];
  for (let d = 1; d <= days; d++) {
    if (d === 1 || weekday(d) === 0) weeks.push({ from: d, to: d });
    else weeks[weeks.length - 1].to = d;
  }
  const date = (day: number) => `${month}-${String(day).padStart(2, '0')}`;

  return watches
    .map((w) => {
      const s = stepFor(w, month) ?? { step: 0, amount: stepAmount(w, 0) };
      const perDay = s.amount / days;
      const thisWeek = weeks.find((wk) => dayOfMonth >= wk.from && dayOfMonth <= wk.to)!;
      // What the month has allowed through this week's end, less what the habit spent before it: carried over both ways.
      const before = spentBy(w.categoryId, 1, thisWeek.from - 1);
      const allowance = round(perDay * thisWeek.to - before);
      const spentThisWeek = spentBy(w.categoryId, thisWeek.from, thisWeek.to);
      let carried = 0;
      const past = weeks
        .filter((wk) => wk.from <= dayOfMonth)
        .map((wk) => {
          const fresh = perDay * (wk.to - wk.from + 1);
          const spent = spentBy(w.categoryId, wk.from, wk.to);
          const row = { from: date(wk.from), to: date(wk.to), allowance: round(fresh + carried), spent };
          carried = fresh + carried - spent;
          return row;
        });
      return {
        categoryId: w.categoryId,
        name: w.category.name,
        target: w.target.toNumber(),
        start: w.start.toNumber(),
        months: w.months,
        paused: Boolean(w.pausedSince),
        step: s.step,
        monthAmount: s.amount,
        steps: Array.from({ length: w.months }, (_, i) => ({ month: shift(w.startMonth, i), amount: stepAmount(w, i) })),
        spent: spentBy(w.categoryId, 1, days),
        week: {
          from: date(thisWeek.from),
          to: date(thisWeek.to),
          allowance,
          spent: spentThisWeek,
          left: round(allowance - spentThisWeek),
        },
        weeks: past,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Starts (or changes) watching a category. Changing the target or pace starts the steps again from this month. */
export async function setWatch(categoryId: string, target: number, months: number, start: number) {
  const timeZone = await homeTimeZone();
  const month = wallTime(new Date(), timeZone).slice(0, 7);
  const data = { target, months, start, startMonth: month, pausedSince: null };
  await prisma.financeWatch.upsert({ where: { categoryId }, create: { categoryId, ...data }, update: data });
}

/** Pauses the step-down (the current step holds), or resumes it where it left off. */
export async function pauseWatch(categoryId: string, paused: boolean) {
  const w = await prisma.financeWatch.findUnique({ where: { categoryId } });
  if (!w) return false;
  const timeZone = await homeTimeZone();
  const month = wallTime(new Date(), timeZone).slice(0, 7);
  if (paused && !w.pausedSince) {
    await prisma.financeWatch.update({ where: { categoryId }, data: { pausedSince: month } });
  } else if (!paused && w.pausedSince) {
    // Resuming moves the start later by the months spent paused, so the next step is the one that was due.
    const held = Math.max(0, monthsBetween(w.pausedSince, month));
    await prisma.financeWatch.update({ where: { categoryId }, data: { startMonth: shift(w.startMonth, held), pausedSince: null } });
  }
  return true;
}
