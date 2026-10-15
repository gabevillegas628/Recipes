import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import type { FinanceAccountKind, FinanceKind } from '../generated/prisma/client.js';
import { merchantKey } from './merchantKey.js';

/**
 * Sorts every transaction into spending (with a category), income, a transfer
 * between our own accounts, or saving. Runs after each sync or import and after
 * a correction.
 *
 * 1. Transfers are found by matching amounts: -$1,500 leaving checking and
 *    +$1,500 arriving on the Citi card within a few days is one card payment.
 *    What the other account is decides the rest: a loan payment is spending (a
 *    car payment), money into savings or Fidelity is saving, anything else
 *    between our accounts doesn't count.
 * 2. Everything else goes by merchant. Each merchant is read by AI once and
 *    remembered (FinanceMerchant), and a correction by hand applies to every
 *    store with the same name, past and future.
 * 3. Anything still unsettled (Zelle to a person, a merchant the AI wasn't sure
 *    of) is marked needsLook for the review list.
 * Transactions set by hand (byHand) are left alone.
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;
const effortFor = (model: string) => (model.startsWith('claude-haiku') ? {} : { effort: 'low' as const });

/** A card payment can take a few days to show on both sides. */
const PAIR_DAYS = 5;
const DAY = 86_400_000;
const BATCH = 60;

const BANK: FinanceAccountKind[] = ['CHECKING', 'SAVINGS', 'OTHER'];
/** Where money sits to be spent from; moving it to savings or investments is saving. */
const EVERYDAY: FinanceAccountKind[] = ['CHECKING', 'OTHER'];
const SAVED: FinanceAccountKind[] = ['SAVINGS', 'INVESTMENT'];

// ---------- Running ----------

let current: Promise<void> | null = null;
let queued: Promise<void> | null = null;

/** Sorts everything; resolves once a run that started after this call has finished. Overlapping calls share runs. */
export function classify(): Promise<void> {
  if (queued) return queued;
  if (!current) return (current = run().finally(() => (current = null)));
  queued = current.then(() => {
    queued = null;
    return (current = run().finally(() => (current = null)));
  });
  return queued;
}

async function run() {
  try {
    await assignKeys();
    await readMerchants();
    await pairTransfers();
    await resolve();
  } catch (err) {
    console.error('Sorting transactions failed:', err);
  }
}

// ---------- 1. Merchant keys ----------

async function assignKeys() {
  const unkeyed = await prisma.financeTransaction.findMany({
    where: { merchantKey: null },
    select: { id: true, description: true, payee: true },
  });
  if (!unkeyed.length) return;
  const ids = unkeyed.map((t) => t.id);
  const keys = unkeyed.map((t) => merchantKey(t.description, t.payee));
  await prisma.$executeRaw`
    UPDATE "FinanceTransaction" AS t SET "merchantKey" = v.key
    FROM unnest(${ids}::text[], ${keys}::text[]) AS v(id, key)
    WHERE t.id = v.id`;
}

// ---------- 2. Merchants, read by AI ----------

const KINDS = ['spending', 'income', 'transfer', 'saving'] as const;
const KIND_OF: Record<(typeof KINDS)[number], FinanceKind> = {
  spending: 'SPENDING',
  income: 'INCOME',
  transfer: 'TRANSFER',
  saving: 'SAVING',
};

const merchantResult = z.object({
  merchants: z.array(
    z.object({
      index: z.number().int(),
      name: z.string().describe('The merchant as people say it: "Kroger", "Shell", "Netflix", "Zelle from Maria Lopez"'),
      kind: z.enum(KINDS),
      category: z.string().describe('For spending: one category name exactly as listed. Otherwise empty.'),
      unsure: z.boolean().describe("Can't tell what this is or what it was for"),
    }),
  ),
});

