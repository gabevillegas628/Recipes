import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { MealSwitcher, recipeQuery, useMealParam } from '../components/MealSwitcher';
import { StepText } from '../components/StepText';
import { scaleIngredient } from '../scale';
import type { Recipe } from '../types';
import { bowlLine, ingredientLines, usePrep } from './PrepPage';
import { useWakeLock } from '../useWakeLock';

/** Full-screen, one step at a time, screen kept awake. */
export function CookModePage() {
  const { id } = useParams<{ id: string }>();
  const recipe = useQuery({ queryKey: ['recipe', id], queryFn: () => api.getRecipe(id!) });

  if (recipe.isPending) return <div className="cook" />;
  if (recipe.error) return <p className="page error">{recipe.error.message}</p>;
  // Keyed so switching recipes within a meal starts fresh (at that recipe's saved step).
  return <CookMode key={recipe.data.id} recipe={recipe.data} />;
}

interface Step {
  text: string;
  section: string | null;
}

// Remember the current step per recipe, so a reload or a locked phone doesn't lose your place.
const storageKey = (id: string) => `cook-step:${id}`;
function loadStep(id: string) {
  try {
    return Number(sessionStorage.getItem(storageKey(id))) || 0;
  } catch {
    return 0;
  }
}
function saveStep(id: string, step: number) {
  try {
    sessionStorage.setItem(storageKey(id), String(step));
  } catch {
    // Storage unavailable (private mode); not important.
  }
}

function CookMode({ recipe }: { recipe: Recipe }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scale = Number(params.get('scale')) || 1;
  const mealId = useMealParam();
  const query = recipeQuery(scale, mealId);
  const wakeLock = useWakeLock({ auto: true });
  const steps = useMemo<Step[]>(
    () => recipe.instructions.flatMap((s) => s.items.map((text) => ({ text, section: s.title }))),
    [recipe.instructions],
  );
  const [index, setIndex] = useState(() => Math.min(loadStep(recipe.id), Math.max(steps.length - 1, 0)));
  const [showIngredients, setShowIngredients] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const prep = usePrep(recipe);
  const lines = useMemo(() => ingredientLines(recipe), [recipe]);

  const last = steps.length - 1;
  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(last, next));
      setIndex(clamped);
      saveStep(recipe.id, clamped);
    },
    [last, recipe.id],
  );

  const exit = useCallback(
    () => navigate(`/r/${recipe.id}${query}`, { replace: true }),
    [navigate, recipe.id, query],
  );

  // Arrow keys on a laptop/tablet keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') go(index + 1);
      else if (e.key === 'ArrowLeft') go(index - 1);
      else if (e.key === 'Escape') exit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index, exit]);

  // Swipe left/right between steps.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(index + (dx < 0 ? 1 : -1));
  };

  const toggleIngredient = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const step = steps[index];
  const bowls = prep.data?.bowls.filter((b) => b.step === index) ?? [];

  return (
    <div className="cook">
      <header className="cook-header">
        <button type="button" className="cook-icon-btn" onClick={exit} aria-label="Exit cook mode">
          ✕
        </button>
        <div className="cook-title">{recipe.title}</div>
        <Link to={`/r/${recipe.id}/prep${query}`} replace className="cook-pill">
          Prep
        </Link>
        <button
          type="button"
          className={`cook-pill ${showIngredients ? 'on' : ''}`}
          onClick={() => setShowIngredients((v) => !v)}
        >
          Ingredients
        </button>
      </header>
      <MealSwitcher mealId={mealId} recipeId={recipe.id} scale={scale} mode="cook" />

      {steps.length === 0 ? (
        <main className="cook-body">
          <p className="cook-step">This recipe has no steps yet.</p>
          <Link to={`/r/${recipe.id}/edit`} className="btn">
            Add steps
          </Link>
        </main>
      ) : (
        <main className="cook-body" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="cook-progress" aria-hidden>
            {steps.map((_, i) => (
              <span key={i} className={i <= index ? 'on' : ''} />
            ))}
          </div>
          <p className="cook-count">
            Step {index + 1} of {steps.length}
            {step.section ? ` · ${step.section}` : ''}
          </p>
          <p className="cook-step">
            <StepText text={step.text} recipeTitle={recipe.title} />
          </p>
          {bowls.length > 0 && (
            <ul className="cook-bowls">
              {bowls.map((bowl, i) => (
                <li key={i}>
                  <strong>{bowl.label}</strong>
                  {bowl.items.map((item, j) => (
                    <span key={j}>{bowlLine(lines[item.ingredient], item.note, scale)}</span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </main>
      )}

      {steps.length > 0 && (
        <footer className="cook-footer">
          <button type="button" className="btn cook-nav" onClick={() => go(index - 1)} disabled={index === 0}>
            Back
          </button>
          {index < last ? (
            <button type="button" className="btn btn-primary cook-nav" onClick={() => go(index + 1)}>
              Next
            </button>
          ) : (
            <button type="button" className="btn btn-primary cook-nav" onClick={exit}>
              Done
            </button>
          )}
        </footer>
      )}

      {wakeLock.supported && (
        <p className="cook-wake">{wakeLock.active ? 'Screen will stay on' : ''}</p>
      )}

      {showIngredients && (
        <div className="cook-sheet-backdrop" onClick={() => setShowIngredients(false)}>
          <section className="cook-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cook-sheet-header">
              <h2>Ingredients</h2>
              <button type="button" className="cook-icon-btn" onClick={() => setShowIngredients(false)} aria-label="Close">
                ✕
              </button>
            </div>
            {recipe.ingredients.map((section, si) => (
              <div key={si}>
                {section.title && <h3>{section.title}</h3>}
                <ul className="check-list">
                  {section.items.map((item, ii) => {
                    const key = `${si}:${ii}`;
                    return (
                      <li key={key} className={checked.has(key) ? 'done' : ''} onClick={() => toggleIngredient(key)}>
                        {scaleIngredient(item, scale)}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
