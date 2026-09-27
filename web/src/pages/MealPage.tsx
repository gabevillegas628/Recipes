import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import { Collage } from '../components/Collage';
import { GroceryPicker } from '../components/GroceryPicker';
import { ServingsControl } from '../components/ServingsControl';
import { servingsLabel } from '../scale';
import type { Meal } from '../types';

export function MealPage() {
  const { id } = useParams<{ id: string }>();
  const meal = useQuery({ queryKey: ['meal', id], queryFn: () => api.meal(id!) });

  if (meal.isPending) return null;
  if (meal.error) return <p className="page error">{meal.error.message}</p>;
  return <MealView key={meal.data.id} meal={meal.data} />;
}

function MealView({ meal }: { meal: Meal }) {
  const queryClient = useQueryClient();
  // The meal's own servings stepper: scales every recipe at once.
  const [factor, setFactor] = useState(1);
  const [picking, setPicking] = useState(false);
  const [added, setAdded] = useState(false);

  const plan = useMutation({
    mutationFn: () => api.addMealToPlan(meal.id, factor),
    onSuccess: () => {
      setAdded(true);
      queryClient.invalidateQueries({ queryKey: ['plan'] });
    },
  });

  const images = meal.recipes.map((r) => r.recipe.image).filter((i): i is string => Boolean(i));

  return (
    <article className="page recipe">
      <Collage images={images} name={meal.name} className="meal-hero" />

      <h1 className="recipe-title">{meal.name}</h1>
      {meal.notes && <p className="notes recipe-desc">{meal.notes}</p>}

      <div className="actions">
        <button
          type="button"
          className={`btn btn-primary ${added ? 'btn-on' : ''}`}
          onClick={() => plan.mutate()}
          disabled={plan.isPending || meal.recipes.length === 0}
        >
          {added ? '✓ On this week' : '+ Add to this week'}
        </button>
        <button type="button" className="btn" onClick={() => setPicking(true)} disabled={meal.recipes.length === 0}>
          Add groceries
        </button>
        <Link to={`/m/${meal.id}/edit`} className="btn">
          Edit
        </Link>
      </div>
      {plan.error && <p className="error">{plan.error.message}</p>}

      <div className="ingredients-header">
        <h2>Recipes</h2>
        <ServingsControl
          servings={meal.servings ? String(meal.servings) : null}
          scale={factor}
          onChange={(f) => {
            setFactor(f);
            setAdded(false);
          }}
        />
      </div>

      {meal.recipes.length === 0 ? (
        <p className="muted">
          No recipes yet. <Link to={`/m/${meal.id}/edit`}>Add some</Link>.
        </p>
      ) : (
        <ul className="recipe-list">
          {meal.recipes.map(({ recipe, scale }) => {
            const total = scale * factor;
            const img = thumbUrl(recipe.image);
            return (
              <li key={recipe.id}>
                <Link to={`/r/${recipe.id}${total !== 1 ? `?scale=${total}` : ''}`} className="recipe-row">
                  {img ? (
                    <img className="thumb thumb-small" src={img} alt="" />
                  ) : (
                    <div className="thumb thumb-small thumb-empty">{recipe.title.charAt(0)}</div>
                  )}
                  <div className="recipe-row-body">
                    <div className="recipe-row-title">{recipe.title}</div>
                    <div className="recipe-row-meta">{servingsLabel(recipe.servings, total) ?? ''}</div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {picking && (
        <GroceryPicker
          recipes={meal.recipes.map(({ recipe, scale }) => ({ ...recipe, scale: scale * factor }))}
          onClose={() => setPicking(false)}
        />
      )}
    </article>
  );
}
