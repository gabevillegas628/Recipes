/**
 * Finds cooking times in step text ("simmer 20 minutes", "1 hour 15 min",
 * "bake 25-30 minutes", "1½ hours") so they can become timer buttons.
 * Ranges start a timer for the low end: that's when to check.
 */

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45,
};
const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

const NUM = `(?:\\d+(?:[.,]\\d+)?\\s*[½¼¾⅓⅔]?|[½¼¾⅓⅔]|${Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|')})`;
const UNIT = '(hours?|hrs?|minutes?|mins?|seconds?|secs?)';
const DURATION = new RegExp(
  `\\b(${NUM})(?:\\s*(?:-|–|to|or)\\s*(${NUM}))?\\s*${UNIT}\\b` +
    // "1 hour 15 minutes" / "1 hour and 15 minutes"
    `(?:\\s*(?:and\\s+)?(${NUM})\\s*(minutes?|mins?)\\b)?`,
  'gi',
);

function toNumber(raw: string): number {
  const s = raw.trim().toLowerCase();
  if (s in WORDS) return WORDS[s];
  const m = s.match(/^(\d+(?:[.,]\d+)?)?\s*([½¼¾⅓⅔])?$/);
  if (!m) return NaN;
  return Number((m[1] ?? '0').replace(',', '.')) + (m[2] ? FRACTIONS[m[2]] : 0);
}

const unitSeconds = (unit: string) => (/^h/i.test(unit) ? 3600 : /^m/i.test(unit) ? 60 : 1);

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return m ? `${h} hr ${m} min` : `${h} hr`;
  if (m) return s ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

export type StepPart = { type: 'text'; text: string } | { type: 'timer'; text: string; seconds: number };

/** Splits a step into text and timer parts. */
export function splitTimers(step: string): StepPart[] {
  const parts: StepPart[] = [];
  let last = 0;
  for (const m of step.matchAll(DURATION)) {
    const [whole, low, , unit, extra] = m;
    let seconds = toNumber(low) * unitSeconds(unit);
    if (extra && /^h/i.test(unit)) seconds += toNumber(extra) * 60;
    seconds = Math.round(seconds);
    // Ignore nonsense and "a minute or two"-style asides that are too short to time.
    if (!Number.isFinite(seconds) || seconds < 30 || seconds > 24 * 3600) continue;
    if (m.index! > last) parts.push({ type: 'text', text: step.slice(last, m.index) });
    parts.push({ type: 'timer', text: whole, seconds });
    last = m.index! + whole.length;
  }
  if (last < step.length) parts.push({ type: 'text', text: step.slice(last) });
  return parts;
}
