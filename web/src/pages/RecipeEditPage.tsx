import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { sectionsToText, textToSections } from '../sections';
import type { Recipe, RecipeInput } from '../types';

export function RecipeEditPage() {
  const { id } = useParams<{ id: string }>();
  const existing = useQuery({
    queryKey: ['recipe', id],
    queryFn: () => api.getRecipe(id!),
    enabled: Boolean(id),
  });

  if (id && existing.isPending) return null;
  if (existing.error) return <p className="page error">{existing.error.message}</p>;
  return <RecipeForm key={id ?? 'new'} recipe={existing.data} />;
}

interface FormState {
  title: string;
  description: string;
  servings: string;
  prepMinutes: string;
  cookMinutes: string;
  totalMinutes: string;
  ingredients: string;
  instructions: string;
  notes: string;
  tags: string;
  sourceUrl: string;
}

function toForm(r?: Recipe): FormState {
  return {
    title: r?.title ?? '',
    description: r?.description ?? '',
    servings: r?.servings ?? '',
    prepMinutes: r?.prepMinutes?.toString() ?? '',
    cookMinutes: r?.cookMinutes?.toString() ?? '',
    totalMinutes: r?.totalMinutes?.toString() ?? '',
    ingredients: sectionsToText(r?.ingredients ?? []),
    instructions: sectionsToText(r?.instructions ?? []),
    notes: r?.notes ?? '',
    tags: r?.tags.join(', ') ?? '',
    sourceUrl: r?.sourceUrl ?? '',
  };
}

const toInt = (s: string) => (s.trim() ? Math.max(0, Math.round(Number(s))) || null : null);

function RecipeForm({ recipe }: { recipe?: Recipe }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => toForm(recipe));
  const set = (key: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const input: RecipeInput = {
        title: form.title,
        description: form.description || null,
        source: recipe?.source ?? 'MANUAL',
        sourceUrl: form.sourceUrl || null,
        servings: form.servings || null,
        prepMinutes: toInt(form.prepMinutes),
        cookMinutes: toInt(form.cookMinutes),
        totalMinutes: toInt(form.totalMinutes),
        ingredients: textToSections(form.ingredients),
        instructions: textToSections(form.instructions),
        notes: form.notes || null,
        favorite: recipe?.favorite ?? false,
        tags: form.tags.split(','),
      };
      return recipe ? api.updateRecipe(recipe.id, input) : api.createRecipe(input);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['recipe', saved.id], saved);
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      navigate(`/r/${saved.id}`, { replace: true });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <form className="page form" onSubmit={submit}>
      <h1>{recipe ? 'Edit recipe' : 'New recipe'}</h1>

      <label className="field">
        <span>Title</span>
        <input value={form.title} onChange={set('title')} required />
      </label>

      <label className="field">
        <span>Description</span>
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Prep (min)</span>
          <input inputMode="numeric" value={form.prepMinutes} onChange={set('prepMinutes')} />
        </label>
        <label className="field">
          <span>Cook (min)</span>
          <input inputMode="numeric" value={form.cookMinutes} onChange={set('cookMinutes')} />
        </label>
        <label className="field">
          <span>Total (min)</span>
          <input inputMode="numeric" value={form.totalMinutes} onChange={set('totalMinutes')} />
        </label>
      </div>

      <label className="field">
        <span>Servings</span>
        <input value={form.servings} onChange={set('servings')} placeholder="4" />
      </label>

      <label className="field">
        <span>Ingredients</span>
        <small>One per line. End a line with “:” to start a section.</small>
        <textarea
          rows={10}
          value={form.ingredients}
          onChange={set('ingredients')}
          placeholder={'2 cups flour\n1 tsp salt\n\nFor the glaze:\n1 cup powdered sugar'}
        />
      </label>

      <label className="field">
        <span>Instructions</span>
        <small>One step per line.</small>
        <textarea rows={10} value={form.instructions} onChange={set('instructions')} />
      </label>

      <label className="field">
        <span>Notes</span>
        <textarea rows={3} value={form.notes} onChange={set('notes')} />
      </label>

      <label className="field">
        <span>Tags</span>
        <input value={form.tags} onChange={set('tags')} placeholder="dinner, chicken, quick" />
      </label>

      <label className="field">
        <span>Source URL</span>
        <input type="url" value={form.sourceUrl} onChange={set('sourceUrl')} />
      </label>

      {save.error && <p className="error">{save.error.message}</p>}

      <div className="form-actions">
        <button type="button" className="btn" onClick={() => navigate(-1)}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
