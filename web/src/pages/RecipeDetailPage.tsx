import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, imageUrl } from '../api';
import { GroceryPicker } from '../components/GroceryPicker';
import { ServingsControl } from '../components/ServingsControl';
import { StepText } from '../components/StepText';
import { scaleIngredient } from '../scale';
import { formatMinutes } from '../sections';
import type { Recipe, Section } from '../types';

export function RecipeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const recipe = useQuery({ queryKey: ['recipe', id], queryFn: () => api.getRecipe(id!) });

  if (recipe.isPending) return null;
  if (recipe.error) return <p className="page error">{recipe.error.message}</p>;
  return <RecipeView key={recipe.data.id} recipe={recipe.data} />;
}

function RecipeView({ recipe }: { recipe: Recipe }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const img = imageUrl(recipe.image);

  const plan = useQuery({ queryKey: ['plan'], queryFn: api.plan });
  const planned = plan.data?.find((p) => p.recipe.id === recipe.id);

  // Opening from "This week" (?scale=) shows the amount that was planned.
  const [scale, setScale] = useState(() => Number(params.get('scale')) || 1);
  const [picking, setPicking] = useState(false);

  const favorite = useMutation({
    mutationFn: () => api.setFavorite(recipe.id, !recipe.favorite),
    onSuccess: ({ favorite }) => {
      queryClient.setQueryData<Recipe>(['recipe', recipe.id], (r) => r && { ...r, favorite });
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
    },
  });

  const togglePlan = useMutation({
    mutationFn: () =>
      planned && planned.scale === scale
        ? api.removePlanItem(planned.id)
        : api.addToPlan(recipe.id, scale).then(() => undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plan'] }),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteRecipe(recipe.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      navigate('/', { replace: true });
    },
  });

  const times = [
    ['Prep', formatMinutes(recipe.prepMinutes)],
    ['Cook', formatMinutes(recipe.cookMinutes)],
    ['Total', formatMinutes(recipe.totalMinutes)],
  ].filter(([, v]) => v);

  const planLabel = !planned
    ? '+ Add to this week'
    : planned.scale === scale
      ? '✓ On this week'
      : 'Update this week';

  return (
    <article className="page recipe">
      {img && (
        <img
          className="hero"
          src={img}
          alt=""
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}

      {recipe.needsReview && (
        <div className="banner">
          AI pulled this recipe from a page without structured data. Give it a once-over; saving
          it from Edit clears this note.
        </div>
      )}

      <h1 className="recipe-title">{recipe.title}</h1>
      {recipe.description && <p className="recipe-desc">{recipe.description}</p>}

      {times.length > 0 && (
        <dl className="meta-grid">
          {times.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="actions">
        {recipe.instructions.length > 0 && (
          <Link to={`/r/${recipe.id}/cook${scale !== 1 ? `?scale=${scale}` : ''}`} className="btn btn-primary">
            Start cooking
          </Link>
        )}
        <button
          type="button"
          className={`btn ${planned && planned.scale === scale ? 'btn-on' : ''}`}
          onClick={() => togglePlan.mutate()}
          disabled={togglePlan.isPending || plan.isPending}
        >
          {planLabel}
        </button>
        <button type="button" className="btn" onClick={() => setPicking(true)} disabled={recipe.ingredients.length === 0}>
          Add groceries
        </button>
        <button type="button" className="btn" onClick={() => favorite.mutate()}>
          {recipe.favorite ? '★' : '☆'}
          <span className="sr-only">{recipe.favorite ? 'Unfavorite' : 'Favorite'}</span>
        </button>
        <Link to={`/r/${recipe.id}/edit`} className="btn">
          Edit
        </Link>
      </div>

      <div className="ingredients-header">
        <h2>Ingredients</h2>
        <ServingsControl servings={recipe.servings} scale={scale} onChange={setScale} />
      </div>
      {scale !== 1 && (
        <p className="muted small">Amounts adjusted. Quantities mentioned in the steps are as written.</p>
      )}
      <CheckSections
        sections={recipe.ingredients}
        kind="ingredients"
        render={(item) => scaleIngredient(item, scale)}
      />

      <h2>Instructions</h2>
      <CheckSections
        sections={recipe.instructions}
        kind="steps"
        render={(item) => <StepText text={item} recipeTitle={recipe.title} />}
      />

      {recipe.notes && (
        <>
          <h2>Notes</h2>
          <p className="notes">{recipe.notes}</p>
        </>
      )}

      <footer className="recipe-footer">
        {recipe.tags.length > 0 && (
          <div className="chips">
            {recipe.tags.map((t) => (
              <Link key={t} to={`/?tag=${encodeURIComponent(t)}`} className="chip">
                {t}
              </Link>
            ))}
          </div>
        )}
        {recipe.sourceUrl && (
          <a href={recipe.sourceUrl} target="_blank" rel="noreferrer" className="source-link">
            Original recipe ↗
          </a>
        )}
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => confirm(`Delete "${recipe.title}"?`) && remove.mutate()}
        >
          Delete recipe
        </button>
      </footer>

      {picking && (
        <GroceryPicker
          recipes={[{ id: recipe.id, title: recipe.title, ingredients: recipe.ingredients, scale }]}
          onClose={() => setPicking(false)}
        />
      )}
    </article>
  );
}

/** Tap an ingredient or step to cross it off while cooking. Not persisted. */
function CheckSections({
  sections,
  kind,
  render,
}: {
  sections: Section[];
  kind: 'ingredients' | 'steps';
  render: (item: string) => ReactNode;
}) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (sections.length === 0) return <p className="muted">None listed.</p>;

  const List = kind === 'steps' ? 'ol' : 'ul';
  return (
    <>
      {sections.map((section, si) => (
        <section key={si} className="check-section">
          {section.title && <h3>{section.title}</h3>}
          <List className={`check-list check-${kind}`}>
            {section.items.map((item, ii) => {
              const key = `${si}:${ii}`;
              return (
                <li key={key} className={done.has(key) ? 'done' : ''} onClick={() => toggle(key)}>
                  <span>{render(item)}</span>
                </li>
              );
            })}
          </List>
        </section>
      ))}
    </>
  );
}
