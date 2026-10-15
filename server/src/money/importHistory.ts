import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { wallTime, zonedInstant } from '../zone.js';
import { homeTimeZone } from './connection.js';
import { MAX_DAYS } from './simplefin.js';

/**
 * Older history from a bank's CSV download, for one account. The browser reads
 * the file (web/src/csv.ts) and sends rows. Rows from the days SimpleFIN already
 * covers are skipped, so nothing is counted twice; those same rows show whether
 * the file's signs match SimpleFIN's (banks disagree on whether a purchase is + or -).
 */

export interface HistoryRow {
  /** "2026-03-14" */
  date: string;
  /** As the file has it, before any sign flip. */
  amount: number;
  description: string;
}

export interface ImportSummary {
  rows: number;
  /** On or after the first day SimpleFIN has for this account (or the last 90 days, if it has none). */
  covered: number;
  /** Older rows not in Mise yet (on a dry run, would be added). */
  added: number;
  /** Older rows already imported from an earlier file. */
  duplicates: number;
  /** Compared with SimpleFIN on the overlapping days: whether this file's signs are the same or opposite. */
  signs: 'same' | 'opposite' | 'unknown';
  firstDate: string | null;
  lastDate: string | null;
}

const MATCH_DAYS = 3;

export async function importHistory(
  accountId: string,
  rows: HistoryRow[],
  options: { flip: boolean; dryRun: boolean },
): Promise<ImportSummary> {
  const timeZone = await homeTimeZone();
  const localDate = (d: Date) => wallTime(d, timeZone).slice(0, 10);

  const synced = await prisma.financeTransaction.findMany({
    where: { accountId, source: 'simplefin' },
    select: { transactedAt: true, amount: true },
  });
  // With nothing from SimpleFIN yet (an unused card), leave its usual 90 days to SimpleFIN anyway.
  const cutoff = localDate(
    synced.length
      ? new Date(Math.min(...synced.map((t) => t.transactedAt.getTime())))
      : new Date(Date.now() - MAX_DAYS * 86_400_000),
  );

  // Compare the overlap to SimpleFIN: same amount within a few days, which sign?
  const byAmount = new Map<string, { date: string; amount: number }[]>();
  for (const t of synced) {
    const amount = t.amount.toNumber();
    const key = Math.abs(amount).toFixed(2);
    byAmount.set(key, [...(byAmount.get(key) ?? []), { date: localDate(t.transactedAt), amount }]);
  }
  let same = 0;
  let opposite = 0;
  const covered = rows.filter((r) => r.date >= cutoff);
  for (const r of covered) {
    if (!r.amount) continue;
    const match = byAmount
      .get(Math.abs(r.amount).toFixed(2))
      ?.find((t) => Math.abs(Date.parse(t.date) - Date.parse(r.date)) <= MATCH_DAYS * 86_400_000);
    if (match) {
      if (Math.sign(match.amount) === Math.sign(r.amount)) same++;
      else opposite++;
    }
  }
  const signs = same + opposite < 3 ? 'unknown' : same >= opposite * 3 ? 'same' : opposite >= same * 3 ? 'opposite' : 'unknown';

  // Identical rows on the same day (two $5 coffees) are told apart by their order in the file.
  const seen = new Map<string, number>();
  const older = rows
    .filter((r) => r.date < cutoff)
    .map((r) => {
      const amount = options.flip ? -r.amount : r.amount;
      const base = `${r.date}|${amount.toFixed(2)}|${r.description.trim().toLowerCase()}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return {
        accountId,
        externalId: `csv:${createHash('sha256').update(`${base}|${n}`).digest('base64url').slice(0, 24)}`,
        transactedAt: zonedInstant(`${r.date}T12:00:00`, timeZone),
        amount: amount.toFixed(2),
        description: r.description.trim(),
        source: 'csv',
      };
    });

  const already = await prisma.financeTransaction.count({
    where: { accountId, externalId: { in: older.map((t) => t.externalId) } },
  });
  let added = older.length - already;
  if (!options.dryRun && older.length) {
    added = (await prisma.financeTransaction.createMany({ data: older, skipDuplicates: true })).count;
  }

  const dates = rows.map((r) => r.date).sort();
  return {
    rows: rows.length,
    covered: covered.length,
    added,
    duplicates: older.length - added,
    signs,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}
