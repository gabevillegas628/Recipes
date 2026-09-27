import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';

/** Sheet on a recipe page: add this recipe to an existing meal, or start a new one with it. */
export function AddToMeal({ recipeId, onClose }: { recipeId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const meals = useQuery({ queryKey: ['meals'], queryFn: api.meals });

  const add = useMutation({
    mutationFn: (mealId: string) => api.addRecipeToMeal(mealId, recipeId),
    onSuccess: (_, mealId) => {
      queryClient.invalidateQueries({ queryKey: ['meals'] });
      queryClient.invalidateQueries({ queryKey: ['meal', mealId] });
    },
  });
  const addedTo = add.isSuccess ? meals.data?.find((m) => m.id === add.variables) : null;

  return (
    <div className="cook-sheet-backdrop" onClick={onClose}>
      <section className="cook-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cook-sheet-header">
          <h2>Add to meal</h2>
          <button type="button" className="cook-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {addedTo ? (
          <div className="banner">
            Added to <Link to={`/m/${addedTo.id}`}>{addedTo.name}</Link>.
          </div>
        ) : (
          <>
            <ul className="meal-choices">
              {meals.data?.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="meal-choice"
                    onClick={() => add.mutate(m.id)}
                    disabled={add.isPending}
                  >
                    <strong>{m.name}</strong>
                    <span className="muted small">{m.recipeTitles.join(', ') || 'No recipes yet'}</span>
                  </button>
                </li>
              ))}
            </ul>
            {add.error && <p className="error">{add.error.message}</p>}
            <Link to={`/meals/new?recipe=${recipeId}`} className="btn btn-primary meal-new">
              + New meal with this recipe
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
