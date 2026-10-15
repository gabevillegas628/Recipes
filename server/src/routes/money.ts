import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { classify, setMerchant, setTransaction } from '../money/classify.js';
import { connect, disconnect, homeTimeZone } from '../money/connection.js';
import { importHistory } from '../money/importHistory.js';
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
    return overview(parsed.data.month);
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