function merchantSystem(
  accounts: { institution: string; name: string; kind: string }[],
  categories: { name: string; fixed: boolean }[],
  names: string[],
) {
  return `You sort a household's bank and card transactions. Each numbered line is one merchant: a cleaned-up description, an example of the original, and which way the money went.

Their accounts:
${accounts.map((a) => `- ${a.institution}: ${a.name} (${a.kind.toLowerCase().replace('_', ' ')})`).join('\n')}

Spending categories:
${categories.map((c) => `- ${c.name}${c.fixed ? ' (fixed cost)' : ''}`).join('\n')}

For each merchant give:
- name: the merchant as people say it, the chain name without store numbers or city ("KROGER MASON" is "Kroger", "AMZN MKTP" and "AMAZON.COM" are both "Amazon"). One name per merchant, every time: if it's one of the names already in use (listed below), use that name exactly. For payments between people (Zelle, Venmo, Cash App, PayPal to a person), keep the person: "Zelle from Maria Lopez", "Venmo to J Smith".
- kind:
  - spending: purchases and bills. Refunds and credits from a store are spending too (same category as its purchases).
  - income: paychecks and direct deposits from employers, interest, dividends paid to checking, tax refunds, government benefits.
  - transfer: paying one of the credit cards above, moving money between their own accounts, card-side "payment, thank you" credits.
  - saving: putting money into savings, a brokerage or retirement account (Fidelity, Vanguard and the like).
  - A payment on an auto loan or mortgage is spending (car payments, or housing), not a transfer. Only call it a loan payment when the description says loan, auto or mortgage: at a bank where they also have cards, a plain "MOBILE PMT" or "AUTOPAY" is a card payment (transfer).
- category (spending only, exactly as listed): warehouse clubs (Costco, Sam's Club, BJ's) are groceries, but their gas stations are gas. Amazon in any form goes in "Amazon" if listed. Streaming, software and memberships billed monthly go in "Subscriptions" if listed. Phone, internet, power, water and gas service are utilities.
- unsure: true for payments between people (Zelle, Venmo, Cash App), ATM and cash withdrawals, checks, and anything you can't identify. Still give your best kind and category.
${names.length ? `\nMerchant names already in use:\n${names.join('\n')}` : ''}`;
}

/** Reads merchants that aren't known yet. A new store of a chain already corrected by hand takes that correction. */
async function readMerchants() {
  const known = new Set((await prisma.financeMerchant.findMany({ select: { key: true } })).map((m) => m.key));
  const txns = await prisma.financeTransaction.findMany({
    where: { merchantKey: { not: null } },
    select: { merchantKey: true, description: true, amount: true, account: { select: { kind: true, name: true } } },
    orderBy: { transactedAt: 'desc' },
  });
  const missing = new Map<string, { example: string; ways: Set<string> }>();
  for (const t of txns) {
    const key = t.merchantKey!;
    if (known.has(key)) continue;
    const entry = missing.get(key) ?? { example: t.description, ways: new Set<string>() };
    entry.ways.add(direction(t.account.kind, t.amount.isNegative(), t.account.name));
    missing.set(key, entry);
  }
  if (!missing.size || !client) return;

  const [accounts, categories, byHand, named] = await Promise.all([
    prisma.financeAccount.findMany({ select: { institution: true, name: true, kind: true } }),
    prisma.financeCategory.findMany({ orderBy: { position: 'asc' } }),
    prisma.financeMerchant.findMany({ where: { byHand: true } }),
    prisma.financeMerchant.findMany({ distinct: ['name'], select: { name: true } }),
  ]);
  const categoryId = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const handByName = new Map(byHand.map((m) => [m.name.toLowerCase(), m]));
  const names = new Set(named.map((m) => m.name));

  const entries = [...missing.entries()];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    // Names from earlier batches too, so one merchant keeps one name.
    const system = merchantSystem(accounts, categories, [...names].sort());
    const read = await readBatch(system, batch.map(([key, e]) => `${key} | e.g. "${e.example}" | ${[...e.ways].join('; ')}`));
    const rows = batch.flatMap(([key], j) => {
      const r = read.get(j);
      if (!r) return [];
      const name = r.name.trim() || key;
      const hand = handByName.get(name.toLowerCase());
      if (hand) return [{ key, name: hand.name, kind: hand.kind, categoryId: hand.categoryId, unsure: false, byHand: true }];
      const kind = KIND_OF[r.kind];
      const category = kind === 'SPENDING' ? (categoryId.get(r.category.trim().toLowerCase()) ?? null) : null;
      return [{ key, name, kind, categoryId: category, unsure: r.unsure || (kind === 'SPENDING' && !category), byHand: false }];
    });
    for (const r of rows) names.add(r.name);
    if (rows.length) await prisma.financeMerchant.createMany({ data: rows, skipDuplicates: true });
  }
}

