import type { IndexedItem } from './ingredients.js';

/**
 * How alike two recipes are, from their titles and the ingredients they share.
 * Used by the planner to skip near-copies when picking, and to shortlist
 * recipes a new one might duplicate (see duplicates.ts).
 */

/** What counts toward "the same ingredients": anything bought for the recipe, not the salt. */
const SAME_WEIGHT: Record<IndexedItem['kind'], number> = { meat: 1, perishable: 1, keeps: 0.35, staple: 0 };

export function ingredientWeights(items: IndexedItem[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const i of items) {
    const w = SAME_WEIGHT[i.kind];
    if (w > 0) weights.set(i.name, Math.max(weights.get(i.name) ?? 0, w));
  }
  return weights;
}

const total = (w: Map<string, number>) => [...w.values()].reduce((a, b) => a + b, 0);

/** How much of each recipe's ingredients the other has: [of the smaller, of the larger]. */
export function overlap(a: Map<string, number>, b: Map<string, number>): [number, number] {
  let shared = 0;
  for (const [name, w] of a) if (b.has(name)) shared += Math.min(w, b.get(name)!);
  const [ta, tb] = [total(a), total(b)];
  if (ta === 0 || tb === 0) return [0, 0];
  return [shared / Math.min(ta, tb), shared / Math.max(ta, tb)];
}

const TITLE_FILLER = new Set(
  'the a an and with of in on for best easy classic homemade my our simple quick perfect ultimate recipe style'.split(' '),
);

/** The words that say what a dish is: "Garlic Yukon Gold Mashed Potatoes" -> garlic, yukon, gold, mashed, potato. */
function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2 && !TITLE_FILLER.has(w))
      .map((w) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );
}

export function titleWordsInCommon(a: string, b: string): number {
  const wa = titleWords(a);
  return [...titleWords(b)].filter((w) => wa.has(w)).length;
}

export interface Comparable {
  title: string;
  weights: Map<string, number>;
}

/**
 * Close enough not to plan together: the same name, most ingredients in common
 * both ways, or two title words in common and a fair share of ingredients.
 * Tuned on a real collection to flag a handful of pairs, not every chicken dish.
 */
export function looksAlike(a: Comparable, b: Comparable): boolean {
  if (a.title.trim().toLowerCase() === b.title.trim().toLowerCase()) return true;
  const [ofSmaller, ofLarger] = overlap(a.weights, b.weights);
  const enough = Math.min(total(a.weights), total(b.weights)) >= 2;
  if (enough && ofSmaller >= 0.7 && ofLarger >= 0.5) return true;
  return titleWordsInCommon(a.title, b.title) >= 2 && ofSmaller >= 0.3;
}

/** A rough 0+ score for shortlisting possible duplicates: shared title words and ingredients. */
export function resemblance(a: Comparable, b: Comparable): number {
  const [ofSmaller, ofLarger] = overlap(a.weights, b.weights);
  return 0.15 * titleWordsInCommon(a.title, b.title) + ofSmaller * 0.5 + ofLarger * 0.5;
}
