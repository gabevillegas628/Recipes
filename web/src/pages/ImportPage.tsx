import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { PhotoInput } from '../components/PhotoInput';
import { shrinkPhoto } from '../photos';
import type { ImportResult } from '../types';
import { RecipeForm } from './RecipeEditPage';

/**
 * Import one recipe from a link (or pasted text), review it in the edit form, then save.
 * Also reachable as /import?url=... so share sheets / Shortcuts can hand a link straight in,
 * and from Capture with the extracted recipe already in the location state.
 */
export function ImportPage() {
  const [params, setParams] = useSearchParams();
  // Share targets put the link in url, text or even title depending on the app.
  const sharedUrl =
    ['url', 'text', 'title'].map((k) => params.get(k) ?? '').find((v) => extractUrl(v)) ?? '';
  const [mode, setMode] = useState<'url' | 'photo' | 'text'>('url');
  const [photos, setPhotos] = useState<File[]>([]);
  const [url, setUrl] = useState(extractUrl(sharedUrl) ?? '');
  const [text, setText] = useState('');
  const handedOver = (useLocation().state as { result?: ImportResult } | null)?.result ?? null;
  const [result, setResult] = useState<ImportResult | null>(handedOver);

  // The link that wouldn't import, while trying another way to get its recipe.
  const [fallbackFrom, setFallbackFrom] = useState<string | null>(null);

  const config = useQuery({ queryKey: ['import-config'], queryFn: api.importConfig });

  const fromUrl = useMutation({
    mutationFn: (link: string) => api.importUrl(link),
    onSuccess: setResult,
  });
  const fromText = useMutation({
    mutationFn: () => api.importText(text, url || undefined),
    onSuccess: setResult,
  });
  const fromPhotos = useMutation({
    mutationFn: async () => api.importPhotos(await Promise.all(photos.map((p) => shrinkPhoto(p)))),
    // Screenshots of a post that wouldn't import keep the post as the source.
    onSuccess: (r) =>
      setResult({
        ...r,
        draft: { ...r.draft, sourceUrl: r.draft.sourceUrl ?? fallbackFrom, uploadedImage: r.uploadedImage },
      }),
  });
  const written = useMutation({
    mutationFn: (link: string) => api.importWrite(link),
    onSuccess: setResult,
  });

  // Auto-start when opened with ?url=
  const started = useRef(false);
  useEffect(() => {
    const link = extractUrl(sharedUrl);
    if (link && !started.current) {
      started.current = true;
      fromUrl.mutate(link);
      setParams({}, { replace: true });
    }
  }, [sharedUrl, fromUrl, setParams]);

  function reset() {
    setResult(null);
    fromUrl.reset();
    fromText.reset();
    fromPhotos.reset();
    written.reset();
    setFallbackFrom(null);
  }

  /** From a link that failed: paste its text or add screenshots, keeping the link as the source. */
  function tryInstead(next: 'text' | 'photo') {
    setFallbackFrom(url.trim());
    fromUrl.reset();
    setMode(next);
  }

  if (result) {
    return (
      <div className="page">
        <h1 className="form-title">Review recipe</h1>
        <RecipeForm
          draft={result.draft}
          onCancel={reset}
          banner={
            <>
              {result.duplicateOf && (
                <div className="banner">
                  You already saved this one:{' '}
                  <Link to={`/r/${result.duplicateOf.id}`}>{result.duplicateOf.title}</Link>
                </div>
              )}
              {result.method === 'generated' && (
                <div className="banner">Claude wrote this recipe for you. Look it over and change anything before saving.</div>
              )}
              {result.method === 'ai' && (
                <div className="banner">
                  {result.uploadedImage
                    ? 'AI read this from your photo. Double-check the temperatures and times before saving.'
                    : 'This page had no structured recipe data, so AI pulled it out. Give it a quick check before saving.'}
                </div>
              )}
            </>
          }
        />
      </div>
    );
  }

  const pending = fromUrl.isPending || fromText.isPending || fromPhotos.isPending || written.isPending;
  const error = fromUrl.error ?? fromText.error ?? fromPhotos.error ?? written.error;
  // A link that didn't import: offer the other ways in.
  const failedLink = mode === 'url' && (fromUrl.isError || written.isError);
  const canWrite =
    config.data?.aiEnabled !== false && fromUrl.error instanceof ApiError && fromUrl.error.data.canWrite === true;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'url') fromUrl.mutate(url.trim());
    else if (mode === 'photo') fromPhotos.mutate();
    else fromText.mutate();
  }

  return (
    <div className="page">
      <h1 className="form-title">Add a recipe</h1>

      <div className="segmented">
        <button
          type="button"
          className={mode === 'url' ? 'on' : ''}
          onClick={() => {
            setMode('url');
            setFallbackFrom(null);
          }}
        >
          From a link
        </button>
        <button
          type="button"
          className={mode === 'photo' ? 'on' : ''}
          onClick={() => setMode('photo')}
        >
          Photo
        </button>
        <button
          type="button"
          className={mode === 'text' ? 'on' : ''}
          onClick={() => setMode('text')}
        >
          Paste text
        </button>
      </div>

      <form className="form" onSubmit={submit}>
        {mode === 'photo' && (
          <PhotoPicker
            photos={photos}
            onChange={setPhotos}
            aiEnabled={config.data?.aiEnabled !== false}
            hint={
              fallbackFrom
                ? 'Screenshots of the post or video where the ingredients and steps show. Up to 4.'
                : undefined
            }
          />
        )}
        {mode === 'url' ? (
          <label className="field">
            <span>Recipe link</span>
            <input
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              autoFocus
            />
          </label>
        ) : mode === 'photo' ? null : (
          <>
            {config.data?.aiEnabled === false && (
              <div className="banner">
                Pasting text needs AI extraction, which isn't set up on the server
                (ANTHROPIC_API_KEY).
              </div>
            )}
            <label className="field">
              <span>Recipe text</span>
              <small>Copy the recipe from the page (or anywhere) and paste it here.</small>
              <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} required />
            </label>
            <label className="field">
              <span>Source link (optional)</span>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
          </>
        )}

        {error && <p className="error">{error.message}</p>}

        {failedLink && !pending && (
          <div className="import-fallback">
            <p className="muted small">Other ways to get it:</p>
            <div className="settings-actions">
              {canWrite && (
                <button type="button" className="btn" onClick={() => written.mutate(url.trim())}>
                  Have Claude write it
                </button>
              )}
              <button type="button" className="btn" onClick={() => tryInstead('text')}>
                Paste text
              </button>
              <button type="button" className="btn" onClick={() => tryInstead('photo')}>
                Add screenshots
              </button>
            </div>
            {canWrite && (
              <p className="muted small">
                Claude writes a recipe for the dish in the post, going by what the caption says. It won’t be the
                creator’s exact recipe.
              </p>
            )}
          </div>
        )}

        <div className="form-actions">
          <button className="btn btn-primary" disabled={pending || (mode === 'photo' && photos.length === 0)}>
            {written.isPending ? 'Writing recipe…' : pending ? (mode === 'photo' ? 'Reading photo…' : 'Importing…') : mode === 'photo' ? 'Read recipe' : 'Import'}
          </button>
        </div>
      </form>

      <div className="import-more">
        <p className="muted">Or:</p>
        <div className="settings-actions">
          <Link to="/new" className="btn">
            Type in a recipe
          </Link>
          <Link to="/import/bulk" className="btn">
            Import many links at once
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Share targets often send "Title https://…" as text; pull out the link. */
export function extractUrl(value: string): string | null {
  return value.match(/https?:\/\/\S+/)?.[0] ?? null;
}

