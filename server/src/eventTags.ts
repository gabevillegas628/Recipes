import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from './db.js';
import { env } from './env.js';
import type { Household } from './household.js';

/**
 * Who a family-calendar event is for, read from its title ("Danielle innovate 3-9"
 * is Danielle's; "JJ SPEECH" is JJ's). Titles are read by AI once and remembered,
 * so repeating events cost nothing after the first time, and a tag corrected by
 * hand is kept. An event that names no one counts as busy for everyone.
 */

export interface Tag {
  people: string[];
  everyone: boolean;
  unsure: boolean;
  byHand: boolean;
}

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

/** The key titles are remembered by: lowercase, single spaces. */
export const tagKey = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);

const result = z.object({
  tags: z.array(
    z.object({
      index: z.number().int(),
      people: z.array(z.string()).describe('Names from the household list, exactly as listed'),
      everyone: z.boolean().describe('The whole family, or someone outside it (a birthday party, a visit)'),
      unsure: z.boolean().describe("Can't tell whose it is from the title"),
    }),
  ),
});

function system(household: Household) {
  const list = household.people
    .map((p) => `- ${p.name} (${p.adult ? 'adult' : 'child'})${p.aliases.length ? `, also written ${p.aliases.join(', ')}` : ''}`)
    .join('\n');
  return `You read a family's shared calendar to work out whose time each event takes. The household:
${list}

For each numbered event title, give the people it involves:
- A name, nickname or initial from the list means that person ("Gabe 395 02" is Gabe's; "JJ SPEECH" is JJ's). Match case-insensitively; a name can appear anywhere in the title, including after a time or place ("2:20 Americas best Danielle").
- Several names: all of them.
- A family occasion, or an event about someone outside the household ("Mireya birthday", "Thanksgiving at Mom's"): everyone.
- No clue who it's for ("Dentist", "Meeting with Drew"): unsure, with no people.
Don't guess from the kind of event alone.`;
}

/** Tags for the given titles, reading any new ones with AI. Unknown people ids (removed from the household) are dropped. */
export async function tagTitles(titles: string[], household: Household): Promise<Map<string, Tag>> {
  const ids = new Set(household.people.map((p) => p.id));
  const keys = [...new Set(titles.map(tagKey))];
  const known = await prisma.eventTag.findMany({ where: { title: { in: keys } } });
  const tags = new Map<string, Tag>(
    known.map((t) => [t.title, { people: t.people.filter((id) => ids.has(id)), everyone: t.everyone, unsure: t.unsure, byHand: t.byHand }]),
  );

  // Original spelling for the AI, one per key.
  const missing = [...new Map(titles.map((t) => [tagKey(t), t])).entries()].filter(([key]) => !tags.has(key));
  if (missing.length && client && household.people.length) {
    const read = await readTitles(missing.map(([, title]) => title), household);
    const byName = new Map(household.people.map((p) => [p.name.toLowerCase(), p.id]));
    for (const [i, [key]] of missing.entries()) {
      const r = read.get(i);
      if (!r) continue;
      const people = [...new Set(r.people.flatMap((n) => byName.get(n.toLowerCase()) ?? []))];
      const tag = { people, everyone: r.everyone, unsure: !r.everyone && people.length === 0, byHand: false };
      tags.set(key, tag);
      await prisma.eventTag.upsert({
        where: { title: key },
        create: { title: key, people, everyone: tag.everyone, unsure: tag.unsure },
        update: { people, everyone: tag.everyone, unsure: tag.unsure },
      });
    }
  }
  // Not read (no AI, or it failed): count as everyone's, without remembering it.
  for (const [key] of missing) if (!tags.has(key)) tags.set(key, { people: [], everyone: false, unsure: true, byHand: false });
  return tags;
}

async function readTitles(titles: string[], household: Household) {
  const out = new Map<number, z.infer<typeof result>['tags'][number]>();
  try {
    const response = await client!.beta.messages.parse({
      model: env.anthropicModel,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: zodOutputFormat(result) },
      system: system(household),
      messages: [{ role: 'user', content: titles.map((t, i) => `${i}. ${t}`).join('\n') }],
    });
    console.info(
      JSON.stringify({
        msg: 'ai event tags',
        model: response.model,
        titles: titles.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }),
    );
    for (const t of response.parsed_output?.tags ?? []) if (t.index >= 0 && t.index < titles.length) out.set(t.index, t);
  } catch (err) {
    console.warn('Reading event titles failed:', (err as Error).message);
  }
  return out;
}

/**
 * A correction from the results screen: remembered, and never overwritten by the AI.
 * No people and not everyone means it takes no one's time (a note to self, say).
 */
export async function setTag(title: string, people: string[], everyone: boolean) {
  const key = tagKey(title);
  const data = { people: everyone ? [] : people, everyone, unsure: false, byHand: true };
  await prisma.eventTag.upsert({ where: { title: key }, create: { title: key, ...data }, update: data });
}
