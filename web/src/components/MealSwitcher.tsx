import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';

type Mode = 'view' | 'prep' | 'cook';

/** "?scale=2&meal=abc", or "" when there's nothing to carry. */
export function recipeQuery(scale: number, mealId: string | null): string {
  const params = new URLSearchParams();
  if (scale !== 1) params.set('scale', String(Math.round(scale * 1000) / 1000));
  if (mealId) params.set('meal', mealId);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** The meal a recipe was opened from (?meal=), carried through prep and cook mode. */
export function useMealParam(): string | null {
  const [params] = useSearchParams();
  return params.get('meal');
}

/**
 * The other recipes in the meal this one was opened from, one tap away, in the
 * same mode (recipe, prep or cook). Only shows when opened from a meal, so a
 * recipe that's in several meals switches within the one you're cooking.
 */
export function MealSwitcher({
  mealId,
  recipeId,
  scale,
  mode,
}: {
  mealId: string | null;
  recipeId: string;
  scale: number;
  mode: Mode;
}) {
  const meal = useQuery({ queryKey: ['meal', mealId], queryFn: () => api.meal(mealId!), enabled: Boolean(mealId) });
  const recipes = meal.data?.recipes ?? [];
  const current = recipes.find((r) => r.recipe.id === recipeId);
  if (!current || recipes.length < 2) return null;

  // The meal's servings stepper multiplies every recipe alike; keep that when switching.
  const factor = scale / current.scale;
  const suffix = mode === 'view' ? '' : `/${mode}`;

  return (
    <nav className={`meal-switcher ${mode === 'view' ? '' : 'in-cook'}`} aria-label={`Recipes in ${meal.data!.name}`}>
      <span className="meal-switcher-name">{meal.data!.name}</span>
      <div className="chips">
        {recipes.map(({ recipe, scale: own }) => (
          <Link
            key={recipe.id}
            to={`/r/${recipe.id}${suffix}${recipeQuery(own * factor, mealId)}`}
            replace
            className={`chip ${recipe.id === recipeId ? 'chip-on' : ''}`}
            aria-current={recipe.id === recipeId ? 'page' : undefined}
          >
            {recipe.title}
          </Link>
        ))}
      </div>
    </nav>
  );
}