function direction(kind: FinanceAccountKind, out: boolean, account: string) {
  if (kind === 'CREDIT_CARD') return out ? `charge on ${account}` : `credit to ${account} (payment or refund)`;
  if (kind === 'LOAN') return out ? `added to ${account}` : `paid toward ${account}`;
  if (kind === 'INVESTMENT') return out ? `out of ${account}` : `into ${account}`;
  return out ? `money out of ${account}` : `money into ${account}`;
}

async function readBatch(system: string, lines: string[]) {
  const out = new Map<number, z.infer<typeof merchantResult>['merchants'][number]>();
  try {
    const response = await client!.messages.parse({
      model: env.financeModel,
      max_tokens: 8000,
      output_config: { format: zodOutputFormat(merchantResult), ...effortFor(env.financeModel) },
      system,
      messages: [{ role: 'user', content: lines.map((l, i) => `${i}. ${l}`).join('\n') }],
    });
    console.info(
      JSON.stringify({
        msg: 'ai merchants',
        model: response.model,
        merchants: lines.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }),
    );
    for (const m of response.parsed_output?.merchants ?? []) if (m.index >= 0 && m.index < lines.length) out.set(m.index, m);
  } catch (err) {
    console.warn('Reading merchants failed:', (err as Error).message);
  }
  return out;
}

// ---------- 3. Transfers between our accounts ----------

/** Whether money leaving an account of one kind can be the same money arriving at another. Card purchases never are. */
function canPair(from: FinanceAccountKind, to: FinanceAccountKind) {
  if (BANK.includes(from)) return true;
  return from === 'INVESTMENT' && BANK.includes(to);
}

async function pairTransfers() {
  const open = await prisma.financeTransaction.findMany({
    where: { pairId: null, pending: false },
    select: { id: true, accountId: true, amount: true, transactedAt: true, account: { select: { kind: true } } },
    orderBy: { transactedAt: 'asc' },
  });
  const incoming = new Map<string, typeof open>();
  for (const t of open) {
    if (!t.amount.isPositive()) continue;
    const cents = t.amount.toFixed(2);
    incoming.set(cents, [...(incoming.get(cents) ?? []), t]);
  }
  const taken = new Set<string>();
  const a: string[] = [];
  const b: string[] = [];
  for (const out of open) {
    if (!out.amount.isNegative()) continue;
    let best: (typeof open)[number] | null = null;
    for (const into of incoming.get(out.amount.negated().toFixed(2)) ?? []) {
      const gap = Math.abs(into.transactedAt.getTime() - out.transactedAt.getTime());
      if (taken.has(into.id) || into.accountId === out.accountId || gap > PAIR_DAYS * DAY) continue;
      if (!canPair(out.account.kind, into.account.kind)) continue;
      if (!best || gap < Math.abs(best.transactedAt.getTime() - out.transactedAt.getTime())) best = into;
    }
    if (best) {
      taken.add(best.id);
      a.push(out.id, best.id);
      b.push(best.id, out.id);
    }
  }
  if (!a.length) return;
  await prisma.$executeRaw`
    UPDATE "FinanceTransaction" AS t SET "pairId" = v.pair
    FROM unnest(${a}::text[], ${b}::text[]) AS v(id, pair)
    WHERE t.id = v.id`;
}

// ---------- 4. Settling each transaction ----------

interface Settled {
  kind: FinanceKind | null;
  categoryId: string | null;
  needsLook: boolean;
}

