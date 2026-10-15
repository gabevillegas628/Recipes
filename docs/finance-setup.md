# Finances: getting your accounts connected (phase 0)

Mise reads your bank, card and Fidelity data through **SimpleFIN Bridge**, a small
service that connects to banks for you and hands the data to apps you approve.
This is the one-time setup. Allow about 30–45 minutes, mostly spent signing in to banks.

**What SimpleFIN can and can't do:** it's **read-only**. It can see balances and
transactions, but it can't move money or pay anything. You can disconnect a bank or
cancel at any time from SimpleFIN's site.

---

## Step 1: Create a SimpleFIN account

1. Go to <https://beta-bridge.simplefin.org> and click **Get started**.
2. Sign up and pay. It's **$15 a year** (or $1.50 a month); the yearly plan is simplest.
3. The plan allows up to 25 institutions. You need 5.

## Step 2: Connect each institution

In SimpleFIN, add a connection for each of these, one at a time:

| Institution | What should show up |
|---|---|
| PNC | Every checking and savings account, plus the PNC credit card |
| Discover | Your card(s) |
| Capital One | Your card(s) |
| Citi | Your card(s) |
| Fidelity | Each investment account (brokerage, 401k, IRA, etc.) |

For each one:

1. Search for the bank by name and choose it.
2. Sign in with your normal username and password. Most of these banks send you to
   **their own website** to sign in and approve access. That's expected, and it means
   SimpleFIN never sees your password.
3. Approve the security code text or app prompt if the bank sends one.
4. If the bank shows a list of accounts to share, **choose all of them**.

**If one fails:** try it once more. If it still fails, skip it and keep going, then
write down which one it was and what the error said. Capital One and Fidelity are the
two most likely to be difficult. Don't spend more than a few minutes fighting one.

## Step 3: Check the data is there

SimpleFIN's own site only shows each connection's status, not balances or
transactions. "OK" for each institution is the success signal there. To see the
actual data, run the check script:

1. In SimpleFIN, create a new app connection just for this check (name it
   "check"), and copy the setup token it gives you.
2. In a terminal, from the `server` folder:
   ```
   npm run simplefin:check
   ```
   Paste the token when it asks. Nothing shows as you paste, which is deliberate.
3. It lists every account with its balance, the number of transactions from the
   last 90 days, and any problems SimpleFIN reports. It saves nothing.
   (`npm run simplefin:check -- --samples` also prints 3 transaction descriptions
   per account, to see how readable the merchant names are.)
4. In SimpleFIN, **delete the "check" app connection** afterwards. Mise gets its
   own in phase 1.

Then check:

- [ ] Every account from the table above is listed
- [ ] Balances look right (close to what your bank app shows)
- [ ] The cards and PNC checking have transactions
- [ ] Fidelity shows at least a balance. That's all Mise needs from it.

The first pull can take up to a few hours after connecting. If an account shows
0 transactions, try again later before treating it as a problem.

## Step 4: Connect Mise

Once the version of Mise with **Settings → Money** is deployed:

1. In SimpleFIN Bridge, create a new app connection named "Mise" and copy its setup token.
2. In Mise, open **Settings → Money**, paste the token, and tap **Connect**.
3. The first sync reaches back for as much history as SimpleFIN has, which takes a minute.
   Then every account is listed with its balance and transaction count.
4. Check each account's **type** (checking, savings, credit card, loan, investment) and
   fix any wrong guesses. The type decides what counts as spending, a card payment, or saving.

The setup token works once. Mise trades it for a permanent key it keeps encrypted, so you
won't paste it again unless you disconnect.

- **Don't paste the token into a chat**, including with Claude, or anywhere else. It's as
  sensitive as a password. If it ever leaks, delete that app connection in SimpleFIN
  and make a new one.

## Step 5 (optional but recommended): Download a year of history

SimpleFIN only goes back about 90 days. Without older history, the "last 12 months"
chart and the generated budget would be thin for months. A one-time download fixes that.

From each bank's **website** (not the phone app), download the **last 12 months of
transactions as CSV**. The option is usually on the account's activity or
transactions page, labeled "Download" or "Export". Menu names vary, but each of these
banks has one:

- [ ] PNC: each checking/savings account **and** the PNC card, one file per account
- [ ] Discover
- [ ] Capital One
- [ ] Citi
- [ ] Fidelity: account activity, if it offers a download (nice to have, not essential)

Some banks cap a single download at 90 days or a statement period. If so, download in
a few chunks; overlap is fine, because Mise will skip duplicates.

**Where to put the files:** a folder **outside** the RecipeOrganizer project, for
example `Documents\Mise finance import\`. They contain account details, so they should
never end up in git.

**Importing them:** after Mise's first sync (step 4), open **Settings → Money**. Under each
account, tap **Import older history (CSV)** and pick that account's file. Mise shows what it
read before saving anything:

- Rows on days SimpleFIN already has are skipped, so overlapping files are fine and
  nothing is counted twice. Importing the same file again adds nothing.
- Banks disagree on whether a purchase is a plus or a minus. Mise compares the file with
  SimpleFIN's data and flips the file's signs if needed. Check the sample rows:
  **purchases and money going out should show as minus.** If Mise couldn't tell, there's
  a checkbox to flip them.

The file never leaves your phone or computer as a file. Mise reads it in the browser and
saves only the date, amount and description of each row.
