/**
 * The key a transaction finds its merchant by: the description with the parts
 * that change from charge to charge taken out (dates, store and reference
 * numbers, "POS PURCHASE"). "SQ *BLUE BOTTLE 0412 03/14" and
 * "SQ *BLUE BOTTLE 0977 04/02" share "BLUE BOTTLE". Different stores of a chain
 * can still differ (a city left in); the AI gives them the same name, and
 * corrections apply by name.
 *
 * Only the bank's description is used, not SimpleFIN's cleaned-up payee: the
 * payee is too coarse ("Capital One" for both card payments and the auto loan,
 * "Costco" for Costco Travel). The AI sees the payee as a hint instead.
 */

const NOISE =
  /\b(POS|DEBIT|CREDIT|CARD|PURCHASE|PURCHASES|CHECKCARD|RECURRING|AUTHORIZED|ON|ACH|WEB|PPD|CCD|ID|DBT|POINT OF SALE|TRANSACTION|PENDING|REF)\b/g;

export function merchantKey(description: string): string {
  const raw = description.toUpperCase();
  let s = raw
    // Card processors' prefixes: "SQ *", "TST* ", "SP ", "PAYPAL *".
    .replace(/^(SQ|TST|SP|DD|PY|IN)\s?\*\s?/, '')
    .replace(/\*/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/#\s*\S+/g, ' ')
    .replace(NOISE, ' ')
    .split(/\s+/)
    // Store, reference and card numbers: anything with 3 or more digits, codes like "RT5YH2", masked "XXXX1234".
    .filter(
      (w) => w && (w.match(/\d/g)?.length ?? 0) < 3 && !/^(?=.*\d)(?=.*[A-Z])[A-Z\d]{5,}$/.test(w) && !/^X{3,}/.test(w),
    )
    .join(' ')
    .replace(/[^A-Z0-9&' .-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A trailing state ("KROGER MASON OH").
  if (s.split(' ').length > 2) s = s.replace(/ [A-Z]{2}$/, '');
  s = s.replace(/[ .-]+$/, '').trim();
  return (s || raw.replace(/\s+/g, ' ').trim()).slice(0, 80);
}
