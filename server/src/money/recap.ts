import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { wallTime, zonedInstant } from '../zone.js';
import { budgetPlan } from './budget.js';
import { homeTimeZone } from './connection.js';
import { overview } from './overview.js';
import { findCharges } from './recurring.js';

/**
 * Claude's look back at a finished month: a one-line verdict and a few points
 * on what changed, written from that month's numbers (against the usual
 * month and today's budget), its biggest charges, and subscriptions that are
 * new or cost more. Written once, a few days into the next month so late
 * charges have synced (recapDue, from the timer in index.ts); rewritten on
 * request.
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

/** Days into a month before last month is written up: banks post late. */
const AFTER_DAY = 3;

const result = z.object({
  headline: z.string().describe('One sentence: how the month went, money in against money out'),
  points: z.array(z.string()).describe('3 to 6 short points, most important first'),
});

const SYSTEM = `You write a short monthly money recap for a household (Gabe and Danielle, two kids), shown in their family app. You get one finished month's numbers as JSON.

Write:
- headline: one plain sentence on how the month went: what came in against what went out, and whether there was money left over or a shortfall.
- points: 3 to 6 short points, most important first, each one sentence. Cover what actually moved: categories well above or below their usual month (say both numbers), big one-off charges, new subscriptions or price rises, a bonus or missing paycheck, money moved into or out of savings. Skip what was ordinary.

Rules:
- Use their numbers, rounded to whole dollars ("$1,240"). Never invent a figure.
- "usual" is the average of recent complete months; "budget" is their current plan. Mention the budget only where it helps.
- Plain and friendly, not judgmental, no lectures. Suggest something only when it's specific and obvious (a subscription that doubled, say).
- Saving can be negative: money taken back out of savings.
- No markdown, no emoji.`;

/** Writes a month's recap without saving it. */
export async function composeRecap(month: string) {
  if (!client) throw new Error('No Anthropic API key on the server, so there’s nothing to write the recap with.');
  const timeZone = await homeTimeZone();
  const thisMonth = wallTime(new Date(), timeZone).slice(0, 7);
  if (month >= thisMonth) throw new Error('Only finished months get a recap.');

  const [ov, current, charges] = await Promise.all([overview(month), overview(), findCharges()]);
  const plan = await budgetPlan(current);
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const range = { gte: zonedInstant(`${month}-01T00:00:00`, timeZone), lt: zonedInstant(`${next}-01T00:00:00`, timeZone) };
  const [big, income] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: { kind: 'SPENDING', transactedAt: range, amount: { lt: 0 } },
      orderBy: { amount: 'asc' },
      take: 8,
      select: { amount: true, description: true, transactedAt: true, category: { select: { name: true } }, merchantKey: true },
    }),
    prisma.financeTransaction.findMany({
      where: { kind: 'INCOME', transactedAt: range },
      select: { amount: true, description: true, transactedAt: true },
    }),
  ]);
  const names = new Map(
    (await prisma.financeMerchant.findMany({ where: { key: { in: big.flatMap((t) => (t.merchantKey ? [t.merchantKey] : [])) } } })).map(
      (x) => [x.key, x.name],
    ),
  );
  const budgetOf = new Map(plan.categories.map((c) => [c.id, c.budget]));
  const whole = (n: number) => Math.round(n);

  const facts = {
    month,
    in: whole(ov.totals.income),
    spent: whole(ov.totals.spending),
    saved: whole(ov.totals.saving),
    leftOver: whole(ov.totals.income - ov.totals.spending),
    usualMonth: ov.typical
      ? { months: ov.typical.months, in: whole(ov.typical.income), spent: whole(ov.typical.spending), saved: whole(ov.typical.saving) }
      : null,
    partialData: ov.history.find((h) => h.month === month)?.partial ?? false,
    categories: ov.categories.map((c) => ({
      name: c.name,
      fixed: c.fixed,
      spent: whole(c.spent),
      usual: c.typical === null ? null : whole(c.typical),
      budget: whole(budgetOf.get(c.id) ?? 0),
    })),
    biggestCharges: big.map((t) => ({
      what: (t.merchantKey && names.get(t.merchantKey)) || t.description,
      category: t.category?.name ?? null,
      amount: whole(-t.amount.toNumber()),
      date: wallTime(t.transactedAt, timeZone).slice(0, 10),
    })),
    paychecks: income.map((t) => ({ from: t.description, amount: whole(t.amount.toNumber()) })),
    usualPaycheckSources: plan.income.sources.map((s) => ({ name: s.name, usual: whole(s.amount), perMonth: s.perMonth })),
    subscriptionChanges: charges
      .filter((c) => c.was !== null || c.isNew)
      .map((c) => ({ name: c.name, now: c.amount, was: c.was, new: c.isNew })),
    budgetToday: { income: whole(plan.income.expected), bills: whole(plan.totals.fixed), everyday: whole(plan.totals.everyday), saving: whole(plan.saving) },
  };

  const response = await client.messages.parse({
    model: env.anthropicModel,
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(result) },
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(facts) }],
  });
  console.info(
    JSON.stringify({ msg: 'ai money recap', month, model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }),
  );
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Claude didn’t return a recap. Try again in a bit.');
  return { headline: parsed.headline.trim(), points: parsed.points.map((p) => p.trim()).filter(Boolean).slice(0, 6), model: response.model };
}

/** Writes a month's recap and saves it, replacing any earlier one. */
export async function writeRecap(month: string) {
  const data = await composeRecap(month);
  return prisma.financeRecap.upsert({ where: { month }, create: { month, ...data }, update: { ...data, createdAt: new Date() } });
}

let tried = '';

/** Writes last month's recap once it's due: a few days into the month, with data for the whole of it. At most one try a day. */
export async function recapDue() {
  if (!client) return;
  const timeZone = await homeTimeZone();
  const today = wallTime(new Date(), timeZone).slice(0, 10);
  if (Number(today.slice(8, 10)) < AFTER_DAY || tried === today) return;
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const last = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  if (await prisma.financeRecap.findUnique({ where: { month: last }, select: { month: true } })) return;
  tried = today;
  const ov = await overview(last);
  if (!ov.completeFrom || last < ov.completeFrom) return;
  try {
    await writeRecap(last);
  } catch (err) {
    console.warn('Money recap failed:', (err as Error).message);
  }
}
