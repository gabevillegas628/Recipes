import { randomBytes } from 'node:crypto';

/** 24 URL-safe characters (144 bits): unguessable, short enough to text. */
export function newShareToken() {
  return randomBytes(18).toString('base64url');
}

type Section = { title: string | null; items: string[] };

export interface SharedRecipe {
  title: string;
  description: string | null;
  image: string | null;
  servings: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  ingredients: Section[];
  instructions: Section[];
  sourceUrl: string | null;
  tags: string[];
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function formatMinutes(m: number | null) {
  if (!m) return null;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return [h && `${h} hr`, rest && `${rest} min`].filter(Boolean).join(' ');
}

const isoDuration = (m: number | null) => (m ? `PT${Math.floor(m / 60) ? `${Math.floor(m / 60)}H` : ''}${m % 60 ? `${m % 60}M` : ''}` : undefined);

/** Only http(s) links, so a stored "javascript:" URL can't become a link. */
function safeHref(url: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** schema.org Recipe, so the link previews well and imports cleanly into recipe apps (this one included). */
function jsonLd(recipe: SharedRecipe, pageUrl: string, imageUrl: string | null) {
  const sectionsLd = (sections: Section[]) =>
    sections.map((s) => {
      const steps = s.items.map((text) => ({ '@type': 'HowToStep', text }));
      return s.title ? { '@type': 'HowToSection', name: s.title, itemListElement: steps } : steps;
    });
  const instructions = sectionsLd(recipe.instructions).flat();
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: recipe.title,
    description: recipe.description ?? undefined,
    image: imageUrl ?? undefined,
    url: pageUrl,
    recipeYield: recipe.servings ?? undefined,
    prepTime: isoDuration(recipe.prepMinutes),
    cookTime: isoDuration(recipe.cookMinutes),
    totalTime: isoDuration(recipe.totalMinutes),
    recipeIngredient: recipe.ingredients.flatMap((s) => s.items),
    recipeInstructions: instructions,
    recipeCategory: recipe.tags.length ? recipe.tags : undefined,
    isBasedOn: safeHref(recipe.sourceUrl) ?? undefined,
  };
  return data;
}

function sectionsHtml(sections: Section[], list: 'ul' | 'ol') {
  if (sections.length === 0) return '<p class="muted">None listed.</p>';
  return sections
    .map(
      (s) =>
        `${s.title ? `<h3>${escapeHtml(s.title)}</h3>` : ''}<${list}>${s.items
          .map((i) => `<li>${escapeHtml(i)}</li>`)
          .join('')}</${list}>`,
    )
    .join('');
}

const STYLE = `
:root{--bg:#f7f3ee;--surface:#fff;--text:#221f1b;--muted:#7a7166;--border:#e6ded3;--accent:#c2562e;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1b1916;--surface:#262320;--text:#efe9e1;--muted:#a39a8e;--border:#3a3530;--accent:#e07a52;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:680px;margin:0 auto;padding:16px 16px 48px}
.hero{display:block;width:100%;max-height:420px;object-fit:cover;border-radius:12px;margin-bottom:16px}
h1{font-size:28px;line-height:1.2;margin:8px 0}
h2{font-size:20px;margin:28px 0 8px}
h3{font-size:15px;color:var(--muted);margin:16px 0 4px}
.meal-recipe{margin-top:40px;padding-top:24px;border-top:2px solid var(--border)}
.meal-recipe h2{font-size:24px;margin:0 0 4px}
.meal-recipe h3.part{font-size:18px;color:var(--text);margin:20px 0 4px}
.amount{display:inline-block;margin:4px 0 8px;padding:2px 10px;border-radius:999px;background:var(--surface);border:1px solid var(--border);font-size:14px;font-weight:600}
.toc{padding-left:22px}.toc li{border:0;padding:2px 0}
.desc{color:var(--muted);margin:0 0 12px}
dl{display:flex;flex-wrap:wrap;gap:8px 24px;margin:12px 0;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:12px}
dt{font-size:13px;color:var(--muted)}dd{margin:0;font-weight:600}
ul,ol{padding-left:22px;margin:4px 0}
li{padding:6px 0;border-bottom:1px solid var(--border)}
li:last-child{border-bottom:0}
ol li{padding-left:4px}
.muted{color:var(--muted)}
footer{margin-top:32px;font-size:14px;color:var(--muted)}
a{color:var(--accent)}
@media print{
:root{--bg:#fff;--surface:#fff;--text:#000;--muted:#555;--border:#ddd}
body{font-size:12pt}main{max-width:none;padding:0}
.hero{max-height:200px;width:auto;max-width:100%}
li{padding:2px 0;border:0}
.meal-recipe{break-before:page;border:0;margin:0;padding:0}
.toc+.meal-recipe{break-before:auto;margin-top:24px}
h2,h3{break-after:avoid}
footer{display:none}
}`;

function page({
  title,
  summary,
  pageUrl,
  imageUrl,
  data,
  body,
}: {
  title: string;
  summary: string;
  pageUrl: string;
  imageUrl: string | null;
  data: unknown;
  body: string;
}) {
  // Inside <script>, "<" must not be able to close the tag.
  const ld = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(summary)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(summary)}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">\n<meta name="twitter:card" content="summary_large_image">` : ''}
<script type="application/ld+json">${ld}</script>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer>Shared from Mise</footer>
</main>
</body>
</html>`;
}

/** One recipe's content. In a meal it's a section under the meal's title, so headings drop a level. */
function recipeHtml(recipe: SharedRecipe, { inMeal = false, scale = 1, id }: { inMeal?: boolean; scale?: number; id?: string } = {}) {
  const times = (
    [
      ['Prep', formatMinutes(recipe.prepMinutes)],
      ['Cook', formatMinutes(recipe.cookMinutes)],
      ['Total', formatMinutes(recipe.totalMinutes)],
      ['Serves', recipe.servings],
    ] as const
  ).filter(([, v]) => v);
  const source = safeHref(recipe.sourceUrl);
  const [h1, h2] = inMeal ? ['h2', 'h3 class="part"'] : ['h1', 'h2'];
  const close = (tag: string) => tag.split(' ')[0];
  return `${recipe.image ? `<img class="hero" src="/images/${escapeHtml(recipe.image)}" alt="">` : ''}
<${h1}${id ? ` id="${id}"` : ''}>${escapeHtml(recipe.title)}</${h1}>
${scale !== 1 ? `<span class="amount">Make ${scale}× this recipe</span>` : ''}
${recipe.description ? `<p class="desc">${escapeHtml(recipe.description)}</p>` : ''}
${times.length ? `<dl>${times.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v!)}</dd></div>`).join('')}</dl>` : ''}
<${h2}>Ingredients</${close(h2)}>
${sectionsHtml(recipe.ingredients, 'ul')}
<${h2}>Instructions</${close(h2)}>
${sectionsHtml(recipe.instructions, 'ol')}
${source ? `<p class="muted"><a href="${escapeHtml(source)}" rel="noreferrer">Original recipe</a></p>` : ''}`;
}

