import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { classify, setMerchant, setTransaction } from '../money/classify.js';
import { connect, disconnect, homeTimeZone } from '../money/connection.js';
import { importHistory } from '../money/importHistory.js';
import { budgetPlan } from '../money/budget.js';
import { overview } from '../money/overview.js';
import { SimpleFinAuthError } from '../money/simplefin.js';
import { kickMoneySync, moneySyncRunning } from '../money/sync.js';
import { wallTime, zonedInstant } from '../zone.js';

/**
 * Settings → Money (connect SimpleFIN, accounts, older history, categories) and
 * the Money tab (transactions, the needs-a-look list, corrections).
 */

const KINDS = ['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'LOAN', 'INVESTMENT', 'OTHER'] as const;
const MONEY_KINDS = ['SPENDING', 'INCOME', 'TRANSFER', 'SAVING'] as const;

/** "2026-10" → the instants it starts and ends at, at home. */
function monthRange(month: string, timeZone: string) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { gte: zonedInstant(`${month}-01T00:00:00`, timeZone), lt: zonedInstant(`${next}-01T00:00:00`, timeZone) };
}

const money = (d: Prisma.Decimal | null | undefined) => d?.toNumber() ?? 0;
const round2 = (n: number) => Math.round(n * 100) / 100;

async function status() {
  const [connection, accounts, counts] = await Promise.all([
    prisma.financeConnection.findUnique({ where: { id: 'default' }, include: { connectedBy: { select: { name: true } } } }),
    prisma.financeAccount.findMany({ orderBy: [{ institution: 'asc' }, { name: 'asc' }] }),
    prisma.financeTransaction.groupBy({
      by: ['accountId', 'source'],
      _count: true,
      _min: { transactedAt: true },
      _max: { transactedAt: true },
    }),
  ]);
  return {
    connected: Boolean(connection),
    error: connection?.error ?? null,
    warnings: connection?.warnings ?? [],
    lastSyncAt: connection?.lastSyncAt ?? null,
    backfilledAt: connection?.backfilledAt ?? null,
    connectedBy: connection?.connectedBy?.name ?? null,
    syncing: moneySyncRunning(),
    accounts: accounts.map((a) => {
      const mine = counts.filter((c) => c.accountId === a.id);
      const firsts = mine.map((c) => c._min.transactedAt!).sort((x, y) => x.getTime() - y.getTime());
      const lasts = mine.map((c) => c._max.transactedAt!).sort((x, y) => y.getTime() - x.getTime());
      return {
        id: a.id,
        institution: a.institution,
        name: a.name,
        kind: a.kind,
        balance: a.balance.toNumber(),
        availableBalance: a.availableBalance?.toNumber() ?? null,
        balanceDate: a.balanceDate,
        holdings: Array.isArray(a.holdings) ? a.holdings.length : 0,
        transactions: mine.reduce((n, c) => n + c._count, 0),
        imported: mine.find((c) => c.source === 'csv')?._count ?? 0,
        firstDate: firsts[0] ?? null,
        lastDate: lasts[0] ?? null,
      };
    }),
  };
}

