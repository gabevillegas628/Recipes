import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { scaleIngredient } from '../scale';
import type { PrepPlan, Recipe } from '../types';
import { useWakeLock } from '../useWakeLock';

/**
 * The server builds the plan once per version of the recipe, so keying on
 * updatedAt refetches after an edit and never otherwise.
 */
export function usePrep(recipe: Recipe) {
  return useQuery({
    queryKey: ['prep', recipe.id, recipe.updatedAt],
    queryFn: () => api.getPrep(recipe.id),
    staleTime: Infinity,
    retry: false,
  });
}

/** Ingredient lines in the same order the plan numbers them. */
export function ingredientLines(recipe: Recipe): string[] {
  return recipe.ingredients.flatMap((s) => s.items);
}

/** "½ teaspoon pepper (half)", scaled. Notes like "2 tbsp" scale too. */
export function bowlLine(line: string, note: string | null, scale: number): string {
  const scaled = scaleIngredient(line, scale);
  return note ? `${scaled} (${scaleIngredient(note, scale)})` : scaled;
}

/** Mise en place before cook mode: knife work, then one bowl per moment things go in together. */
export function PrepPage() {
  const { id } = useParams<{ id: string }>();
  const recipe = useQuery({ queryKey: ['recipe', id], queryFn: () => api.getRecipe(id!) });

  if (recipe.isPending) return <div className="cook" />;
  if (recipe.error) return <p className="page error">{recipe.error.message}</p>;
  return <Prep recipe={recipe.data} />;
}

// Ticks survive a reload or a locked phone, like the cook mode step.
const storageKey = (id: string) => `prep-done:${id}`;
function loadDone(id: string): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(storageKey(id)) ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveDone(id: string, done: Set<string>) {
  try {
    sessionStorage.setItem(storageKey(id), JSON.stringify([...done]));
  } catch {
    // Storage unavailable (private mode); not important.
  }
}

function Prep({ recipe }: { recipe: Recipe }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scale = Number(params.get('scale')) || 1;
  const query = scale !== 1 ? `?scale=${scale}` : '';
  useWakeLock({ auto: true });

  const prep = usePrep(recipe);
  const lines = useMemo(() => ingredientLines(recipe), [recipe]);
  const [done, setDone] = useState(() => loadDone(recipe.id));

  const toggle = (key: string) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveDone(recipe.id, next);
      return next;
    });

  return (
    <div className="cook">
      <header className="cook-header">
        <button
          type="button"
          className="cook-icon-btn"
          onClick={() => navigate(`/r/${recipe.id}${query}`, { replace: true })}
          aria-label="Back to recipe"
        >
          ✕
        </button>
        <div className="cook-title">Prep · {recipe.title}</div>
      </header>

      <main className="cook-body">
        {prep.isPending && (
          <div className="prep-loading">
            <p>Planning your mise en place…</p>
            <p className="muted">This takes a few seconds the first time.</p>
          </div>
        )}
        {prep.error && <p className="error">{prep.error.message}</p>}
        {prep.data && <PrepLists plan={prep.data} lines={lines} scale={scale} done={done} onToggle={toggle} />}
      </main>

      <footer className="cook-footer">
        <Link to={`/r/${recipe.id}/cook${query}`} replace className="btn btn-primary cook-nav">
          Start cooking
        </Link>
      </footer>
    </div>
  );
}

function PrepLists({
  plan,
  lines,
  scale,
  done,
  onToggle,
}: {
  plan: PrepPlan;
  lines: string[];
  scale: number;
  done: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (plan.tasks.length === 0 && plan.bowls.length === 0) {
    return <p className="muted">Nothing to prep for this one.</p>;
  }
  return (
    <>
      {plan.tasks.length > 0 && (
        <section className="prep-section">
          <h2>Knife work</h2>
          <ul className="check-list prep-list">
            {plan.tasks.map((task, i) => {
              const key = `t${i}`;
              return (
                <li key={key} className={done.has(key) ? 'done' : ''} onClick={() => onToggle(key)}>
                  <span className="prep-title">{task.text}</span>
                  {task.ingredients.map((n) => (
                    <span key={n} className="prep-line">
                      {scaleIngredient(lines[n], scale)}
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {plan.bowls.length > 0 && (
        <section className="prep-section">
          <h2>Bowls</h2>
          <ul className="check-list prep-list">
            {plan.bowls.map((bowl, i) => {
              const key = `b${i}`;
              return (
                <li key={key} className={done.has(key) ? 'done' : ''} onClick={() => onToggle(key)}>
                  <span className="prep-title">
                    {bowl.label}
                    <span className="prep-step">Step {bowl.step + 1}</span>
                  </span>
                  {bowl.items.map((item, j) => (
                    <span key={j} className="prep-line">
                      {bowlLine(lines[item.ingredient], item.note, scale)}
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
