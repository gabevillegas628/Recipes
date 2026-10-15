/**
 * Check what SimpleFIN returns, before Mise stores anything.
 *   npm run simplefin:check            (accounts, balances, transaction counts)
 *   npm run simplefin:check -- --samples  (also 3 transaction descriptions per account)
 * Asks for a SimpleFIN setup token. Use a throwaway app connection made for this
 * check: the token is claimed (it only works once) and the access URL is not saved,
 * so delete that connection in SimpleFIN afterwards and make a fresh one for Mise.
 * Nothing is written to the database.
 */
import { createInterface } from 'node:readline';

const showSamples = process.argv.includes('--samples');
const DAYS = 90;

/** Reads a line without echoing it, so the token doesn't sit in the terminal. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    out._writeToOutput = (s) => {
      if (!muted) out.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = true;
  });
}

const token = await askHidden('Paste the SimpleFIN setup token (input is hidden): ');
if (!token) {
  console.error('No token given.');
  process.exit(1);
}

let claimUrl: string;
try {
  claimUrl = Buffer.from(token, 'base64').toString('utf8');
  new URL(claimUrl);
} catch {
  console.error("That doesn't look like a SimpleFIN setup token (it should be a long base64 string).");
  process.exit(1);
}

const claim = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
if (!claim.ok) {
  console.error(`Claiming the token failed (${claim.status}). It may already have been used; make a new one.`);
  process.exit(1);
}
const access = new URL((await claim.text()).trim());

// fetch() refuses URLs with credentials in them, so move them to a header.
const auth = Buffer.from(`${decodeURIComponent(access.username)}:${decodeURIComponent(access.password)}`).toString('base64');
access.username = '';
access.password = '';

const start = Math.floor(Date.now() / 1000) - DAYS * 24 * 60 * 60;
const accountsUrl = new URL(`${access.href.replace(/\/$/, '')}/accounts`);
accountsUrl.searchParams.set('start-date', String(start));
accountsUrl.searchParams.set('pending', '1');

const res = await fetch(accountsUrl, { headers: { Authorization: `Basic ${auth}` } });
if (!res.ok) {
  console.error(`Fetching accounts failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}

type Txn = { posted: number; amount: string; description: string; pending?: boolean; transacted_at?: number };
type Account = {
  id: string;
  name: string;
  balance: string;
  'available-balance'?: string;
  'balance-date': number;
  org?: { name?: string; domain?: string };
  conn_id?: string;
  transactions?: Txn[];
  holdings?: unknown[];
};
type Body = {
  errors?: string[];
  errlist?: { code?: string; msg?: string; conn_id?: string }[];
  connections?: { conn_id: string; name?: string; org_id?: string }[];
  accounts: Account[];
};
const body = (await res.json()) as Body;

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const connName = new Map((body.connections ?? []).map((c) => [c.conn_id, c.name ?? c.org_id ?? c.conn_id]));

const problems = [...(body.errors ?? []), ...(body.errlist ?? []).map((e) => `${e.code ?? ''} ${e.msg ?? ''}`.trim())];
if (problems.length) {
  console.log('\nSimpleFIN reported problems:');
  for (const p of problems) console.log(`  ! ${p}`);
}

console.log(`\n${body.accounts.length} accounts, transactions from the last ${DAYS} days:\n`);
for (const a of body.accounts) {
  const txns = a.transactions ?? [];
  const institution = a.org?.name ?? a.org?.domain ?? (a.conn_id ? connName.get(a.conn_id) : undefined) ?? '?';
  const posted = txns.filter((t) => !t.pending && t.posted > 0);
  const dates = posted.map((t) => t.posted).sort((x, y) => x - y);
  console.log(`${institution} — ${a.name}`);
  console.log(
    `  balance ${a.balance}${a['available-balance'] ? ` (available ${a['available-balance']})` : ''} as of ${day(a['balance-date'])}`,
  );
  console.log(
    `  ${txns.length} transactions (${txns.length - posted.length} pending)` +
      (dates.length ? `, ${day(dates[0])} to ${day(dates[dates.length - 1])}` : '') +
      `, ${txns.filter((t) => t.transacted_at).length} with a purchase date`,
  );
  if (a.holdings) console.log(`  ${a.holdings.length} holdings`);
  if (showSamples) for (const t of txns.slice(0, 3)) console.log(`    ${day(t.posted || t.transacted_at || 0)}  ${t.amount}  ${t.description}`);
  console.log('');
}
