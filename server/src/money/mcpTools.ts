import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { wallTime, zonedInstant } from '../zone.js';
import { budgetPlan } from './budget.js';
import { homeTimeZone } from './connection.js';
import { overview } from './overview.js';
import { findCharges } from './recurring.js';

/**
 * Read-only money tools for the Claude connector, so a chat can answer "can
 * we afford a $4k trip in March?" or "what do we spend on dining out?". They
 * hand back summaries the app already works out; nothing here changes data.
 */

const ABOUT =
  "The household's money comes from their bank, card and Fidelity accounts, synced daily and sorted into spending (by category), income, saving and transfers between their own accounts (card payments, not counted). Amounts are US dollars; spending is positive.";

const month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe('"2026-09"; defaults to the current month');

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const whole = (n: number) => Math.round(n);

export function registerMoneyTools(server: McpServer, appUrl: string) {
  server.registerTool(
    'money_overview',
    {
      title: 'Money: a month at a glance',
      description: `${ABOUT} One month: money in, spent, saved and left over, against a usual month (the average of recent complete months) and, for the current month, the budget. Charges they marked one-off (a birthday dinner) count in spent but not in a category's usual habit or its budget; spending by category; and in vs. spent for the last 12 months (months marked partial are missing some accounts, so they undercount). Use it for "how are we doing this month" or "how did September go".`,
      inputSchema: { month: month.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ month: m }) => {
      const ov = await overview(m);
      const plan = ov.current ? await budgetPlan(ov) : null;
      const recap = ov.current ? null : await prisma.financeRecap.findUnique({ where: { month: ov.month } });
      return text({
        month: ov.month,
        daysSoFar: ov.current ? `${ov.day} of ${ov.daysInMonth}` : 'whole month',
        in: whole(ov.totals.income),
        spent: whole(ov.totals.spending),
        saved: whole(ov.totals.saving),
        leftOver: whole(ov.totals.income - ov.totals.spending),
        usualMonth: ov.typical
          ? {
              months: ov.typical.months,
              in: whole(ov.typical.income),
              spent: whole(ov.typical.spending),
              saved: whole(ov.typical.saving),
              spentByThisDay: ov.current && ov.pace.typical ? whole(ov.pace.typical[ov.day - 1]) : undefined,
            }
          : null,
        budget: plan ? { spendingThisMonth: whole(plan.totals.budget), planAddsUp: plan.totals.unplanned >= 0, unplannedOrShort: whole(plan.totals.unplanned) } : null,
        categories: ov.categories.map((c) => ({
          name: c.name,
          fixed: c.fixed,
          spent: whole(c.spent),
          ofWhichOneOffs: c.oneOffs ? whole(c.oneOffs) : undefined,
          usualHabit: c.typical === null ? null : whole(c.typical),
          budget: plan ? whole(plan.categories.find((p) => p.id === c.id)?.budget ?? 0) : undefined,
        })),
        lastTwelveMonths: ov.history.map((h) => ({ month: h.month, in: whole(h.income), spent: whole(h.spending), saved: whole(h.saving), partial: h.partial || undefined })),
        recap: recap ? { headline: recap.headline, points: recap.points } : undefined,
        link: `${appUrl}/money${ov.current ? '' : `?month=${ov.month}`}`,
      });
    },
  );

  server.registerTool(
    'money_budget',
    {
      title: 'Money: the budget',
      description: `${ABOUT} The monthly budget, set against income: expected income (their regular paychecks; bonuses aren't counted on) minus fixed bills (what they pay now) minus a saving goal leaves what everyday spending has to fit in. Shows each paycheck source, each bill, each category's budget and whether the plan adds up. Use it for "can we afford…" questions: what's unplanned (or short) each month is the room there is. They change the budget in the app, not through you.`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const plan = await budgetPlan(await overview());
      const categoryName = new Map(plan.categories.map((c) => [c.id, c.name]));
      return text({
        income: {
          expectedPerMonth: whole(plan.income.expected),
          typedInByThem: plan.income.byHand,
          paychecks: plan.income.sources.map((s) => ({ from: s.name, usual: whole(s.amount), perMonth: s.perMonth, monthly: whole(s.monthly), recentBonuses: whole(s.extra) })),
        },
        fixedBills: plan.bills
          .filter((b) => b.state === 'counted' || b.state === 'added')
          .map((b) => ({ name: b.name, category: categoryName.get(b.categoryId), monthly: whole(b.amount), aroundDay: b.day })),
        possibleNewBills: plan.bills.filter((b) => b.state === 'suggested').map((b) => ({ name: b.name, monthly: whole(b.amount) })),
        savingGoal: whole(plan.saving),
        oneOffsAndEvents: { plannedPerMonth: whole(plan.oneOffs.planned), usualPerMonth: plan.oneOffs.usual === null ? null : whole(plan.oneOffs.usual) },
        everyday: plan.categories
          .filter((c) => !c.fixed && (c.budget > 0 || c.spent > 0))
          .map((c) => ({
            name: c.name,
            budget: whole(c.budget),
            usualHabit: c.usual === null ? null : whole(c.usual),
            habitThisMonth: whole(c.spent),
            oneOffsThisMonth: c.oneOffs ? whole(c.oneOffs) : undefined,
            setByThem: c.from === 'hand',
          })),
        totals: {
          fixedBills: whole(plan.totals.fixed),
          everydayBudget: whole(plan.totals.everyday),
          leftForEveryday: whole(plan.totals.forEveryday),
          unplannedPerMonth: whole(plan.totals.unplanned),
          note: plan.totals.unplanned < 0 ? 'Negative: the plan spends more than comes in.' : undefined,
        },
        link: `${appUrl}/money/budget`,
      });
    },
  );

  server.registerTool(
    'money_by_category',
    {
      title: 'Money: spending by category over time',
      description: `${ABOUT} Spending in each category, month by month, for trends ("is dining out going up?", "what do we spend on groceries a month?"). Months marked partial are missing some accounts.`,
      inputSchema: {
        months: z.number().int().min(1).max(24).optional().describe('How many months back, including this one (default 6)'),
        category: z.string().optional().describe('Only this category (as named in the app)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ months = 6, category }) => {
      const ov = await overview();
      const timeZone = await homeTimeZone();
      const local = `(t."transactedAt" AT TIME ZONE 'UTC') AT TIME ZONE '${timeZone.replace(/'/g, '')}'`;
      const since = zonedInstant(`${shiftMonth(ov.month, -(months - 1))}-01T00:00:00`, timeZone);
      const rows = await prisma.$queryRawUnsafe<{ month: string; name: string; total: string }[]>(
        `SELECT to_char(${local}, 'YYYY-MM') AS month, c.name, (-sum(t.amount))::text AS total
         FROM "FinanceTransaction" t JOIN "FinanceCategory" c ON c.id = t."categoryId"
         WHERE t.kind = 'SPENDING' AND t."transactedAt" >= $1
         GROUP BY 1, 2 ORDER BY 1, 2`,
        since,
      );
      const wanted = category?.trim().toLowerCase();
      const partial = new Set(ov.history.filter((h) => h.partial).map((h) => h.month));
      const byMonth = new Map<string, Record<string, number>>();
      for (const r of rows) {
        if (wanted && r.name.toLowerCase() !== wanted) continue;
        byMonth.set(r.month, { ...(byMonth.get(r.month) ?? {}), [r.name]: whole(Number(r.total)) });
      }
      return text({
        months: [...byMonth.entries()].map(([m, spent]) => ({ month: m, partial: partial.has(m) || undefined, soFar: m === ov.month || undefined, spent })),
        categories: wanted ? undefined : (await prisma.financeCategory.findMany({ orderBy: { position: 'asc' } })).map((c) => c.name),
      });
    },
  );

  server.registerTool(
    'money_recurring',
    {
      title: 'Money: subscriptions and recurring charges',
      description: `${ABOUT} Every charge that repeats about monthly: bills, subscriptions, memberships, with what each costs, price rises (was) and ones that started in the last 45 days. Use it for "what subscriptions do we have?" or "what could we cut?".`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [charges, categories] = await Promise.all([findCharges(), prisma.financeCategory.findMany()]);
      const name = new Map(categories.map((c) => [c.id, c.name]));
      return text({
        totalPerMonth: whole(charges.reduce((n, c) => n + c.monthly, 0)),
        charges: charges.map((c) => ({
          name: c.name,
          category: c.categoryId ? name.get(c.categoryId) : null,
          amount: c.amount,
          wasBefore: c.was ?? undefined,
          perMonth: c.monthly,
          last: c.lastDate,
          new: c.isNew || undefined,
        })),
      });
    },
  );

  server.registerTool(
    'money_transactions',
    {
      title: 'Money: find transactions',
      description: `${ABOUT} Individual transactions, newest first: by words in the merchant or description, by month, category or kind. Use it for "how much did we spend at Costco this year?" or "what was that $600 charge?". Returns at most 100; totals cover everything that matched.`,
      inputSchema: {
        query: z.string().optional().describe('Words in the merchant or bank description'),
        month: month.optional().describe('"2026-09"; omit to search every month'),
        category: z.string().optional().describe('Category name as in the app'),
        kind: z.enum(['SPENDING', 'INCOME', 'SAVING', 'TRANSFER']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, month: m, category, kind, limit = 50 }) => {
      const timeZone = await homeTimeZone();
      const where: Prisma.FinanceTransactionWhereInput = {
        ...(kind ? { kind } : { kind: { not: 'TRANSFER' } }),
        ...(category ? { category: { name: { equals: category, mode: 'insensitive' } } } : {}),
        ...(m
          ? { transactedAt: { gte: zonedInstant(`${m}-01T00:00:00`, timeZone), lt: zonedInstant(`${shiftMonth(m, 1)}-01T00:00:00`, timeZone) } }
          : {}),
      };
      if (query?.trim()) {
        const q = query.trim();
        const merchants = await prisma.financeMerchant.findMany({ where: { name: { contains: q, mode: 'insensitive' } }, select: { key: true } });
        where.OR = [{ description: { contains: q, mode: 'insensitive' } }, { merchantKey: { in: merchants.map((x) => x.key) } }];
      }
      const [rows, sum, count] = await Promise.all([
        prisma.financeTransaction.findMany({
          where,
          orderBy: { transactedAt: 'desc' },
          take: limit,
          include: { category: { select: { name: true } }, account: { select: { name: true } } },
        }),
        prisma.financeTransaction.aggregate({ where, _sum: { amount: true } }),
        prisma.financeTransaction.count({ where }),
      ]);
      const names = new Map(
        (await prisma.financeMerchant.findMany({ where: { key: { in: rows.flatMap((t) => (t.merchantKey ? [t.merchantKey] : [])) } } })).map((x) => [x.key, x.name]),
      );
      return text({
        matched: count,
        // Spending is negative in the data; flip it so totals read the way people say them.
        netTotal: Math.round(-(sum._sum.amount?.toNumber() ?? 0) * 100) / 100,
        shown: rows.map((t) => ({
          date: wallTime(t.transactedAt, timeZone).slice(0, 10),
          merchant: (t.merchantKey && names.get(t.merchantKey)) || t.description,
          amount: Math.round(-t.amount.toNumber() * 100) / 100,
          kind: t.kind,
          category: t.category?.name ?? null,
          account: t.account.name,
          pending: t.pending || undefined,
        })),
        note: 'amount is positive for money spent and negative for money coming in.',
      });
    },
  );
}

function shiftMonth(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
