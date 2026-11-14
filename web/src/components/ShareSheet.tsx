import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { baseServings, scaleIngredient } from '../scale';
import { formatMinutes } from '../sections';
import type { Recipe } from '../types';

/** The recipe as plain text, for Messages or email. Amounts follow the servings stepper; notes stay private. */
export function recipeText(recipe: Recipe, scale: number) {
  const base = baseServings(recipe.servings);
  const serves = base ? `Serves ${Math.round(base * scale * 100) / 100}` : recipe.servings && scale === 1 ? recipe.servings : null;
  const meta = [
    serves,
    scale !== 1 && !base ? `${scale}× the recipe` : null,
    formatMinutes(recipe.totalMinutes) && `Total ${formatMinutes(recipe.totalMinutes)}`,
  ].filter(Boolean);

  const lines: string[] = [recipe.title];
  if (recipe.description) lines.push(recipe.description);
  if (meta.length) lines.push(meta.join(' · '));

  lines.push('', 'INGREDIENTS');
  for (const section of recipe.ingredients) {
    if (section.title) lines.push('', `${section.title}:`);
    for (const item of section.items) lines.push(`• ${scaleIngredient(item, scale)}`);
  }

  lines.push('', 'INSTRUCTIONS');
  let n = 0;
  for (const section of recipe.instructions) {
    if (section.title) lines.push('', `${section.title}:`);
    for (const item of section.items) lines.push(`${++n}. ${item}`);
  }

  if (recipe.sourceUrl) lines.push('', `Original: ${recipe.sourceUrl}`);
  return lines.join('\n');
}

/** Opens the phone's share sheet, or copies when there isn't one (desktop). Returns what happened. */
async function shareOrCopy(data: { title: string; text?: string; url?: string }): Promise<'shared' | 'copied' | null> {
  if (navigator.share) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (err) {
      // Closing the share sheet isn't a failure.
      if (err instanceof DOMException && err.name === 'AbortError') return null;
    }
  }
  await navigator.clipboard.writeText(data.url ?? data.text ?? '');
  return 'copied';
}

/** Sheet on a recipe page: send a public link, or the recipe as text. */
export function ShareSheet({ recipe, scale, onClose }: { recipe: Recipe; scale: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const link = recipe.shareToken ? `${location.origin}/s/${recipe.shareToken}` : null;

  const setToken = (shareToken: string | null) =>
    queryClient.setQueryData<Recipe>(['recipe', recipe.id], (r) => r && { ...r, shareToken });

  const create = useMutation({
    mutationFn: () => api.shareRecipe(recipe.id),
    onSuccess: ({ shareToken }) => setToken(shareToken),
  });
  const stop = useMutation({
    mutationFn: () => api.unshareRecipe(recipe.id),
    onSuccess: () => {
      setToken(null);
      setStatus('Sharing stopped. The old link no longer works.');
    },
  });

  // Share right from the tap: iPhone only opens the share sheet during a user gesture.
  const send = async (data: { title: string; text?: string; url?: string }, what: string) => {
    setStatus(null);
    try {
      const result = await shareOrCopy(data);
      if (result === 'copied') setStatus(`${what} copied.`);
    } catch {
      setStatus('Couldn’t share or copy from this browser.');
    }
  };

  const error = create.error ?? stop.error;

  return (
    <div className="cook-sheet-backdrop" onClick={onClose}>
      <section className="cook-sheet share-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cook-sheet-header">
          <h2>Share</h2>
          <button type="button" className="cook-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <h3>Link</h3>
        {link ? (
          <>
            <p className="muted small">Anyone with this link can see the recipe, without logging in. Your notes aren’t included.</p>
            <input className="share-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
            <div className="share-actions">
              <button type="button" className="btn btn-primary" onClick={() => send({ title: recipe.title, url: link }, 'Link')}>
                Send link
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => stop.mutate()}
                disabled={stop.isPending}
              >
                Stop sharing
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">
              A link anyone can open, no login needed. It shows the photo, ingredients and steps, not your notes.
              You can turn it off later.
            </p>
            <div className="share-actions">
              <button type="button" className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>
                {create.isPending ? 'Making link…' : 'Make a link'}
              </button>
            </div>
          </>
        )}

        <h3>Text</h3>
        <p className="muted small">
          The recipe written out{scale !== 1 ? ', with the amounts you’ve scaled to' : ''}, for a message or email.
        </p>
        <div className="share-actions">
          <button type="button" className="btn" onClick={() => send({ title: recipe.title, text: recipeText(recipe, scale) }, 'Recipe')}>
            Send as text
          </button>
        </div>

        {status && <div className="banner">{status}</div>}
        {error && <p className="error">{error.message}</p>}
      </section>
    </div>
  );
}
