import { prisma } from '../db.js';
import { Prisma, type FinanceAccountKind } from '../generated/prisma/client.js';
import { wallTime } from '../zone.js';
import { connectionSecret, homeTimeZone } from './connection.js';
import { fetchAccounts, MAX_DAYS, SimpleFinAuthError, type SfAccount, type SfResponse } from './simplefin.js';

/**
 * Copies accounts, balances and transactions from SimpleFIN into Mise. Runs on a
 * timer (index.ts), after connecting, and from "Sync now". Each run re-reads the
 * last 30 days so pending charges are picked up once they post; the first run
 * also steps back 90 days at a time for whatever older history SimpleFIN has.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Pending charges can take a while to post, and amounts change when they do (tips). */
const RECENT_DAYS = 30;
/** How far the first sync reaches back, if SimpleFIN has that much. */
const BACKFILL_DAYS = 365;
/** The timer's runs skip a sync if the last one was this recent (deploys restart the server). */
export const SYNC_EVERY = 4 * 60 * 60 * 1000;

let running = false;
let again = false;

export const moneySyncRunning = () => running;

/** Starts a sync unless one is running. `ifOlderThan` skips it when the last sync was more recent. */
export function kickMoneySync(ifOlderThan?: number) {
  if (running) {
    again = true;
    return;
  }
  running = true;
  void sync(ifOlderThan)
    .catch((err) => console.error('Money sync crashed:', err))
    .finally(() => {
      running = false;
      if (again) {
        again = false;
        kickMoneySync();
      }
    });
}

async function sync(ifOlderThan?: number) {
  const connection = await prisma.financeConnection.findUnique({ where: { id: 'default' } });
  if (!connection || connection.error) return;
  if (ifOlderThan && connection.lastSyncAt && Date.now() - connection.lastSyncAt.getTime() < ifOlderThan) return;
  const accessUrl = connectionSecret(connection.accessUrl);
  const timeZone = await homeTimeZone();
  const now = new Date();

  try {
    const start = new Date(now.getTime() - (connection.lastSyncAt ? RECENT_DAYS : MAX_DAYS) * DAY);
    const recent = await fetchAccounts(accessUrl, start);
    await save(recent, timeZone, { start, end: now });

    let backfilledAt = connection.backfilledAt;
    if (!backfilledAt) {
      for (let back = MAX_DAYS; back < BACKFILL_DAYS; back += MAX_DAYS) {
        const end = new Date(now.getTime() - back * DAY);
        const older = await fetchAccounts(accessUrl, new Date(end.getTime() - MAX_DAYS * DAY), end);
        // An empty window means SimpleFIN has nothing further back.
        if (!older.accounts.some((a) => a.transactions?.length)) break;
        await save(older, timeZone);
      }
      backfilledAt = new Date();
    }

    await prisma.financeConnection.update({
      where: { id: 'default' },
      data: { lastSyncAt: now, backfilledAt, warnings: recent.problems, error: null },
    });
  } catch (err) {
    if (!(err instanceof SimpleFinAuthError)) throw err;
    await prisma.financeConnection.update({ where: { id: 'default' }, data: { error: err.message } });
  }
}

/**
 * Saves one response. With `window`, it's the latest one: balances are
 * recorded, and pending charges in that window that SimpleFIN no longer lists
 * are removed (they posted under a new id, or were dropped).
 */
async function save(response: SfResponse, timeZone: string, window?: { start: Date; end: Date }) {
  for (const sf of response.accounts) {
    const account = await saveAccount(sf, response.connections, timeZone, Boolean(window));
    await saveTransactions(account.id, sf, window);
  }
}

async function saveAccount(sf: SfAccount, connections: Map<string, string>, timeZone: string, current: boolean) {
  const institution =
    sf.org?.name || (sf.conn_id && connections.get(sf.conn_id)) || sf.org?.domain || 'Unknown institution';
  const balanceDate = new Date(sf['balance-date'] * 1000);
  const fields = {
    institution,
    name: sf.name,
    balance: sf.balance,
    availableBalance: sf['available-balance'] ?? null,
    balanceDate,
    holdings: sf.holdings?.length ? (sf.holdings as Prisma.InputJsonValue) : Prisma.DbNull,
  };
  const account = await prisma.financeAccount.upsert({
    where: { externalId: sf.id },
    create: { externalId: sf.id, kind: guessKind(sf), ...fields },
    update: current ? fields : {},
  });
  if (current) {
    const date = new Date(`${wallTime(balanceDate, timeZone).slice(0, 10)}T00:00:00Z`);
    await prisma.financeBalance.upsert({
      where: { accountId_date: { accountId: account.id, date } },
      create: { accountId: account.id, date, balance: sf.balance },
      update: { balance: sf.balance },
    });
  }
  return account;
}

async function saveTransactions(accountId: string, sf: SfAccount, window?: { start: Date; end: Date }) {
  const incoming = (sf.transactions ?? []).map((t) => ({
    accountId,
    externalId: t.id,
    // Pending charges have posted = 0.
    transactedAt: new Date((t.transacted_at || t.posted || Date.now() / 1000) * 1000),
    postedAt: t.posted ? new Date(t.posted * 1000) : null,
    amount: t.amount,
    description: t.description.trim(),
    payee: t.payee?.trim() || null,
    memo: t.memo?.trim() || null,
    pending: Boolean(t.pending) || !t.posted,
  }));
  const ids = incoming.map((t) => t.externalId);

  const existing = new Map(
    (
      await prisma.financeTransaction.findMany({
        where: { accountId, externalId: { in: ids } },
        select: { id: true, externalId: true, pending: true, amount: true, description: true, postedAt: true },
      })
    ).map((t) => [t.externalId, t]),
  );
  const fresh = incoming.filter((t) => !existing.has(t.externalId));
  if (fresh.length) await prisma.financeTransaction.createMany({ data: fresh, skipDuplicates: true });

  // Posted, or the amount changed (a tip added): update in place.
  for (const t of incoming) {
    const old = existing.get(t.externalId);
    if (
      old &&
      (old.pending !== t.pending ||
        !old.amount.equals(t.amount) ||
        old.description !== t.description ||
        old.postedAt?.getTime() !== t.postedAt?.getTime())
    ) {
      await prisma.financeTransaction.update({
        where: { id: old.id },
        data: { pending: t.pending, amount: t.amount, description: t.description, postedAt: t.postedAt, transactedAt: t.transactedAt },
      });
    }
  }

  if (window) {
    await prisma.financeTransaction.deleteMany({
      where: {
        accountId,
        source: 'simplefin',
        pending: true,
        transactedAt: { gte: window.start, lte: window.end },
        externalId: { notIn: ids },
      },
    });
  }
}

/** A first guess from the account's name, fixed by hand in Settings → Money when wrong. */
export function guessKind(sf: Pick<SfAccount, 'name' | 'holdings'>): FinanceAccountKind {
  if (sf.holdings?.length) return 'INVESTMENT';
  const name = sf.name.toLowerCase();
  if (/\b(loan|mortgage|heloc)\b/.test(name)) return 'LOAN';
  if (/visa|mastercard|master card|\bamex\b|american express|\bcard\b|discover|quicksilver|venture|savor|double cash|freedom|sapphire|rewards/.test(name)) {
    return 'CREDIT_CARD';
  }
  if (/\b(ira|roth|401\s?k?|403\s?b?|hsa|brokerage|individual|joint|tod|invest\w*)\b/.test(name)) return 'INVESTMENT';
  if (/saving|growth|money market|\bcd\b/.test(name)) return 'SAVINGS';
  return 'CHECKING';
}
