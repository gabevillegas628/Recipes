import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, imageUrl } from '../api';
import { useWakeLock } from '../useWakeLock';
import { formatMinutes } from '../sections';
import type { Recipe, Section } from '../types';

export function RecipeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const recipe = useQuery({ queryKey: ['recipe', id], queryFn: () => api.getRecipe(id!) });

  if (recipe.isPending) return null;
  if (recipe.error) return <p className="page error">{recipe.error.message}</p>;
  return <RecipeView recipe={recipe.data} />;
}

function RecipeView({ recipe }: { recipe: Recipe }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const wakeLock = useWakeLock();
  const img = imageUrl(recipe.image);

  const favorite = useMutation({
    mutationFn: () => api.setFavorite(recipe.id, !recipe.favorite),
    onSuccess: ({ favorite }) => {
      queryClient.setQueryData<Recipe>(['recipe', recipe.id], (r) => r && { ...r, favorite });
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
    },
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
    ['Serves', recipe.servings],
  ].filter(([, v]) => v);

  return (
    <article className="page recipe">
      {img && <img className="hero" src={img} alt="" />}

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
        <button type="button" className="btn" onClick={() => favorite.mutate()}>
          {recipe.favorite ? '★ Favorited' : '☆ Favorite'}
        </button>
        {wakeLock.supported && (
          <button
            type="button"
            className={`btn ${wakeLock.active ? 'btn-on' : ''}`}
            onClick={wakeLock.toggle}
          >
            {wakeLock.active ? 'Screen stays on' : 'Keep screen on'}
          </button>
        )}
        <Link to={`/r/${recipe.id}/edit`} className="btn">
          Edit
        </Link>
      </div>

      <h2>Ingredients</h2>
      <CheckSections sections={recipe.ingredients} kind="ingredients" />

      <h2>Instructions</h2>
      <CheckSections sections={recipe.instructions} kind="steps" />

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
    </article>
  );
}

/** Tap an ingredient or step to cross it off while cooking. Not persisted. */
function CheckSections({ sections, kind }: { sections: Section[]; kind: 'ingredients' | 'steps' }) {
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
                <li
                  key={key}
                  className={done.has(key) ? 'done' : ''}
                  onClick={() => toggle(key)}
                >
                  {item}
                </li>
              );
            })}
          </List>
        </section>
      ))}
    </>
  );
}
