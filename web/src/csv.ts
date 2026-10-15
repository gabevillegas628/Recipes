/**
 * Reads a bank's transaction download (CSV) into date / amount / description
 * rows. Banks name and arrange columns differently: one signed "Amount" column,
 * or separate "Debit"/"Credit" (or "Withdrawals"/"Deposits") columns; some put
 * notes above the header or below the data. Signs are left as the file has them
 * (with debit columns counted as negative); the server compares them with
 * SimpleFIN's and says whether to flip.
 */

export interface CsvRow {
  date: string;
  amount: number;
  description: string;
}

export interface CsvResult {
  rows: CsvRow[];
  /** The columns used, for showing what was read. */
  columns: { date: string; description: string; amount: string };
  /** Lines that looked like data but couldn't be read. */
  skipped: number;
}

/** Splits CSV text into rows of cells, handling quotes, "" escapes and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

// Earlier names win: the purchase date over the posting date.
const DATE = ['transactiondate', 'transdate', 'date', 'rundate', 'tradedate', 'postdate', 'posteddate', 'postingdate', 'settlementdate'];
// Fidelity's "Action" says what happened; its "Description" is only the security's name.
const DESCRIPTION = ['action', 'description', 'transactiondescription', 'payee', 'merchant', 'name', 'details', 'memo'];
const AMOUNT = ['amount', 'transactionamount', 'amountusd'];
const DEBIT = ['debit', 'debits', 'withdrawal', 'withdrawals', 'debitamount', 'charge', 'charges'];
const CREDIT = ['credit', 'credits', 'deposit', 'deposits', 'creditamount', 'payment', 'payments'];

function find(header: string[], names: string[]): number {
  for (const name of names) {
    const i = header.findIndex((h) => norm(h) === name);
    if (i >= 0) return i;
  }
  return -1;
}

/** "$1,234.56", "-12.00", "(12.00)", "+5" → number; "" → 0; junk → NaN. */
export function parseAmount(s: string): number {
  const t = s.replace(/[$,\s]/g, '');
  if (!t) return 0;
  const negative = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[()]/g, ''));
  return negative ? -n : n;
}

/** "03/14/2026", "3/14/26", "2026-03-14" → "2026-03-14"; anything else → null. */
export function parseDate(s: string): string | null {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function readTransactions(text: string): CsvResult {
  const table = parseCsv(text.replace(/^﻿/, ''));
  // The header is the first line with a date column and an amount (or debit/credit) column.
  const at = table.findIndex(
    (r) => find(r, DATE) >= 0 && (find(r, AMOUNT) >= 0 || (find(r, DEBIT) >= 0 && find(r, CREDIT) >= 0)),
  );
  if (at < 0) {
    throw new Error("Couldn't find the columns in this file. It needs a date column and an amount (or debit and credit) column.");
  }
  const header = table[at];
  const dateCol = find(header, DATE);
  const descCol = find(header, DESCRIPTION);
  const amountCol = find(header, AMOUNT);
  const debitCol = amountCol < 0 ? find(header, DEBIT) : -1;
  const creditCol = amountCol < 0 ? find(header, CREDIT) : -1;

  const rows: CsvRow[] = [];
  let skipped = 0;
  for (const r of table.slice(at + 1)) {
    const date = parseDate(r[dateCol] ?? '');
    // Notes and totals after the data have no date; leave them out quietly.
    if (!date) continue;
    const amount =
      amountCol >= 0
        ? parseAmount(r[amountCol] ?? '')
        : Math.abs(parseAmount(r[creditCol] ?? '')) - Math.abs(parseAmount(r[debitCol] ?? ''));
    if (!Number.isFinite(amount)) {
      skipped++;
      continue;
    }
    const description = (descCol >= 0 ? r[descCol] : '') || '(no description)';
    rows.push({ date, amount: Math.round(amount * 100) / 100, description: description.slice(0, 500) });
  }
  return {
    rows,
    columns: {
      date: header[dateCol],
      description: descCol >= 0 ? header[descCol] : '—',
      amount: amountCol >= 0 ? header[amountCol] : `${header[creditCol]} − ${header[debitCol]}`,
    },
    skipped,
  };
}
