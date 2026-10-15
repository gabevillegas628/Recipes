import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { connect, disconnect } from '../money/connection.js';
import { importHistory } from '../money/importHistory.js';
import { SimpleFinAuthError } from '../money/simplefin.js';
import { kickMoneySync, moneySyncRunning } from '../money/sync.js';

/** Settings → Money: connect SimpleFIN, see accounts, fix account types, import older history. */

const KINDS = ['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'LOAN', 'INVESTMENT', 'OTHER'] as const;

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
    return importHistory(id, rows, { flip, dryRun });
  });
}
