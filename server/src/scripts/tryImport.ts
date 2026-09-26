/** Dev helper: npx tsx --env-file=.env src/scripts/tryImport.ts <url> [...urls] */
import { extractFromUrl } from '../import/extract.js';

for (const url of process.argv.slice(2)) {
  try {
    const { draft, method } = await extractFromUrl(url);
    const count = (s: { items: string[] }[]) => s.reduce((n, x) => n + x.items.length, 0);
    console.log(`\n✔ [${method}] ${draft.title}  (${url})`);
    console.log(`  serves=${draft.servings} prep=${draft.prepMinutes} cook=${draft.cookMinutes} total=${draft.totalMinutes} tags=${draft.tags.join(',')}`);
    console.log(`  ingredients=${count(draft.ingredients)} in ${draft.ingredients.length} section(s); steps=${count(draft.instructions)} in ${draft.instructions.length} section(s)`);
    console.log(`  ingredient sections: ${draft.ingredients.map((s) => `${s.title ?? '(none)'}: ${s.items.length}`).join(' | ')}`);
    console.log(`  first step: ${draft.instructions[0]?.items[0]?.slice(0, 100)}`);
    console.log(`  image: ${draft.imageUrl?.slice(0, 100)}`);
  } catch (err) {
    console.log(`\n✘ ${url}\n  ${(err as Error).message}`);
  }
}
