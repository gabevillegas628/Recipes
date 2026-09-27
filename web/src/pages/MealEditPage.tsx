import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import type { Meal } from '../types';

export function MealEditPage() {
  const { id } = useParams<{ id: string }>();
  const existing = useQuery({ queryKey: ['meal', id], queryFn: () => api.meal(id!), enabled: Boolean(id) });

  if (id && existing.isPending) return null;
  if (existing.error) return <p className="page error">{existing.error.message}</p>;
  return <MealForm key={id ?? 'new'} meal={existing.data} />;
}

interface Row {
  id: string;
  title: string;
  image: string | null;
  scale: number;
}

const AMOUNTS = [0.5, 1, 1.5, 2, 3];

function MealForm({ meal }: { meal?: Meal }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [name, setName] = useState(meal?.name ?? '');
  const [serves, setServes] = useState(meal?.servings?.toString() ?? '');
  const [notes, setNotes] = useState(meal?.notes ?? '');
  const [rows, setRows] = useState<Row[]>(
    () => meal?.recipes.map(({ recipe, scale }) => ({ id: recipe.id, title: recipe.title, image: recipe.image, scale })) ?? [],
  );

  // Starting a meal from a recipe page (/meals/new?recipe=<id>) pre-adds that recipe.
  const startWith = params.get('recipe');
  const starter = useQuery({
    queryKey: ['recipe', startWith],
    queryFn: () => api.getRecipe(startWith!),
    enabled: Boolean(startWith) && !meal,
  });
  useEffect(() => {
    const r = starter.data;
    if (!r) return;
    setRows((prev) => (prev.some((p) => p.id === r.id) ? prev : [...prev, { id: r.id, title: r.title, image: r.image, scale: 1 }]));
  }, [starter.data]);

  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['recipes', { q, tag: undefined, favorite: false }],
    queryFn: () => api.listRecipes({ q }),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });

  const move = (i: number, delta: number) =>
    setRows((prev) => {
      const next = [...prev];
      const [row] = next.splice(i, 1);
      next.splice(Math.max(0, Math.min(next.length, i + delta)), 0, row);
      return next;
    });

  const save = useMutation({
    mutationFn: async () => {
      const servings = Number.parseInt(serves, 10) || null;
      const recipes = rows.map((r) => ({ recipeId: r.id, scale: r.scale }));
      if (meal) {
        await api.updateMeal(meal.id, { name, notes: notes || null, servings, recipes });
        return meal.id;
      }
      const created = await api.createMeal({ name, notes: notes || null, servings, recipeIds: rows.map((r) => r.id) });
      // New meals start at 1× per recipe; apply any amounts chosen while creating.
      if (rows.some((r) => r.scale !== 1)) await api.updateMeal(created.id, { recipes });
      return created.id;
    },
    onSuccess: (mealId) => {
      queryClient.invalidateQueries({ queryKey: ['meals'] });
      queryClient.invalidateQueries({ queryKey: ['meal', mealId] });
      navigate(`/m/${mealId}`, { replace: true });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteMeal(meal!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meals'] });
      navigate('/meals', { replace: true });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  const present = new Set(rows.map((r) => r.id));

  return (
    <form className="page form" onSubmit={submit}>
      <h1 className="form-title">{meal ? 'Edit meal' : 'New meal'}</h1>

      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Taco night" required />
      </label>

      <label className="field">
        <span>Serves</span>
        <small>How many people this meal feeds as planned. The meal's servings stepper scales from this.</small>
        <input inputMode="numeric" value={serves} onChange={(e) => setServes(e.target.value.replace(/\D/g, ''))} placeholder="4" />
      </label>

      <div className="field">
        <span>Recipes</span>
        {rows.length === 0 && <small>Search below to add recipes.</small>}
        <ul className="meal-rows">
          {rows.map((r, i) => (
            <li key={r.id} className="meal-row">
              <div className="meal-row-top">
                {r.image ? (
                  <img className="thumb thumb-small" src={thumbUrl(r.image)!} alt="" />
                ) : (
                  <div className="thumb thumb-small thumb-empty">{r.title.charAt(0)}</div>
                )}
                <span className="meal-row-title">{r.title}</span>
                <button type="button" className="cook-icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                  ↑
                </button>
                <button type="button" className="cook-icon-btn" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down">
                  ↓
                </button>
                <button
                  type="button"
                  className="cook-icon-btn"
                  onClick={() => setRows((prev) => prev.filter((p) => p.id !== r.id))}
                  aria-label="Remove from meal"
                >
                  ✕
                </button>
              </div>
              <div className="chips meal-row-amounts">
                <span className="muted small">Make</span>
                {AMOUNTS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={`chip ${r.scale === a ? 'chip-on' : ''}`}
                    onClick={() => setRows((prev) => prev.map((p) => (p.id === r.id ? { ...p, scale: a } : p)))}
                  >
                    {a === 0.5 ? '½' : a === 1.5 ? '1½' : a}×
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>

        <input
          className="search"
          type="search"
          placeholder="Search your recipes to add…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q.trim() && (
          <ul className="meal-search">
            {results.data
              ?.filter((r) => !present.has(r.id))
              .slice(0, 8)
              .map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="meal-search-item"
                    onClick={() => {
                      setRows((prev) => [...prev, { id: r.id, title: r.title, image: r.image, scale: 1 }]);
                      setQ('');
                    }}
                  >
                    <span className="meal-search-plus">+</span> {r.title}
                  </button>
                </li>
              ))}
            {results.data && results.data.filter((r) => !present.has(r.id)).length === 0 && (
              <li className="muted small">No other matches.</li>
            )}
          </ul>
        )}
      </div>

      <label className="field">
        <span>Notes</span>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Turkey in by 11, rolls last" />
      </label>

      {save.error && <p className="error">{save.error.message}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => navigate(-1)}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={save.isPending || !name.trim()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>

      {meal && (
        <div className="recipe-footer">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => confirm(`Delete the "${meal.name}" meal? Its recipes stay.`) && remove.mutate()}
          >
            Delete meal
          </button>
        </div>
      )}
    </form>
  );
}
