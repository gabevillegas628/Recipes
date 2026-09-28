import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { GroceryGroup } from '../types';

// Store walk order. Matches the server's aisle names.
const AISLES = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Bakery',
  'Pantry',
  'Spices & Baking',
  'Canned & Jarred',
  'Frozen',
  'Drinks',
  'Household',
  'Other',
];

/**
 * One item per line or comma (commas inside parentheses don't split), so a
 * list pasted from a text message goes in as separate items. Drops bullets
 * and numbering like "- ", "• " or "2. ".
 */
function splitItems(text: string): string[] {
  return text
    .split(/\n|,(?![^(]*\))/)
    .map((s) => s.replace(/^\s*(?:[-*•·▪◦]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

export function GroceriesPage() {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [showChecked, setShowChecked] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // Poll so both phones stay in sync at the store.
  const list = useQuery({ queryKey: ['groceries'], queryFn: api.groceries, refetchInterval: 4000 });
  const items = list.data ?? [];
  const setChecked = (key: string, checked: boolean) =>
    queryClient.setQueryData<GroceryGroup[]>(['groceries'], (prev) =>
      prev?.map((g) => (g.key === key ? { ...g, checked } : g)),
    );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['groceries'] });

  const add = useMutation({
    mutationFn: (t: string) => api.addGroceries(splitItems(t).map((s) => ({ text: s }))),
    onSuccess: () => {
      setText('');
      if (box.current) box.current.style.height = '';
      refresh();
      // Items are sorted into aisles a moment after they're added.
      setTimeout(refresh, 3000);
    },
  });

  // A row can stand for several lines ("2 lb carrots", "3 carrots"); ticking it ticks them all.
  const toggle = useMutation({
    mutationFn: (group: GroceryGroup) =>
      Promise.all(group.items.map((i) => api.updateGrocery(i.id, { checked: !group.checked }))),
    // Tick instantly; the next poll confirms.
    onMutate: (group) => setChecked(group.key, !group.checked),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (group: GroceryGroup) => Promise.all(group.items.map((i) => api.removeGrocery(i.id))),
    onSettled: refresh,
  });
  const clear = useMutation({ mutationFn: (all: boolean) => api.clearGroceries(all), onSettled: refresh });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) add.mutate(text);
  }

  // Enter adds; pasted line breaks stay, so a pasted list becomes several items.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (text.trim()) add.mutate(text);
    }
  }

  function onChange(value: string) {
    setText(value);
    const el = box.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + 2}px`;
    }
  }

  const open = items.filter((i) => !i.checked);
  const checked = items.filter((i) => i.checked);
  // Not sorted yet (just added, or AI sorting is off): shown first, without a heading.
  const unsorted = open.filter((i) => !i.aisle);
  const byAisle = new Map<string, GroceryGroup[]>();
  for (const item of open) {
    if (!item.aisle) continue;
    const aisle = AISLES.includes(item.aisle) ? item.aisle : 'Other';
    byAisle.set(aisle, [...(byAisle.get(aisle) ?? []), item]);
  }
  const ordered = AISLES.filter((a) => byAisle.has(a));

  return (
    <div className="page">
      <h1 className="form-title">Groceries</h1>

      <form className="add-item" onSubmit={submit}>
        <textarea
          ref={box}
          rows={1}
          placeholder="Add items, or paste a list"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          enterKeyHint="done"
        />
        <button className="btn btn-primary" disabled={add.isPending || !text.trim()}>
          {add.isPending ? '…' : 'Add'}
        </button>
      </form>
      {add.error && <p className="error">{add.error.message}</p>}

      {list.data && items.length === 0 && (
        <div className="empty">
          <p>The list is empty.</p>
          <p className="muted">
            Add items above, or use <strong>Add groceries</strong> on a recipe or on{' '}
            <Link to="/week">This week</Link>.
          </p>
        </div>
      )}

      {unsorted.length > 0 && (
        <ul className="grocery-list">
          {unsorted.map((group) => (
            <GroceryRow key={group.key} group={group} onToggle={() => toggle.mutate(group)} />
          ))}
        </ul>
      )}

      {ordered.map((aisle) => (
        <section key={aisle} className="aisle">
          <h2>{aisle}</h2>
          <ul className="grocery-list">
            {byAisle.get(aisle)!.map((group) => (
              <GroceryRow key={group.key} group={group} onToggle={() => toggle.mutate(group)} />
            ))}
          </ul>
        </section>
      ))}

      {checked.length > 0 && (
        <section className="aisle checked-aisle">
          <div className="aisle-header">
            <button type="button" className="link-btn" onClick={() => setShowChecked((v) => !v)}>
              {showChecked ? '▾' : '▸'} In the cart ({checked.length})
            </button>
            <button type="button" className="btn btn-small" onClick={() => clear.mutate(false)}>
              Clear
            </button>
          </div>
          {showChecked && (
            <ul className="grocery-list">
              {checked.map((group) => (
                <GroceryRow
                  key={group.key}
                  group={group}
                  onToggle={() => toggle.mutate(group)}
                  onRemove={() => remove.mutate(group)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {items.length > 0 && (
        <button
          type="button"
          className="btn btn-danger clear-all"
          onClick={() => confirm('Clear the whole list?') && clear.mutate(true)}
        >
          Clear whole list
        </button>
      )}
    </div>
  );
}

function GroceryRow({
  group,
  onToggle,
  onRemove,
}: {
  group: GroceryGroup;
  onToggle: () => void;
  onRemove?: () => void;
}) {
  const single = group.items.length === 1;
  const recipes = [...new Set(group.items.flatMap((i) => (i.recipe ? [i.recipe.title] : [])))];
  return (
    <li className={`grocery ${group.checked ? 'done' : ''}`}>
      <button type="button" className="grocery-main" onClick={onToggle}>
        <span className={`check-circle ${group.checked ? 'on' : ''}`}>{group.checked ? '✓' : ''}</span>
        <span className="grocery-text">
          {single ? (
            group.items[0].text
          ) : (
            <>
              <span>
                {group.name.charAt(0).toUpperCase() + group.name.slice(1)}
                {group.buy && <strong className="grocery-buy"> · {group.buy}</strong>}
              </span>
              <span className="grocery-lines">{group.items.map((i) => i.text).join(' + ')}</span>
            </>
          )}
          {recipes.length > 0 && <span className="grocery-recipe">{recipes.join(' · ')}</span>}
        </span>
      </button>
      {onRemove && (
        <button type="button" className="cook-icon-btn" onClick={onRemove} aria-label="Remove">
          ✕
        </button>
      )}
    </li>
  );
}
