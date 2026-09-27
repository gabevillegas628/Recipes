/**
 * Scales ingredient lines ("1 ½ cups (200 g) flour") by a multiplier.
 *
 * What gets scaled:
 *  - the quantity at the start of the line (a count or an amount)
 *  - any other quantity followed by a measuring unit ("plus 1 tbsp", "(200 g)")
 * What doesn't:
 *  - package sizes right after a plain count: in "2 (15 oz) cans", only the 2
 *  - sizes and temperatures ("10-inch", "350°F")
 * Kitchen volumes are tidied after scaling (6 tsp -> 2 tbsp, 8 tbsp -> 1/2 cup).
 */

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅕': 1 / 5, '⅖': 2 / 5,
  '⅗': 3 / 5, '⅘': 4 / 5, '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
};
const UF = Object.keys(UNICODE_FRACTIONS).join('');

// One amount: "1 1/2", "1½", "1 ½", "1/2", "½", "1.5", "1,5", "2".
const AMOUNT = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\s*[${UF}]|\\d+\\/\\d+|[${UF}]|\\d+(?:[.,]\\d+)?)`;
// A range: "2-3", "2 – 3", "2 to 3".
const QUANTITY = `${AMOUNT}(?:\\s*(?:-|–|—|to)\\s*${AMOUNT})?`;

type UnitKind = 'tsp' | 'tbsp' | 'cup' | 'metric' | 'weight' | 'other';

// Measuring units, longest spellings first so "tablespoons" wins over "t".
const UNIT_PATTERNS: [RegExp, UnitKind][] = [
  [/^(?:teaspoons?|tsps?\.?)(?![a-z])/i, 'tsp'],
  [/^(?:tablespoons?|tbsps?\.?|tbs\.?|tbl\.?)(?![a-z])/i, 'tbsp'],
  [/^T(?![a-z])/, 'tbsp'],
  [/^t(?![a-z])/, 'tsp'],
  [/^(?:cups?|c\.)(?![a-z])/i, 'cup'],
  [/^(?:grams?|gr?|kilograms?|kgs?|milliliters?|millilitres?|ml|liters?|litres?|l)(?![a-z])/i, 'metric'],
  [/^(?:ounces?|oz\.?|pounds?|lbs?\.?|fl\.?\s*oz\.?|pints?|pts?\.?|quarts?|qts?\.?|gallons?|gal\.?)(?![a-z])/i, 'weight'],
];

function parseAmount(raw: string): number {
  const s = raw.trim().replace(',', '.');
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = s.match(new RegExp(`^(\\d+)\\s*([${UF}])$`));
  if (m) return Number(m[1]) + UNICODE_FRACTIONS[m[2]];
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  if (UNICODE_FRACTIONS[s] !== undefined) return UNICODE_FRACTIONS[s];
  return Number(s);
}

function unitAt(text: string): { kind: UnitKind; match: string } | null {
  const rest = text.replace(/^\s+/, '');
  for (const [re, kind] of UNIT_PATTERNS) {
    const m = rest.match(re);
    if (m) return { kind, match: m[0] };
  }
  return null;
}

const NICE_FRACTIONS: [number, string][] = [
  [0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'],
  [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, ''],
];

/** 1.5 -> "1½", 0.333 -> "⅓", 2.0 -> "2". Metric amounts stay decimal. */
export function formatAmount(value: number, kind: UnitKind | null): string {
  if (kind === 'metric') {
    if (value >= 100) return String(Math.round(value / 5) * 5);
    if (value >= 10) return String(Math.round(value));
    return String(Math.round(value * 10) / 10);
  }
  if (value >= 10) return String(Math.round(value));
  let whole = Math.floor(value);
  const frac = value - whole;
  let best = NICE_FRACTIONS[0];
  for (const f of NICE_FRACTIONS) if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f;
  if (best[0] === 1) {
    whole += 1;
    best = NICE_FRACTIONS[0];
  }
  if (whole === 0 && !best[1]) return String(Math.round(value * 100) / 100 || value.toPrecision(1));
  return `${whole || ''}${best[1]}`;
}

/** Re-express tsp/tbsp/cup amounts in the unit that reads best (only when it's exact-ish). */
function tidyVolume(value: number, kind: UnitKind): { value: number; kind: UnitKind } {
  const TSP = { tsp: 1, tbsp: 3, cup: 48 } as Record<string, number>;
  if (!(kind in TSP)) return { value, kind };
  const tsp = value * TSP[kind];
  const near = (n: number, step: number) => Math.abs(n / step - Math.round(n / step)) < 0.02;
  // Cups in quarters or thirds, tablespoons in halves; otherwise leave the unit alone
  // ("4 tsp" reads better than "1⅓ tbsp").
  if (tsp >= 12 && (near(tsp / 48, 1 / 4) || near(tsp / 48, 1 / 3))) return { value: tsp / 48, kind: 'cup' };
  if (tsp >= 3 && near(tsp / 3, 1 / 2)) return { value: tsp / 3, kind: 'tbsp' };
  if (kind === 'cup' && tsp < 12) return { value: tsp / 3, kind: 'tbsp' };
  if (kind === 'tbsp' && tsp < 3) return { value: tsp, kind: 'tsp' };
  return { value, kind };
}

const UNIT_LABEL: Record<string, [string, string]> = {
  tsp: ['tsp', 'tsp'],
  tbsp: ['tbsp', 'tbsp'],
  cup: ['cup', 'cups'],
};

function scaleQuantity(raw: string, factor: number, unit: { kind: UnitKind; match: string } | null) {
  const parts = raw.split(/\s*(?:-|–|—|to)\s*(?=[\d½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/);
  const values = parts.map((p) => parseAmount(p) * factor);
  let kind = unit?.kind ?? null;
  let unitText = unit?.match ?? null;

  if (kind === 'tsp' || kind === 'tbsp' || kind === 'cup') {
    const tidied = values.map((v) => tidyVolume(v, kind!));
    // Only switch units if every end of a range lands on the same new unit.
    if (tidied.every((t) => t.kind === tidied[0].kind) && tidied[0].kind !== kind) {
      kind = tidied[0].kind;
      const [one, many] = UNIT_LABEL[kind];
      unitText = tidied[tidied.length - 1].value > 1 ? many : one;
      return { text: tidied.map((t) => formatAmount(t.value, kind)).join('–'), unitText };
    }
  }
  // Less than ⅛ teaspoon is a pinch.
  if (kind === 'tsp' && values.every((v) => v < 0.1)) return { text: 'pinch', unitText: '', pinch: true };

  // Spelled-out units follow the new amount: "1 teaspoon" / "2 teaspoons".
  const SPELLED_UNIT =
    /^(?:cup|teaspoon|tablespoon|pound|ounce|gram|kilogram|liter|litre|milliliter|millilitre|quart|pint|gallon)s?$/i;
  if (unitText && SPELLED_UNIT.test(unitText)) {
    const plural = values[values.length - 1] > 1;
    const singular = unitText.replace(/s$/i, '');
    unitText = plural ? (/s$/i.test(unitText) ? unitText : `${unitText}${unitText === unitText.toUpperCase() ? 'S' : 's'}`) : singular;
  }
  return { text: values.map((v) => formatAmount(v, kind)).join('–'), unitText };
}

// Letters may follow directly ("500ml", "360g"); whether that's a unit is checked separately.
const QUANTITY_RE = new RegExp(`(?<![\\w./-])(${QUANTITY})(?![\\d/]|-\\w|°)`, 'g');

export function scaleIngredient(line: string, factor: number): string {
  if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return line;

  let out = '';
  let last = 0;
  let leadingWasCount = false;
  let first = true;

  for (const m of line.matchAll(QUANTITY_RE)) {
    const start = m.index!;
    const raw = m[1];
    const after = line.slice(start + raw.length);
    const unit = unitAt(after);
    // "2nd", "3x": letters glued to the number that aren't a unit mean it isn't a quantity.
    if (/^[a-z]/i.test(after) && !unit) {
      first = false;
      continue;
    }
    const isLeading = first && /^[\s•*\-–]*$/.test(line.slice(0, start));
    first = false;

    // A plain count at the start makes a following "(15 oz)" a package size.
    const insideParens = /\([^)]*$/.test(line.slice(0, start));
    const packageSize = insideParens && leadingWasCount;

    if (isLeading) leadingWasCount = !unit;
    if (!(isLeading || (unit && unit.kind !== 'other')) || packageSize) continue;

    const scaled = scaleQuantity(raw, factor, unit);
    out += line.slice(last, start) + scaled.text;
    last = start + raw.length;
    if (unit && 'pinch' in scaled) {
      // "0.06 teaspoon ground nutmeg" -> "pinch ground nutmeg"
      last += (after.match(/^\s*/)![0] + unit.match).length;
    } else if (unit && scaled.unitText && scaled.unitText !== unit.match) {
      const gap = after.match(/^\s*/)![0];
      out += gap + scaled.unitText;
      last += gap.length + unit.match.length;
    }
  }
  return out + line.slice(last);
}

/** The first number in a servings string: "4", "Serves 4-6", "Makes 16 cookies". */
export function baseServings(servings: string | null): number | null {
  const m = servings?.match(/\d+(?:[.,]\d+)?/);
  const n = m ? Number(m[0].replace(',', '.')) : NaN;
  return n > 0 && n < 1000 ? n : null;
}
