import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { readTransactions, type CsvResult } from '../csv';
import type { FinanceAccount, FinanceAccountKind, FinanceCategory, ImportSummary, MoneyStatus } from '../types';

const KINDS: { value: FinanceAccountKind; label: string }[] = [
  { value: 'CHECKING', label: 'Checking' },
  { value: 'SAVINGS', label: 'Savings' },
  { value: 'CREDIT_CARD', label: 'Credit card' },
  { value: 'LOAN', label: 'Loan' },
  { value: 'INVESTMENT', label: 'Investment' },
  { value: 'OTHER', label: 'Other' },
];

const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const shortDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

function ago(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : shortDate(iso);
}

/** Settings → Money: connect SimpleFIN, see what came in, fix account types, import older history. */
export function MoneySection() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['money'],
    queryFn: api.moneyStatus,
    refetchInterval: (q) => (q.state.data?.syncing ? 3000 : false),
  });
  const onStatus = (next: MoneyStatus) => queryClient.setQueryData(['money'], next);
  const sync = useMutation({ mutationFn: api.syncMoney, onSuccess: onStatus });
  const disconnect = useMutation({ mutationFn: api.disconnectMoney, onSuccess: onStatus });

  const s = status.data;
  if (!s) return status.error ? <p className="error">{status.error.message}</p> : null;

  const institutions = [...new Set(s.accounts.map((a) => a.institution))];

  return (
    <section className="settings-section">
      <h2>Bank connection</h2>
      {!s.connected ? (
        <>
          <p>
            Mise reads your bank, card and investment accounts through SimpleFIN Bridge. It can only read: it
            can’t move money or pay anything.
          </p>
          <ol className="steps">
            <li>
              In SimpleFIN Bridge, open <strong>Apps</strong> and create a new connection (call it “Mise”).
            </li>
            <li>Copy the setup token it shows and paste it below. It works once, and only here.</li>
          </ol>
          <ConnectForm onStatus={onStatus} label="Connect" />
        </>
      ) : s.error ? (
        <>
          <div className="banner">{s.error}</div>
          <ConnectForm onStatus={onStatus} label="Reconnect" />
        </>
      ) : (
        <>
          <p className="connector-status">
            <span className="dot dot-on" />
            {s.syncing
              ? s.backfilledAt
                ? 'Syncing…'
                : 'First sync: reaching back for older history. This can take a minute.'
              : s.lastSyncAt
                ? `Synced ${ago(s.lastSyncAt)}`
                : 'Connected'}
          </p>
          <p className="muted small">
            Syncs every few hours{s.connectedBy ? `. Connected by ${s.connectedBy}` : ''}. Banks update SimpleFIN
            about once a day, so new charges can take a day to show up.
          </p>
          {s.warnings.length > 0 && (
            <div className="banner">
              <strong>SimpleFIN says:</strong>
              <ul className="money-warnings">
                {s.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              Fix these in SimpleFIN Bridge (usually signing in to the bank again).
            </div>
          )}
          {sync.error && <p className="error">{sync.error.message}</p>}
        </>
      )}

      {s.accounts.length > 0 && (
        <>
          <h3>Accounts</h3>
          <p className="muted small">
            Check each account’s type: it decides whether money moving in and out counts as spending, a card
            payment or savings.
          </p>
          {institutions.map((inst) => (
            <div key={inst} className="money-institution">
              <h4>{inst}</h4>
              <ul className="money-accounts">
                {s.accounts
                  .filter((a) => a.institution === inst)
                  .map((a) => (
                    <AccountRow key={a.id} account={a} onStatus={onStatus} />
                  ))}
              </ul>
            </div>
          ))}
        </>
      )}

      {s.connected && (
        <div className="settings-actions">
          <button type="button" className="btn" disabled={s.syncing || sync.isPending} onClick={() => sync.mutate()}>
            {s.syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={disconnect.isPending}
            onClick={() =>
              confirm(
                'Disconnect SimpleFIN? Mise stops getting new transactions. What it already has stays. To reconnect, you’ll need a new setup token.',
              ) && disconnect.mutate()
            }
          >
            Disconnect
          </button>
        </div>
      )}
    </section>
  );
}

function ConnectForm({ onStatus, label }: { onStatus: (s: MoneyStatus) => void; label: string }) {
  const [token, setToken] = useState('');
  const connect = useMutation({
    mutationFn: (t: string) => api.connectMoney(t),
    onSuccess: (next) => {
      setToken('');
      onStatus(next);
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (token.trim()) connect.mutate(token.trim());
  }
  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>SimpleFIN setup token</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste it here"
        />
        <small>Treat it like a password. Don’t paste it anywhere else.</small>
      </label>
      {connect.error && <p className="error">{connect.error.message}</p>}
      <div className="settings-actions">
        <button className="btn btn-primary" disabled={!token.trim() || connect.isPending}>
          {connect.isPending ? 'Connecting…' : label}
        </button>
      </div>
    </form>
  );
}

function AccountRow({ account: a, onStatus }: { account: FinanceAccount; onStatus: (s: MoneyStatus) => void }) {
  const [importing, setImporting] = useState(false);
  const setKind = useMutation({
    mutationFn: (kind: FinanceAccountKind) => api.setAccountKind(a.id, kind),
    onSuccess: onStatus,
  });
  // Capital One sends 0 for every balance; don't present that as real.
  const noBalance = a.balance === 0 && a.transactions > 0 && (a.kind === 'CREDIT_CARD' || a.kind === 'LOAN');

  return (
    <li className="money-account">
      <div className="money-account-head">
        <span className="money-account-name">{a.name}</span>
        <span className={noBalance ? 'muted' : ''}>{noBalance ? 'balance not reported' : money(a.balance)}</span>
      </div>
      <div className="money-account-meta">
        <select
          value={a.kind}
          disabled={setKind.isPending}
          onChange={(e) => setKind.mutate(e.target.value as FinanceAccountKind)}
          aria-label={`Type of ${a.name}`}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="muted small">
          {a.transactions
            ? `${a.transactions.toLocaleString()} transaction${a.transactions === 1 ? '' : 's'} since ${shortDate(a.firstDate!)}`
            : 'No transactions yet'}
          {a.imported > 0 && ` (${a.imported.toLocaleString()} imported)`}
          {a.holdings > 0 && ` · ${a.holdings} holdings`}
        </span>
      </div>
      {setKind.error && <p className="error">{setKind.error.message}</p>}
      {importing ? (
        <ImportHistory account={a} onDone={() => setImporting(false)} />
      ) : (
        <button type="button" className="btn btn-small money-import-btn" onClick={() => setImporting(true)}>
          Import older history (CSV)
        </button>
      )}
    </li>
  );
}

/**
 * One bank download for one account. Reads the file here, asks the server what
 * importing it would do (and whether its signs match SimpleFIN's), then imports.
 */
function ImportHistory({ account, onDone }: { account: FinanceAccount; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<{ name: string; csv: CsvResult } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [flip, setFlip] = useState(false);
  const [done, setDone] = useState<ImportSummary | null>(null);

  const preview = useMutation({
    mutationFn: (rows: CsvResult['rows']) => api.importHistory(account.id, rows, { flip: false, dryRun: true }),
    onSuccess: (p) => setFlip(p.signs === 'opposite'),
  });
  const save = useMutation({
    mutationFn: () => api.importHistory(account.id, file!.csv.rows, { flip, dryRun: false }),
    onSuccess: (r) => {
      setDone(r);
      queryClient.invalidateQueries({ queryKey: ['money'] });
    },
  });

  async function pick(f: File | undefined) {
    setReadError(null);
    setFile(null);
    setDone(null);
    preview.reset();
    if (!f) return;
    try {
      const csv = readTransactions(await f.text());
      if (!csv.rows.length) throw new Error('No transactions found in that file.');
      setFile({ name: f.name, csv });
      preview.mutate(csv.rows);
    } catch (err) {
      setReadError((err as Error).message);
    }
  }

  const p = preview.data;
  const samples = file?.csv.rows.filter((r) => r.amount !== 0).slice(0, 4) ?? [];
  const purchaseWord = account.kind === 'CREDIT_CARD' ? 'Purchases' : 'Money going out';

  return (
    <div className="money-import">
      {done ? (
        <p>
          Added {done.added.toLocaleString()} older transaction{done.added === 1 ? '' : 's'}
          {done.duplicates > 0 && ` (${done.duplicates.toLocaleString()} were already in Mise)`}.
        </p>
      ) : (
        <>
          <p className="muted small">
            Download this account’s transactions as CSV from the bank’s website. Days SimpleFIN already has are
            skipped, so overlapping files are fine.
          </p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
          {readError && <p className="error">{readError}</p>}
          {preview.error && <p className="error">{preview.error.message}</p>}
          {file && p && (
            <div className="money-import-preview">
              <p>
                {p.rows.toLocaleString()} rows, {shortDate(p.firstDate!)} to {shortDate(p.lastDate!)}, from the
                columns <em>{file.csv.columns.date}</em>, <em>{file.csv.columns.description}</em> and{' '}
                <em>{file.csv.columns.amount}</em>.
                {file.csv.skipped > 0 && ` ${file.csv.skipped} rows couldn’t be read.`}
              </p>
              <p>
                {p.covered > 0 && `${p.covered.toLocaleString()} are on days SimpleFIN already has. `}
                {p.added > 0
                  ? `${p.added.toLocaleString()} older ones will be added.`
                  : 'Nothing older to add.'}
                {p.duplicates > 0 && ` ${p.duplicates.toLocaleString()} were imported before.`}
              </p>
              {p.added > 0 && (
                <>
                  {p.signs === 'unknown' ? (
                    <label className="checkbox">
                      <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} />
                      This file shows {purchaseWord.toLowerCase()} as positive numbers
                    </label>
                  ) : (
                    <p className="muted small">
                      {p.signs === 'opposite'
                        ? 'This file’s plus and minus are the opposite of SimpleFIN’s, so they’ll be flipped.'
                        : 'Its plus and minus match SimpleFIN’s.'}
                    </p>
                  )}
                  <p className="muted small">{purchaseWord} should show as minus:</p>
                  <ul className="money-samples">
                    {samples.map((r, i) => (
                      <li key={i}>
                        <span>{shortDate(r.date)}</span>
                        <span className="money-sample-desc">{r.description}</span>
                        <span>{money(flip ? -r.amount : r.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {save.error && <p className="error">{save.error.message}</p>}
            </div>
          )}
        </>
      )}
      <div className="settings-actions">
        {!done && p && p.added > 0 && (
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Importing…' : `Import ${p.added.toLocaleString()}`}
          </button>
        )}
        <button type="button" className="btn" onClick={onDone}>
          {done ? 'Done' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

/** Settings → Money → Categories: rename, fixed or flexible, add, delete (moving what's in it). */
export function CategoriesSection() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['money-categories'], queryFn: api.moneyCategories });
  const onList = (next: FinanceCategory[]) => {
    queryClient.setQueryData(['money-categories'], next);
    queryClient.invalidateQueries({ queryKey: ['money-txns'] });
  };
  const [name, setName] = useState('');
  const [fixed, setFixed] = useState(false);
  const add = useMutation({
    mutationFn: () => api.addCategory(name.trim(), fixed),
    onSuccess: (next) => {
      onList(next);
      setName('');
      setFixed(false);
    },
  });

  if (!list.data) return null;
  return (
    <section className="settings-section">
      <h3>Categories</h3>
      <p className="muted small">
        What spending is sorted into. Fixed costs are the same most months (insurance, car payments); flexible ones are
        where the choices are.
      </p>
      <ul className="money-categories">
        {list.data.map((c) => (
          <CategoryRow key={c.id} category={c} all={list.data} onList={onList} />
        ))}
      </ul>
      <form
        className="money-category-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category" maxLength={40} />
        <label className="checkbox">
          <input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} />
          Fixed
        </label>
        <button className="btn" disabled={!name.trim() || add.isPending}>
          Add
        </button>
      </form>
      {add.error && <p className="error">{add.error.message}</p>}
    </section>
  );
}

function CategoryRow({
  category: c,
  all,
  onList,
}: {
  category: FinanceCategory;
  all: FinanceCategory[];
  onList: (next: FinanceCategory[]) => void;
}) {
  const [name, setName] = useState(c.name);
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const update = useMutation({
    mutationFn: (input: { name?: string; fixed?: boolean }) => api.updateCategory(c.id, input),
    onSuccess: onList,
    onError: () => setName(c.name),
  });
  const remove = useMutation({ mutationFn: () => api.deleteCategory(c.id, moveTo || undefined), onSuccess: onList });

  return (
    <li className="money-category">
      <div className="money-category-row">
        <input
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== c.name && update.mutate({ name: name.trim() })}
          aria-label="Category name"
        />
        <label className="checkbox">
          <input type="checkbox" checked={c.fixed} onChange={(e) => update.mutate({ fixed: e.target.checked })} />
          Fixed
        </label>
        <button type="button" className="btn btn-small" onClick={() => setDeleting((d) => !d)} aria-label={`Delete ${c.name}`}>
          ✕
        </button>
      </div>
      {deleting && (
        <div className="money-category-delete">
          {c.transactions > 0 && (
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="" disabled>
                Move its {c.transactions.toLocaleString()} transactions to…
              </option>
              {all
                .filter((o) => o.id !== c.id)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
          )}
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={(c.transactions > 0 && !moveTo) || remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete {c.name}
          </button>
        </div>
      )}
      {(update.error || remove.error) && <p className="error">{(update.error ?? remove.error)!.message}</p>}
    </li>
  );
}
