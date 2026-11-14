import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
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

/**
 * Sheet on a recipe or meal page: send a public link, the content as text, or print it.
 * The page owns the data: it passes the current token and how to make or clear one.
 */
export function ShareSheet({
  kind,
  title,
  shareToken,
  createLink,
  stopSharing,
  text,
  scaled,
  onPrint,
  onClose,
}: {
  kind: 'recipe' | 'meal';
  title: string;
  shareToken: string | null;
  createLink: () => Promise<unknown>;
  stopSharing: () => Promise<unknown>;
  /** The text to send; null while it's still loading. */
  text: string | null;
  /** Whether amounts differ from the recipe as written. */
  scaled: boolean;
  onPrint: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const link = shareToken ? `${location.origin}/s/${shareToken}` : null;

  const create = useMutation({ mutationFn: createLink });
  const stop = useMutation({
    mutationFn: stopSharing,
    onSuccess: () => setStatus('Sharing stopped. The old link no longer works.'),
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
  const what = kind === 'meal' ? 'the meal, with every recipe in it' : 'the recipe';

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
            <p className="muted small">Anyone with this link can see {what}, without logging in. Your notes aren’t included.</p>
            <input className="share-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
            <div className="share-actions">
              <button type="button" className="btn btn-primary" onClick={() => send({ title, url: link }, 'Link')}>
                Send link
              </button>
              <button type="button" className="btn btn-danger" onClick={() => stop.mutate()} disabled={stop.isPending}>
                Stop sharing
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">
              A link anyone can open to see {what}, no login needed. It shows photos, ingredients and steps, not your
              notes. You can turn it off later.
            </p>
            <div className="share-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setStatus(null);
                  create.mutate();
                }}
                disabled={create.isPending}
              >
                {create.isPending ? 'Making link…' : 'Make a link'}
              </button>
            </div>
          </>
        )}

        <h3>Text or paper</h3>
        <p className="muted small">
          {kind === 'meal' ? 'Every recipe' : 'The recipe'} written out
          {scaled ? ', with the amounts you’ve scaled to' : ''}, for a message, email or printing.
        </p>
        <div className="share-actions">
          <button
            type="button"
            className="btn"
            onClick={() => text && send({ title, text }, kind === 'meal' ? 'Meal' : 'Recipe')}
            disabled={!text}
          >
            {text ? 'Send as text' : 'Loading…'}
          </button>
          <button type="button" className="btn" onClick={onPrint}>
            Print
          </button>
        </div>

        {status && <div className="banner">{status}</div>}
        {error && <p className="error">{error.message}</p>}
      </section>
    </div>
  );
}
