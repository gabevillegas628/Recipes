import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import { displayTime } from '../sections';
import type { RecipeSummary } from '../types';

export function RecipeListPage() {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag') ?? undefined;
  const favorite = params.get('fav') === '1';
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q.trim(), 250);

  useEffect(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (debouncedQ) next.set('q', debouncedQ);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [debouncedQ, setParams]);

  const recipes = useQuery({
    queryKey: ['recipes', { q: debouncedQ, tag, favorite }],
    queryFn: () => api.listRecipes({ q: debouncedQ, tag, favorite }),
    placeholderData: keepPreviousData,
  });
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags });

  function toggleParam(key: string, value: string | null) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === null || next.get(key) === value) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  return (
    <div className="page">
      <header className="list-header">
        <input
          className="search"
          type="search"
          placeholder="Search recipes"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="chips">
          <button
            type="button"
            className={`chip ${favorite ? 'chip-on' : ''}`}
            onClick={() => toggleParam('fav', '1')}
          >
            ★ Favorites
          </button>
          {tags.data?.map((t) => (
            <button
              type="button"
              key={t.name}
              className={`chip ${tag === t.name ? 'chip-on' : ''}`}
              onClick={() => toggleParam('tag', t.name)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </header>

      {recipes.isPending ? null : recipes.error ? (
        <p className="error">{recipes.error.message}</p>
      ) : recipes.data.length === 0 ? (
        <EmptyState filtered={Boolean(debouncedQ || tag || favorite)} />
      ) : (
        <ul className="recipe-list">
          {recipes.data.map((r) => (
            <RecipeRow key={r.id} recipe={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RecipeRow({ recipe }: { recipe: RecipeSummary }) {
  const img = thumbUrl(recipe.image);
  const time = displayTime(recipe);
  return (
    <li>
      <Link to={`/r/${recipe.id}`} className="recipe-row">
        {img ? (
          <img className="thumb" src={img} alt="" loading="lazy" />
        ) : (
          <div className="thumb thumb-empty">{recipe.title.charAt(0).toUpperCase()}</div>
        )}
        <div className="recipe-row-body">
          <div className="recipe-row-title">
            {recipe.title}
            {recipe.favorite && <span className="fav-mark"> ★</span>}
          </div>
          <div className="recipe-row-meta">
            {[time, ...recipe.tags.slice(0, 3)].filter(Boolean).join(' · ')}
          </div>
        </div>
      </Link>
    </li>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="empty">
      {filtered ? (
        <p>No recipes match.</p>
      ) : (
        <>
          <p>No recipes yet.</p>
          <Link to="/new" className="btn btn-primary">
            Add your first recipe
          </Link>
        </>
      )}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