const summaryOf = (recipe: SharedRecipe) =>
  recipe.description ?? `${recipe.ingredients.flatMap((s) => s.items).length} ingredients`;

/** The read-only page someone gets when you send them a recipe link. Plain HTML, no app or login. */
export function renderRecipePage(recipe: SharedRecipe, { baseUrl, pageUrl }: { baseUrl: string; pageUrl: string }) {
  const imageUrl = recipe.image ? `${baseUrl}/images/${recipe.image}` : null;
  return page({
    title: recipe.title,
    summary: summaryOf(recipe),
    pageUrl,
    imageUrl,
    data: jsonLd(recipe, pageUrl, imageUrl),
    body: recipeHtml(recipe),
  });
}

export interface SharedMeal {
  name: string;
  servings: number | null;
  recipes: { scale: number; recipe: SharedRecipe }[];
}

/** A shared meal: every recipe in full, each at its amount within the meal. */
export function renderMealPage(meal: SharedMeal, { baseUrl, pageUrl }: { baseUrl: string; pageUrl: string }) {
  const firstImage = meal.recipes.find((r) => r.recipe.image)?.recipe.image;
  const imageUrl = firstImage ? `${baseUrl}/images/${firstImage}` : null;
  const titles = meal.recipes.map((r) => r.recipe.title);
  const body = `<h1>${escapeHtml(meal.name)}</h1>
${meal.servings ? `<p class="desc">Serves ${meal.servings}</p>` : ''}
${
  meal.recipes.length
    ? `<ol class="toc">${meal.recipes.map((r, i) => `<li><a href="#r${i + 1}">${escapeHtml(r.recipe.title)}</a></li>`).join('')}</ol>`
    : '<p class="muted">No recipes in this meal yet.</p>'
}
${meal.recipes
  .map((r, i) => `<section class="meal-recipe">${recipeHtml(r.recipe, { inMeal: true, scale: r.scale, id: `r${i + 1}` })}</section>`)
  .join('\n')}`;
  return page({
    title: meal.name,
    summary: titles.length ? titles.join(', ') : 'A meal',
    pageUrl,
    imageUrl,
    data: meal.recipes.map((r) => jsonLd(r.recipe, pageUrl, r.recipe.image ? `${baseUrl}/images/${r.recipe.image}` : null)),
    body,
  });
}
