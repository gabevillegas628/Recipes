import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, imageUrl } from '../api';
import { scaleIngredient } from '../scale';
import { formatMinutes } from '../sections';
import type { Recipe, Section } from '../types';

/**
 * A whole meal laid out for paper: every recipe in full, at its amount within the meal
 * (times the meal's servings stepper, passed as ?scale=), one recipe per page.
 */
export function MealPrintPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const factor = Number(params.get('scale')) || 1;

  const meal = useQuery({ queryKey: ['meal', id], queryFn: () => api.meal(id!) });
  const recipes = useQueries({
    queries: (meal.data?.recipes ?? []).map(({ recipe }) => ({
      queryKey: ['recipe', recipe.id],
      queryFn: () => api.getRecipe(recipe.id),
    })),
  });
  const ready = meal.data && recipes.every((q) => q.data);

  // Open the print dialog once, when everything has loaded and images have had a moment.
  const printed = useRef(false);
  useEffect(() => {
    if (!ready || printed.current) return;
    printed.current = true;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [ready]);

  if (meal.error) return <p className="page error">{meal.error.message}</p>;
  const back = () => navigate(`/m/${id}`);

  return (
    <article className="page print-page">
      <div className="print-toolbar">
        <button type="button" className="btn" onClick={back}>
          ← Back
        </button>
        <button type="button" className="btn btn-primary" onClick={() => window.print()} disabled={!ready}>
          Print
        </button>
      </div>
      {!ready ? (
        <p className="muted">Getting the recipes ready…</p>
      ) : (
        <>
          <h1 className="recipe-title">{meal.data!.name}</h1>
          {meal.data!.servings && (
            <p className="recipe-desc">Serves {Math.round(meal.data!.servings * factor * 100) / 100}</p>
          )}
          <ol className="print-toc">
            {meal.data!.recipes.map(({ recipe }) => (
              <li key={recipe.id}>{recipe.title}</li>
            ))}
          </ol>
          {meal.data!.recipes.map(({ scale }, i) => (
            <PrintedRecipe key={recipes[i].data!.id} recipe={recipes[i].data!} scale={scale * factor} />
          ))}
        </>
      )}
    </article>
  );
}

function PrintedRecipe({ recipe, scale }: { recipe: Recipe; scale: number }) {
  const img = imageUrl(recipe.image);
  const times = [
    ['Prep', formatMinutes(recipe.prepMinutes)],
    ['Cook', formatMinutes(recipe.cookMinutes)],
    ['Total', formatMinutes(recipe.totalMinutes)],
  ].filter(([, v]) => v);
  return (
    <section className="print-recipe">
      {img && <img className="print-hero" src={img} alt="" />}
      <h2>{recipe.title}</h2>
      {scale !== 1 && <p className="muted small">Amounts for {Math.round(scale * 100) / 100}× the recipe</p>}
      {recipe.description && <p className="recipe-desc">{recipe.description}</p>}
      {times.length > 0 && (
        <p className="muted small">{times.map(([label, value]) => `${label} ${value}`).join(' · ')}</p>
      )}
      <h3>Ingredients</h3>
      <PrintSections sections={recipe.ingredients} list="ul" render={(item) => scaleIngredient(item, scale)} />
      <h3>Instructions</h3>
      <PrintSections sections={recipe.instructions} list="ol" render={(item) => item} />
    </section>
  );
}

function PrintSections({
  sections,
  list: List,
  render,
}: {
  sections: Section[];
  list: 'ul' | 'ol';
  render: (item: string) => string;
}) {
  if (sections.length === 0) return <p className="muted">None listed.</p>;
  return (
    <>
      {sections.map((section, si) => (
        <div key={si}>
          {section.title && <h4>{section.title}</h4>}
          <List>
            {section.items.map((item, ii) => (
              <li key={ii}>{render(item)}</li>
            ))}
          </List>
        </div>
      ))}
    </>
  );
}
