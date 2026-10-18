import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CATEGORY_GROUPS, groupOf, type CategoryGroupKey } from '../../../server/src/categoryList';
import { api, thumbUrl } from '../api';
import { displayTime } from '../sections';
import type { RecipeSummary } from '../types';

/** Recipes per row on the index, and the most category rows it shows. */
const PER_ROW = 10;
const CATEGORY_ROWS = 5;

/** Each group's name on its filter chip. */
const SHORT: Record<CategoryGroupKey, string> = { type: 'Type', ingredient: 'Ingredient', cuisine: 'Cuisine', goodFor: 'Good for' };

/**
 * Kitchen > Recipes. With nothing picked, an index to browse: rows of recipe
 * cards to swipe through (the newest, favorites, and the biggest categories),
 * each with "See all". Searching, a "See all" or a filter lists the recipes. A
 * chip per category group opens a picker. Within a group picks are either/or (Chicken or Beef); across
 * groups, both (Chicken and Soup & stew). Filtered here: the box is small.
 */
export function RecipeListPage() {
  const [params, setParams] = useSearchParams();
  const tags = params.getAll('tag');
  const favorite = params.get('fav') === '1';
  const all = params.get('all') === '1';
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

  const found = useQuery({
    queryKey: ['recipes', { q: debouncedQ, favorite }],
    queryFn: () => api.listRecipes({ q: debouncedQ, favorite }),
    placeholderData: keepPreviousData,
  });
  const [picking, setPicking] = useState<CategoryGroupKey | null>(null);
  const browsing = !debouncedQ && tags.length === 0 && !favorite && !all;

  function update(change: (next: URLSearchParams) => void) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      change(next);
      // Filtering by nothing is the whole list; the index is only from Browse.
      if (next.has('tag')) next.delete('all');
      else if (!browsing) next.set('all', '1');
      return next;
    });
  }
  const toggleTag = (name: string) =>
    update((next) => {
      const now = next.getAll('tag');
      next.delete('tag');
      for (const t of now.includes(name) ? now.filter((t) => t !== name) : [...now, name]) next.append('tag', t);
    });
  const toggleFavorite = () => update((next) => (favorite ? next.delete('fav') : next.set('fav', '1')));
  const clearTags = () => update((next) => next.delete('tag'));
  const backToIndex = () => {
    setQ('');
    setParams({});
  };

  // The picks by group; a recipe matches a group with picks when it has any of them.
  const picked = new Map<CategoryGroupKey, string[]>();
  for (const t of tags) {
    const g = groupOf(t);
    if (g) picked.set(g.key, [...(picked.get(g.key) ?? []), t]);
  }
  const matches = (r: RecipeSummary, except?: CategoryGroupKey) =>
    [...picked].every(([key, names]) => key === except || names.some((n) => r.tags.includes(n)));
  const shown = found.data?.filter((r) => matches(r));

  return (
    <div className="page">
      <header className="list-header">
        <h1 className="form-title">Recipes</h1>
        <input
          className="search"
          type="search"
          placeholder="Search recipes"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="chips">
            {!browsing && (
              <button type="button" className="chip" onClick={backToIndex}>
                ‹ Browse
              </button>
            )}
            <button type="button" className={`chip ${favorite ? 'chip-on' : ''}`} aria-pressed={favorite} onClick={toggleFavorite}>
              ★ Favorites
            </button>
            {CATEGORY_GROUPS.map((g) => {
              const names = picked.get(g.key) ?? [];
              return (
                <button
                  key={g.key}
                  type="button"
                  className={`chip ${names.length ? 'chip-on' : ''}`}
                  aria-haspopup="dialog"
                  onClick={() => setPicking(g.key)}
                >
                  {names.length === 0 ? SHORT[g.key] : names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`} ▾
                </button>
              );
            })}
            {tags.length > 0 && (
              <button type="button" className="chip" onClick={clearTags}>
                Clear
              </button>
            )}
        </div>
      </header>

      {picking && found.data && (
        <CategoryPicker
          group={CATEGORY_GROUPS.find((g) => g.key === picking)!}
          picked={picked.get(picking) ?? []}
          // How many recipes each option would leave, with the other groups' picks.
          countOf={(c) => found.data.filter((r) => matches(r, picking) && r.tags.includes(c)).length}
          showing={shown?.length ?? 0}
          onToggle={toggleTag}
          onClear={() =>
            update((next) => {
              const keep = next.getAll('tag').filter((t) => groupOf(t)?.key !== picking);
              next.delete('tag');
              for (const t of keep) next.append('tag', t);
            })
          }
          onClose={() => setPicking(null)}
        />
      )}

      {!shown ? (found.error ? <p className="error">{found.error.message}</p> : null) : browsing ? (
        shown.length === 0 ? (
          <EmptyState filtered={false} />
        ) : (
          <>
            <Shelf title="Recently added" recipes={shown} onAll={() => update((next) => next.set('all', '1'))} />
            <Shelf title="★ Favorites" recipes={shown.filter((r) => r.favorite)} onAll={toggleFavorite} />
            {categoryRows(shown).map((c) => (
              <Shelf key={c} title={c} recipes={dailyShuffle(shown.filter((r) => r.tags.includes(c)), c)} onAll={() => toggleTag(c)} />
            ))}
          </>
        )
      ) : shown.length === 0 ? (
        <EmptyState filtered />
      ) : (
        <>
          <p className="muted small recipe-count">
            {shown.length} recipe{shown.length === 1 ? '' : 's'}
          </p>
          <ul className="recipe-list">
            {shown.map((r) => (
              <RecipeRow key={r.id} recipe={r} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One group's categories to pick from, each with how many recipes it would leave. */
function CategoryPicker({
  group,
  picked,
  countOf,
  showing,
  onToggle,
  onClear,
  onClose,
}: {
  group: (typeof CATEGORY_GROUPS)[number];
  picked: string[];
  countOf: (category: string) => number;
  showing: number;
  onToggle: (category: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  // Options that would leave nothing are left out, unless already picked.
  const options = group.values.map((c) => ({ name: c, count: countOf(c) })).filter((o) => o.count > 0 || picked.includes(o.name));
  return (
    <div className="cook-sheet-backdrop" onClick={onClose}>
      <section className="cook-sheet" role="dialog" aria-label={group.name} onClick={(e) => e.stopPropagation()}>
        <div className="cook-sheet-header">
          <h2>{group.name}</h2>
          <button type="button" className="cook-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {options.length === 0 ? (
          <p className="muted">None of these recipes have one.</p>
        ) : (
          <div className="chips wrap-chips category-options">
            {options.map((o) => {
              const on = picked.includes(o.name);
              return (
                <button
                  key={o.name}
                  type="button"
                  className={`chip ${on ? 'chip-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => onToggle(o.name)}
                >
                  {o.name}
                  <span className="chip-count">{o.count}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn" disabled={picked.length === 0} onClick={onClear}>
            Clear
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Show {showing} recipe{showing === 1 ? '' : 's'}
          </button>
        </div>
      </section>
    </div>
  );
}

/** The biggest categories, at most two from a group, leaving out Main (most of the box). */
function categoryRows(recipes: RecipeSummary[]): string[] {
  const counts = new Map<string, number>();
  for (const r of recipes) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const perGroup = new Map<string, number>();
  const rows: string[] = [];
  for (const [c, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const g = groupOf(c)?.key;
    if (!g || c === 'Main' || n < 4 || (perGroup.get(g) ?? 0) >= 2) continue;
    perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
    rows.push(c);
    if (rows.length === CATEGORY_ROWS) break;
  }
  return rows;
}

/** A different order each day, the same all day, so a row turns up different recipes first. */
function dailyShuffle<T extends { id: string }>(items: T[], salt: string): T[] {
  const day = new Date().toDateString();
  const rank = (id: string) => {
    let h = 2166136261;
    for (const ch of `${day}|${salt}|${id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h >>> 0;
  };
  return [...items].sort((a, b) => rank(a.id) - rank(b.id));
}

/** A row of recipe cards to swipe through, with "See all" for the whole list. */
function Shelf({ title, recipes, onAll }: { title: string; recipes: RecipeSummary[]; onAll: () => void }) {
  if (!recipes.length) return null;
  return (
    <section className="shelf">
      <div className="shelf-header">
        <h2>{title}</h2>
        <button type="button" className="link-btn" onClick={onAll}>
          See all {recipes.length} ›
        </button>
      </div>
      <ul className="shelf-row">
        {recipes.slice(0, PER_ROW).map((r) => (
          <li key={r.id}>
            <RecipeCard recipe={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecipeCard({ recipe }: { recipe: RecipeSummary }) {
  const [broken, setBroken] = useState(false);
  const img = broken ? null : thumbUrl(recipe.image);
  const time = displayTime(recipe);
  return (
    <Link to={`/r/${recipe.id}`} className="recipe-card">
      {img ? (
        <img className="recipe-card-img" src={img} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <div className="recipe-card-img thumb-empty">{recipe.title.charAt(0).toUpperCase()}</div>
      )}
      <span className="recipe-card-title">
        {recipe.title}
        {recipe.favorite && <span className="fav-mark"> ★</span>}
      </span>
      {time && <span className="recipe-card-meta">{time}</span>}
    </Link>
  );
}

function RecipeRow({ recipe }: { recipe: RecipeSummary }) {
  const [broken, setBroken] = useState(false);
  const img = broken ? null : thumbUrl(recipe.image);
  const time = displayTime(recipe);
  return (
    <li>
      <Link to={`/r/${recipe.id}`} className="recipe-row">
        {img ? (
          <img className="thumb" src={img} alt="" loading="lazy" onError={() => setBroken(true)} />
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
