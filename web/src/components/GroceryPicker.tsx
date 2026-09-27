import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { scaleIngredient } from '../scale';
import type { Section } from '../types';

export interface PickerRecipe {
  id: string;
  title: string;
  ingredients: Section[];
  scale: number;
}

/**
 * Choose which ingredients to add to the grocery list: everything starts ticked,
 * untick what's already in the pantry.
 */
export function GroceryPicker({ recipes, onClose }: { recipes: PickerRecipe[]; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const lines = useMemo(
    () =>
      recipes.map((r) => ({
        recipe: r,
        items: r.ingredients.flatMap((s, si) =>
          s.items.map((text, ii) => ({ key: `${r.id}:${si}:${ii}`, text: scaleIngredient(text, r.scale) })),
        ),
      })),
    [recipes],
  );
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chosen = lines.flatMap((g) =>
    g.items.filter((i) => !skipped.has(i.key)).map((i) => ({ text: i.text, recipeId: g.recipe.id })),
  );

  const add = useMutation({
    mutationFn: () => api.addGroceries(chosen),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groceries'] });
      navigate('/groceries');
    },
  });

  return (
    <div className="cook-sheet-backdrop" onClick={onClose}>
      <section className="cook-sheet picker" onClick={(e) => e.stopPropagation()}>
        <div className="cook-sheet-header">
          <h2>Add to grocery list</h2>
          <button type="button" className="cook-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="muted">Untick anything you already have.</p>

        {lines.map((g) => {
          const allOff = g.items.every((i) => skipped.has(i.key));
          return (
            <div key={g.recipe.id} className="picker-group">
              {lines.length > 1 && (
                <div className="picker-group-header">
                  <h3>{g.recipe.title}</h3>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() =>
                      setSkipped((prev) => {
                        const next = new Set(prev);
                        for (const i of g.items) {
                          if (allOff) next.delete(i.key);
                          else next.add(i.key);
                        }
                        return next;
                      })
                    }
                  >
                    {allOff ? 'Select all' : 'Skip all'}
                  </button>
                </div>
              )}
              {g.items.map((i) => (
                <label key={i.key} className="picker-item">
                  <input type="checkbox" checked={!skipped.has(i.key)} onChange={() => toggle(i.key)} />
                  <span>{i.text}</span>
                </label>
              ))}
            </div>
          );
        })}

        {add.error && <p className="error">{add.error.message}</p>}
        <div className="picker-footer">
          <button
            type="button"
            className="btn btn-primary"
            disabled={chosen.length === 0 || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? 'Sorting into aisles…' : `Add ${chosen.length} item${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </section>
    </div>
  );
}
