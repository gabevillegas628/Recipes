import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

const TOGGLE = ['grocery-toggle'];

// When the row was first put on the list, so rows keep their place when ticked.
const since = (g: GroceryGroup) => g.items.reduce((min, i) => (i.createdAt < min ? i.createdAt : min), g.items[0].createdAt);

/** Each row as [its lines that pass the test, the rest], splitting rows that have both. */
function splitWhere(
  groups: GroceryGroup[],
  test: (id: string) => boolean,
): [GroceryGroup | null, GroceryGroup | null][] {
  return groups.map((g) => {
    const yes = g.items.filter((i) => test(i.id));
    if (yes.length === g.items.length) return [g, null];
    if (yes.length === 0) return [null, g];
    const no = g.items.filter((i) => !test(i.id));
    return [
      { ...g, key: `${g.key}:${yes[0].id}`, buy: null, items: yes },
      { ...g, key: `${g.key}:${no[0].id}`, buy: null, items: no },
    ];
  });
}

export function GroceriesPage() {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [showChecked, setShowChecked] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // Lines ticked before the page opened or the last tidy up; they sit in the cart.
  // Lines ticked since stay in place, struck through, so the list doesn't shift.
  const [tidied, setTidied] = useState<Set<string> | null>(null);

  // Poll so both phones stay in sync at the store. Paused while ticks are saving,
  // so a reload from before the tick can't bring the row back.
  const toggling = useIsMutating({ mutationKey: TOGGLE }) > 0;
  const list = useQuery({
    queryKey: ['groceries'],
    queryFn: api.groceries,
    refetchInterval: toggling ? false : 4000,
    refetchOnWindowFocus: !toggling,
  });
  const items = list.data ?? [];
  const checkedIds = () => new Set(items.filter((g) => g.checked).flatMap((g) => g.items.map((i) => i.id)));
  if (tidied === null && list.data) setTidied(checkedIds());

  const setChecked = (ids: Set<string>, checked: boolean) =>
    queryClient.setQueryData<GroceryGroup[]>(['groceries'], (prev) =>
      prev &&
      splitWhere(prev, (id) => ids.has(id)).flatMap(([hit, rest]) => [
        ...(hit ? [{ ...hit, checked }] : []),
        ...(rest ? [rest] : []),
      ]),
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
    mutationKey: TOGGLE,
    mutationFn: (group: GroceryGroup) =>
      Promise.all(group.items.map((i) => api.updateGrocery(i.id, { checked: !group.checked }))),
    // Tick instantly, dropping any reload already on its way with the old list.
    onMutate: async (group) => {
      await queryClient.cancelQueries({ queryKey: ['groceries'] });
      const ids = new Set(group.items.map((i) => i.id));
      setChecked(ids, !group.checked);
      // Unticked from the cart: if ticked again, it stays put like any other row.
      if (group.checked) setTidied((prev) => prev && new Set([...prev].filter((id) => !ids.has(id))));
    },
    // Reload once the last of a run of quick ticks has saved.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: TOGGLE }) === 1) refresh();
    },
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

  // Ticked rows stay in their aisle until tidied. A row can hold lines from both
  // sides (carrots in the cart from earlier, carrots just ticked), so split it.
  const [inCart, onList] = tidied
    ? splitWhere(items, (id) => tidied.has(id)).reduce<[GroceryGroup[], GroceryGroup[]]>(
        ([cart, here], [hit, rest]) => [
          hit?.checked ? [...cart, hit] : cart,
          [...here, ...(hit && !hit.checked ? [hit] : []), ...(rest ? [rest] : [])],
        ],
        [[], []],
      )
    : [items.filter((g) => g.checked), items.filter((g) => !g.checked)];
  const shown = [...onList].sort((a, b) => since(a).localeCompare(since(b)));
  const toTidy = shown.filter((g) => g.checked).length;
  // Not sorted yet (just added, or AI sorting is off): shown first, without a heading.
  const unsorted = shown.filter((i) => !i.aisle);
  const byAisle = new Map<string, GroceryGroup[]>();
  for (const item of shown) {
    if (!item.aisle) continue;
    const aisle = AISLES.includes(item.aisle) ? item.aisle : 'Other';
    byAisle.set(aisle, [...(byAisle.get(aisle) ?? []), item]);
  }
  const ordered = AISLES.filter((a) => byAisle.has(a));

  return (
    <div className={`page ${toTidy > 0 ? 'has-tidy' : ''}`}>
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

      {inCart.length > 0 && (
        <section className="aisle checked-aisle">
          <div className="aisle-header">
            <button type="button" className="link-btn" onClick={() => setShowChecked((v) => !v)}>
              {showChecked ? '▾' : '▸'} In the cart ({inCart.length})
            </button>
            <button type="button" className="btn btn-small" onClick={() => clear.mutate(false)}>
              Clear
            </button>
          </div>
          {showChecked && (
            <ul className="grocery-list">
              {inCart.map((group) => (
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

      {toTidy > 0 && (
        <button type="button" className="btn btn-primary tidy-up" onClick={() => setTidied(checkedIds())}>
          Tidy up ({toTidy})
        </button>
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