async function resolve() {
  const [txns, merchants, accounts] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: { byHand: false },
      select: {
        id: true,
        accountId: true,
        amount: true,
        merchantKey: true,
        pairId: true,
        kind: true,
        categoryId: true,
        needsLook: true,
      },
    }),
    prisma.financeMerchant.findMany(),
    prisma.financeAccount.findMany({ select: { id: true, kind: true } }),
  ]);
  const accountKind = new Map(accounts.map((a) => [a.id, a.kind]));
  const merchantByKey = new Map(merchants.map((m) => [m.key, m]));
  // A pair's other side may be byHand, so look up accounts of all transactions.
  const pairAccount = new Map(
    (
      await prisma.financeTransaction.findMany({
        where: { id: { in: txns.flatMap((t) => (t.pairId ? [t.pairId] : [])) } },
        select: { id: true, accountId: true },
      })
    ).map((t) => [t.id, accountKind.get(t.accountId)!]),
  );

  const ids: string[] = [];
  const kinds: (string | null)[] = [];
  const cats: (string | null)[] = [];
  const looks: boolean[] = [];
  for (const t of txns) {
    const merchant = t.merchantKey ? merchantByKey.get(t.merchantKey) : undefined;
    const s = settle(
      accountKind.get(t.accountId)!,
      t.amount.isNegative(),
      t.pairId ? (pairAccount.get(t.pairId) ?? null) : null,
      merchant,
    );
    if (s.kind !== t.kind || s.categoryId !== t.categoryId || s.needsLook !== t.needsLook) {
      ids.push(t.id);
      kinds.push(s.kind);
      cats.push(s.categoryId);
      looks.push(s.needsLook);
    }
  }
  if (!ids.length) return;
  await prisma.$executeRaw`
    UPDATE "FinanceTransaction" AS t
    SET "kind" = v.kind::"FinanceKind", "categoryId" = v.cat, "needsLook" = v.look, "updatedAt" = now()
    FROM unnest(${ids}::text[], ${kinds}::text[], ${cats}::text[], ${looks}::boolean[]) AS v(id, kind, cat, look)
    WHERE t.id = v.id`;
}

export function settle(
  account: FinanceAccountKind,
  out: boolean,
  pairedWith: FinanceAccountKind | null,
  merchant: { kind: FinanceKind | null; categoryId: string | null; unsure: boolean; byHand: boolean } | undefined,
): Settled {
  const plain = (kind: FinanceKind): Settled => ({ kind, categoryId: null, needsLook: false });
  // Loans and investments only matter from the checking side: the payment, the contribution.
  if (account === 'LOAN' || account === 'INVESTMENT') return plain('TRANSFER');

  if (pairedWith) {
    if (out && pairedWith === 'LOAN') {
      const categoryId = merchant?.kind === 'SPENDING' ? merchant.categoryId : null;
      return { kind: 'SPENDING', categoryId, needsLook: !categoryId };
    }
    if (EVERYDAY.includes(account) && SAVED.includes(pairedWith)) return plain('SAVING');
    return plain('TRANSFER');
  }

  if (!merchant?.kind) return { kind: null, categoryId: null, needsLook: true };
  const categoryId = merchant.kind === 'SPENDING' ? merchant.categoryId : null;
  return {
    kind: merchant.kind,
    categoryId,
    needsLook: (merchant.unsure && !merchant.byHand) || (merchant.kind === 'SPENDING' && !categoryId),
  };
}

// ---------- Corrections ----------

/**
 * Sets how a merchant is sorted, for every store sharing its name (and any
 * stores seen later), then re-sorts.
 */
export async function setMerchant(keys: string[], kind: FinanceKind, categoryId: string | null) {
  const named = await prisma.financeMerchant.findMany({ where: { key: { in: keys } }, select: { name: true } });
  const names = [...new Set(named.map((m) => m.name))];
  const sameName = await prisma.financeMerchant.findMany({ where: { name: { in: names } }, select: { key: true } });
  const all = [...new Set([...keys, ...sameName.map((m) => m.key)])];
  const data = { kind, categoryId: kind === 'SPENDING' ? categoryId : null, unsure: false, byHand: true };
  await prisma.$transaction(
    all.map((key) =>
      prisma.financeMerchant.upsert({ where: { key }, create: { key, name: names[0] ?? key, ...data }, update: data }),
    ),
  );
  await classify();
}

/** Sets one transaction by hand, or (kind null) hands it back to the merchant's sorting. */
export async function setTransaction(id: string, kind: FinanceKind | null, categoryId: string | null) {
  await prisma.financeTransaction.update({
    where: { id },
    data: kind
      ? { kind, categoryId: kind === 'SPENDING' ? categoryId : null, byHand: true, needsLook: false }
      : { byHand: false },
  });
  if (!kind) await classify();
}