const MAX_PHOTOS = 4;

/** Camera or photo library; up to 4 shots (e.g. front and back of a box). */
export function PhotoPicker({
  photos,
  onChange,
  aiEnabled,
  hint,
}: {
  photos: File[];
  onChange: (photos: File[]) => void;
  aiEnabled: boolean;
  hint?: ReactNode;
}) {
  const previews = useMemo(() => photos.map((p) => URL.createObjectURL(p)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  return (
    <div className="field">
      <span>Photos</span>
      <small>
        {hint ?? (
          <>
            A recipe card, a cookbook page, or the instructions on a box. Add the front too if the
            name is there. Up to {MAX_PHOTOS}.
          </>
        )}
      </small>
      {!aiEnabled && (
        <div className="banner">Reading photos needs AI extraction (ANTHROPIC_API_KEY).</div>
      )}
      <div className="photo-grid">
        {previews.map((src, i) => (
          <div key={src} className="photo-thumb">
            <img src={src} alt={`Photo ${i + 1}`} />
            <button
              type="button"
              className="photo-remove"
              aria-label="Remove photo"
              onClick={() => onChange(photos.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        {photos.length < MAX_PHOTOS && (
          <div className={`photo-add ${photos.length === 0 ? 'photo-add-empty' : ''}`}>
            <PhotoInput camera onPick={(picked) => onChange([...photos, ...picked].slice(0, MAX_PHOTOS))}>
              📷 {photos.length ? 'Take another' : 'Take photo'}
            </PhotoInput>
            <PhotoInput onPick={(picked) => onChange([...photos, ...picked].slice(0, MAX_PHOTOS))}>
              🖼️ Choose photo
            </PhotoInput>
          </div>
        )}
      </div>
    </div>
  );
}