export async function moneyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/money', async () => status());

  app.post('/api/money/connect', async (request, reply) => {
    const parsed = z.object({ setupToken: z.string().trim().min(20) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Paste the setup token from SimpleFIN.' });
    try {
      await connect(parsed.data.setupToken, request.userId);
    } catch (err) {
      if (err instanceof SimpleFinAuthError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    kickMoneySync();
    return status();
  });

  app.post('/api/money/sync', async () => {
    kickMoneySync();
    return status();
  });

  app.delete('/api/money', async () => {
    await disconnect();
    return status();
  });

  app.put('/api/money/accounts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = z.object({ kind: z.enum(KINDS) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Pick an account type' });
    const updated = await prisma.financeAccount.updateMany({
      where: { id },
      data: { kind: parsed.data.kind, kindByHand: true },
    });
    if (!updated.count) return reply.code(404).send({ error: 'Account not found' });
    return status();
  });

  app.post('/api/money/accounts/:id/import', { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = z
      .object({
        rows: z
          .array(
            z.object({
              date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              amount: z.number().finite(),
              description: z.string().max(500),
            }),
          )
          .min(1)
          .max(20_000),
        flip: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Couldn't read the rows from that file." });
    if (!(await prisma.financeAccount.findUnique({ where: { id }, select: { id: true } }))) {
      return reply.code(404).send({ error: 'Account not found' });
    }
    const { rows, flip, dryRun } = parsed.data;
    const summary = await importHistory(id, rows, { flip, dryRun });
    if (!dryRun) void classify();
    return summary;
  });

  // ---------- Overview ----------

  app.get('/api/money/overview', async (request, reply) => {
    const parsed = z
      .object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
      })
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Bad month' });
    const ov = await overview(parsed.data.month);
    // Budgets are for the month under way; past months compare with their usual.
    return { ...ov, budget: ov.current ? await budgetPlan(ov) : null };
  });

  // ---------- Budget ----------

  const plan = async () => budgetPlan(await overview());

  app.get('/api/money/budget', async () => plan());

  app.put('/api/money/budget/settings', async (request, reply) => {
    const parsed = z
      .object({ income: z.number().nonnegative().max(10_000_000).nullable(), saving: z.number().nonnegative().max(10_000_000) })
      .partial()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Amounts must be zero or more' });
    await prisma.financeBudgetSettings.upsert({ where: { id: 'default' }, create: { id: 'default', ...parsed.data }, update: parsed.data });
    return plan();
  });

  /** A category's budget typed in, or (null) back to its bills or usual month. */
  app.put('/api/money/budget/categories/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = z.object({ amount: z.number().nonnegative().max(10_000_000).nullable() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Amounts must be zero or more' });
    if (!(await prisma.financeCategory.findUnique({ where: { id }, select: { id: true } }))) {
      return reply.code(404).send({ error: 'Category not found' });
    }
    const { amount } = parsed.data;
    if (amount === null) await prisma.financeBudget.deleteMany({ where: { categoryId: id } });
    else await prisma.financeBudget.upsert({ where: { categoryId: id }, create: { categoryId: id, amount }, update: { amount } });
    return plan();
  });

  /** Scales the everyday budgets so they fit in what income leaves after bills and saving. */
  app.post('/api/money/budget/fit', async (_request, reply) => {
    const current = await plan();
    const everyday = current.categories.filter((c) => !c.fixed && c.budget > 0);
    const room = current.totals.forEveryday;
    if (room <= 0) return reply.code(409).send({ error: 'Bills and saving already take all the income, so there’s nothing to fit everyday spending into.' });
    if (!everyday.length) return current;
    const ratio = room / current.totals.everyday;
    await prisma.$transaction(
      everyday.map((c) => {
        const amount = Math.max(0, Math.floor((c.budget * ratio) / 10) * 10);
        return prisma.financeBudget.upsert({ where: { categoryId: c.id }, create: { categoryId: c.id, amount }, update: { amount } });
      }),
    );
    return plan();
  });

  /** Everyday budgets back to the usual month. */
  app.delete('/api/money/budget/categories', async () => {
    const everyday = await prisma.financeCategory.findMany({ where: { fixed: false }, select: { id: true } });
    await prisma.financeBudget.deleteMany({ where: { categoryId: { in: everyday.map((c) => c.id) } } });
    return plan();
  });

  /** A found bill confirmed as monthly, set aside as not monthly, or (null) back to how it was found. */
  app.put('/api/money/bills', async (request, reply) => {
    const parsed = z.object({ name: z.string().min(1).max(200), state: z.enum(['keep', 'ignore']).nullable() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Bad bill' });
    const { name, state } = parsed.data;
    if (state === null) await prisma.financeBill.deleteMany({ where: { name } });
    else await prisma.financeBill.upsert({ where: { name }, create: { name, state }, update: { state, categoryId: null, amount: null, day: null } });
    return plan();
  });

  /** A bill that hasn't been charged yet (a new insurance policy). */
  app.post('/api/money/bills', async (request, reply) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(200),
        categoryId: z.string(),
        amount: z.number().positive().max(10_000_000),
        day: z.number().int().min(1).max(31).default(1),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A bill needs a name, a category and an amount' });
    const category = await prisma.financeCategory.findUnique({ where: { id: parsed.data.categoryId } });
    if (!category?.fixed) return reply.code(400).send({ error: 'Bills go in a fixed category' });
    const data = { ...parsed.data, state: 'added' };
    await prisma.financeBill.upsert({ where: { name: data.name }, create: data, update: data });
    return plan();
  });

  app.delete('/api/money/bills/:name', async (request) => {
    const { name } = z.object({ name: z.string() }).parse(request.params);
    await prisma.financeBill.deleteMany({ where: { name, state: 'added' } });
    return plan();
  });

  /** For the Today card: what's left of this month's budget, and the everyday category closest to (or furthest past) its own. */
  app.get('/api/money/today', async () => {
    const ov = await overview();
    if (!ov.typical && !ov.totals.spending) return null;
    const b = await budgetPlan(ov);
    // The biggest overspend (a trip with no budget counts); with none, the category nearest its budget.
    const everyday = b.categories
      .filter((c) => !c.fixed && (c.budget > 0 || c.spent > 0))
      .map((c) => ({ name: c.name, left: round2(c.budget - c.spent), share: c.budget > 0 ? c.spent / c.budget : Infinity }))
      .sort((x, y) => (x.left < 0 || y.left < 0 ? x.left - y.left : y.share - x.share));
    return {
      spent: ov.totals.spending,
      budget: b.totals.budget,
      left: round2(b.totals.budget - ov.totals.spending),
      day: ov.day,
      daysInMonth: ov.daysInMonth,
      tightest: everyday[0] ? { name: everyday[0].name, left: everyday[0].left } : null,
    };
  });

  // ---------- Transactions ----------

  /** A month's transactions and totals, or (with q) matches from any time. */
  app.get('/api/money/transactions', async (request, reply) => {
    const parsed = z
      .object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
        q: z.string().trim().max(100).optional(),
        kind: z.enum(MONEY_KINDS).optional(),
        categoryId: z.string().optional(),
        accountId: z.string().optional(),
      })
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Bad filter' });
    const { q, kind, categoryId, accountId } = parsed.data;
    const timeZone = await homeTimeZone();
    const month = parsed.data.month ?? wallTime(new Date(), timeZone).slice(0, 7);
    const range = monthRange(month, timeZone);

    const where: Prisma.FinanceTransactionWhereInput = {
      ...(q
        ? { OR: [{ description: { contains: q, mode: 'insensitive' } }, { merchantKey: { contains: q.toUpperCase() } }] }
        : { transactedAt: range }),
      ...(kind ? { kind } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(accountId ? { accountId } : {}),
    };
    const [txns, sums, needsLook] = await Promise.all([
      prisma.financeTransaction.findMany({
        where,
        orderBy: [{ transactedAt: 'desc' }, { id: 'asc' }],
        take: q ? 300 : 2000,
        include: { account: { select: { name: true, institution: true } }, category: { select: { name: true } } },
      }),
      prisma.financeTransaction.groupBy({ by: ['kind'], where: { transactedAt: range }, _sum: { amount: true } }),
      prisma.financeTransaction.count({ where: { needsLook: true } }),
    ]);
    const names = await merchantNames(txns);
    const sum = (k: string) => money(sums.find((x) => x.kind === k)?._sum.amount);
    return {
      month,
      // Spending and saving are money out, so flip them to read as positive.
      totals: { income: sum('INCOME'), spending: -sum('SPENDING'), saving: -sum('SAVING') },
      needsLook,
      transactions: txns.map((t) => ({
        id: t.id,
        date: wallTime(t.transactedAt, timeZone).slice(0, 10),
        merchant: (t.merchantKey && names.get(t.merchantKey)?.name) || t.description,
        merchantKey: t.merchantKey,
        description: t.description,
        account: t.account.name,
        institution: t.account.institution,
        amount: t.amount.toNumber(),
        kind: t.kind,
        categoryId: t.categoryId,
        category: t.category?.name ?? null,
        pending: t.pending,
        needsLook: t.needsLook,
        byHand: t.byHand,
        paired: Boolean(t.pairId),
      })),
    };
  });

  /** Unsettled transactions, one group per merchant, most frequent first. */
  app.get('/api/money/review', async () => {
    const timeZone = await homeTimeZone();
    const txns = await prisma.financeTransaction.findMany({
      where: { needsLook: true },
      orderBy: { transactedAt: 'desc' },
      include: { account: { select: { name: true } } },
    });
    const merchants = await merchantNames(txns);
    const groups = new Map<string, ReviewGroup>();
    for (const t of txns) {
      const m = t.merchantKey ? merchants.get(t.merchantKey) : undefined;
      const name = m?.name ?? t.merchantKey ?? t.description;
      const g: ReviewGroup = groups.get(name) ?? {
        name,
        keys: [],
        count: 0,
        total: 0,
        firstDate: '',
        lastDate: wallTime(t.transactedAt, timeZone).slice(0, 10),
        example: t.description,
        kind: m?.kind ?? null,
        categoryId: m?.categoryId ?? null,
        accounts: [],
        ids: [],
      };
      if (t.merchantKey && !g.keys.includes(t.merchantKey)) g.keys.push(t.merchantKey);
      if (!g.accounts.includes(t.account.name)) g.accounts.push(t.account.name);
      g.count++;
      g.total = Math.round((g.total + t.amount.toNumber()) * 100) / 100;
      g.firstDate = wallTime(t.transactedAt, timeZone).slice(0, 10);
      g.ids.push(t.id);
      groups.set(name, g);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || Math.abs(b.total) - Math.abs(a.total));
  });

  const decision = z.object({ kind: z.enum(MONEY_KINDS), categoryId: z.string().nullable().default(null) });

  /** How a merchant (every store with its name) is sorted, from now on and for the past. */
  app.put('/api/money/merchants', async (request, reply) => {
    const parsed = decision.extend({ keys: z.array(z.string().min(1)).min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Pick what this is' });
    const { keys, kind, categoryId } = parsed.data;
    if (kind === 'SPENDING' && !categoryId) return reply.code(400).send({ error: 'Pick a category' });
    await setMerchant(keys, kind, categoryId);
    return { ok: true };
  });

  /** One transaction by hand; kind null hands it back to its merchant's sorting. */
  app.put('/api/money/transactions/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = decision.extend({ kind: z.enum(MONEY_KINDS).nullable() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Pick what this is' });
    const { kind, categoryId } = parsed.data;
    if (kind === 'SPENDING' && !categoryId) return reply.code(400).send({ error: 'Pick a category' });
    if (!(await prisma.financeTransaction.findUnique({ where: { id }, select: { id: true } }))) {
      return reply.code(404).send({ error: 'Transaction not found' });
    }
    await setTransaction(id, kind, categoryId);
    return { ok: true };
  });

  // ---------- Categories ----------

  app.get('/api/money/categories', async () => categories());

  app.post('/api/money/categories', async (request, reply) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(40), fixed: z.boolean().default(false) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Give the category a name' });
    if (await nameTaken(parsed.data.name)) return reply.code(409).send({ error: 'There’s already a category with that name' });
    const last = await prisma.financeCategory.aggregate({ _max: { position: true } });
    await prisma.financeCategory.create({ data: { ...parsed.data, position: (last._max.position ?? -1) + 1 } });
    return categories();
  });

  app.patch('/api/money/categories/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = z
      .object({ name: z.string().trim().min(1).max(40).optional(), fixed: z.boolean().optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Give the category a name' });
    if (parsed.data.name && (await nameTaken(parsed.data.name, id))) {
      return reply.code(409).send({ error: 'There’s already a category with that name' });
    }
    const updated = await prisma.financeCategory.updateMany({ where: { id }, data: parsed.data });
    if (!updated.count) return reply.code(404).send({ error: 'Category not found' });
    return categories();
  });

  /** Deletes a category, first moving its transactions and merchants to another one. */
  app.delete('/api/money/categories/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { moveTo } = z.object({ moveTo: z.string().optional() }).parse(request.query);
    const used =
      (await prisma.financeTransaction.count({ where: { categoryId: id } })) +
      (await prisma.financeMerchant.count({ where: { categoryId: id } }));
    const target = moveTo && moveTo !== id ? await prisma.financeCategory.findUnique({ where: { id: moveTo } }) : null;
    if (used && !target) return reply.code(409).send({ error: 'Pick a category to move its transactions to' });
    await prisma.$transaction([
      ...(target
        ? [
            prisma.financeTransaction.updateMany({ where: { categoryId: id }, data: { categoryId: target.id } }),
            prisma.financeMerchant.updateMany({ where: { categoryId: id }, data: { categoryId: target.id } }),
          ]
        : []),
      prisma.financeCategory.deleteMany({ where: { id } }),
    ]);
    return categories();
  });
}

interface ReviewGroup {
  name: string;
  keys: string[];
  count: number;
  total: number;
  firstDate: string;
  lastDate: string;
  example: string;
  kind: string | null;
  categoryId: string | null;
  accounts: string[];
  ids: string[];
}

async function merchantNames(txns: { merchantKey: string | null }[]) {
  const keys = [...new Set(txns.flatMap((t) => (t.merchantKey ? [t.merchantKey] : [])))];
  const merchants = await prisma.financeMerchant.findMany({ where: { key: { in: keys } } });
  return new Map(merchants.map((m) => [m.key, m]));
}

async function categories() {
  const [list, counts] = await Promise.all([
    prisma.financeCategory.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
    prisma.financeTransaction.groupBy({ by: ['categoryId'], _count: true }),
  ]);
  return list.map((c) => ({ ...c, transactions: counts.find((x) => x.categoryId === c.id)?._count ?? 0 }));
}

const nameTaken = async (name: string, except?: string) =>
  Boolean(
    await prisma.financeCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(except ? { id: { not: except } } : {}) },
    }),
  );
