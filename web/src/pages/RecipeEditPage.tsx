import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CATEGORY_GROUPS, normalizeCategories } from '../../../server/src/categoryList';
import { api, imageUrl } from '../api';
import { PhotoInput } from '../components/PhotoInput';
import { shrinkPhoto } from '../photos';
import { sectionsToText, textToSections } from '../sections';
import type { Recipe, RecipeDraft, RecipeInput } from '../types';

export function RecipeEditPage() {
  const { id } = useParams<{ id: string }>();
  const existing = useQuery({
    queryKey: ['recipe', id],
    queryFn: () => api.getRecipe(id!),
    enabled: Boolean(id),
  });

  if (id && existing.isPending) return null;
  if (existing.error) return <p className="page error">{existing.error.message}</p>;
  return (
    <div className="page">
      <h1 className="form-title">{existing.data ? 'Edit recipe' : 'New recipe'}</h1>
      <RecipeForm key={id ?? 'new'} recipe={existing.data} />
    </div>
  );
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
  /** Categories (categoryList.ts). */
  tags: string[];
  sourceUrl: string;
  /** A new image to download on save. */
  imageUrl: string;
}

type Initial = (Recipe | RecipeDraft) | undefined;

function toForm(r: Initial): FormState {
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
    tags: normalizeCategories(r?.tags ?? []),
    sourceUrl: r?.sourceUrl ?? '',
    imageUrl: r && 'imageUrl' in r ? (r.imageUrl ?? '') : '',
  };
}

const toInt = (s: string) => (s.trim() ? Math.max(0, Math.round(Number(s))) || null : null);

/**
 * Create/edit form. Pass `recipe` to edit an existing one, or `draft` to review
 * an imported recipe before saving it.
 */
export function RecipeForm({
  recipe,
  draft,
  onCancel,
  banner,
}: {
  recipe?: Recipe;
  draft?: RecipeDraft;
  onCancel?: () => void;
  banner?: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => toForm(recipe ?? draft));
  const [removeImage, setRemoveImage] = useState(false);
  const [uploaded, setUploaded] = useState<string | null>(draft?.uploadedImage ?? null);

  const upload = useMutation({
    mutationFn: async (file: File) => api.uploadImage(await shrinkPhoto(file)),
    onSuccess: ({ image }) => {
      setUploaded(image);
      setForm((f) => ({ ...f, imageUrl: '' }));
    },
  });
  const set = (key: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const currentImage = recipe && !removeImage ? imageUrl(recipe.image) : null;
  const preview = (uploaded && imageUrl(uploaded)) || form.imageUrl.trim() || currentImage;

  const save = useMutation({
    mutationFn: () => {
      const newImage = form.imageUrl.trim();
      const input: RecipeInput = {
        title: form.title,
        description: form.description || null,
        source: recipe?.source ?? (draft ? (draft.sourceUrl ? 'URL' : 'MANUAL') : 'MANUAL'),
        sourceUrl: form.sourceUrl || null,
        servings: form.servings || null,
        prepMinutes: toInt(form.prepMinutes),
        cookMinutes: toInt(form.cookMinutes),
        totalMinutes: toInt(form.totalMinutes),
        ingredients: textToSections(form.ingredients),
        instructions: textToSections(form.instructions),
        notes: form.notes || null,
        favorite: recipe?.favorite ?? false,
        tags: form.tags,
        imageUrl: newImage ? newImage : removeImage ? null : undefined,
        uploadedImage: uploaded ?? undefined,
      };
      return recipe ? api.updateRecipe(recipe.id, input) : api.createRecipe(input);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['recipe', saved.id], saved);
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      navigate(`/r/${saved.id}`, { replace: true });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <form className="form" onSubmit={submit}>
      {banner}

      <div className="photo-picker">
        {upload.isPending ? (
          <span className="muted">Uploading photo…</span>
        ) : (
          <>
            <PhotoInput camera onPick={([file]) => upload.mutate(file)}>
              📷 {preview ? 'Retake' : 'Take photo'}
            </PhotoInput>
            <PhotoInput multiple={false} onPick={([file]) => upload.mutate(file)}>
              {preview ? 'Change photo' : 'Choose photo'}
            </PhotoInput>
          </>
        )}
        {upload.error && <span className="error">{upload.error.message}</span>}
      </div>

      {preview && (
        <div className="image-preview">
          <img src={preview} alt="" />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setForm((f) => ({ ...f, imageUrl: '' }));
              setUploaded(null);
              if (recipe?.image) setRemoveImage(true);
            }}
          >
            Remove photo
          </button>
        </div>
      )}

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

      <div className="field">
        <span>Categories</span>
        <small>
          {form.tags.length ? 'Tap to add or remove.' : 'Pick some, or leave them all off and Claude sorts it after saving.'}
        </small>
        {CATEGORY_GROUPS.map((g) => (
          <div key={g.key} className="category-pick">
            <span className="category-pick-name">{g.name}</span>
            <div className="chips wrap-chips">
              {g.values.map((c) => {
                const on = form.tags.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    className={`chip ${on ? 'chip-on' : ''}`}
                    aria-pressed={on}
                    onClick={() =>
                      setForm((f) => ({ ...f, tags: on ? f.tags.filter((t) => t !== c) : normalizeCategories([...f.tags, c]) }))
                    }
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <label className="field">
        <span>Source URL</span>
        <input type="url" value={form.sourceUrl} onChange={set('sourceUrl')} />
      </label>

      <label className="field">
        <span>Photo link</span>
        <small>Paste an image address to use as the photo.</small>
        <input type="url" value={form.imageUrl} onChange={set('imageUrl')} />
      </label>

      {save.error && <p className="error">{save.error.message}</p>}

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel ?? (() => navigate(-1))}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
