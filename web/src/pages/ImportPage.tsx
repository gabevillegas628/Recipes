import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { ImportResult } from '../types';
import { RecipeForm } from './RecipeEditPage';

/**
 * Import one recipe from a link (or pasted text), review it in the edit form, then save.
 * Also reachable as /import?url=... so share sheets / Shortcuts can hand a link straight in.
 */
export function ImportPage() {
  const [params, setParams] = useSearchParams();
  // Share targets put the link in url, text or even title depending on the app.
  const sharedUrl =
    ['url', 'text', 'title'].map((k) => params.get(k) ?? '').find((v) => extractUrl(v)) ?? '';
  const [mode, setMode] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState(extractUrl(sharedUrl) ?? '');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);

  const config = useQuery({ queryKey: ['import-config'], queryFn: api.importConfig });

  const fromUrl = useMutation({
    mutationFn: (link: string) => api.importUrl(link),
    onSuccess: setResult,
  });
  const fromText = useMutation({
    mutationFn: () => api.importText(text, url || undefined),
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
              {result.method === 'ai' && (
                <div className="banner">
                  This page had no structured recipe data, so AI pulled it out. Give it a quick
                  check before saving.
                </div>
              )}
            </>
          }
        />
      </div>
    );
  }

  const pending = fromUrl.isPending || fromText.isPending;
  const error = fromUrl.error ?? fromText.error;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'url') fromUrl.mutate(url.trim());
    else fromText.mutate();
  }

  return (
    <div className="page">
      <h1 className="form-title">Add a recipe</h1>

      <div className="segmented">
        <button
          type="button"
          className={mode === 'url' ? 'on' : ''}
          onClick={() => setMode('url')}
        >
          From a link
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
        ) : (
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

        <div className="form-actions">
          <button className="btn btn-primary" disabled={pending}>
            {pending ? 'Importing…' : 'Import'}
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
function extractUrl(value: string): string | null {
  return value.match(/https?:\/\/\S+/)?.[0] ?? null;
}
