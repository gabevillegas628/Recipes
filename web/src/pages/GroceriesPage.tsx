import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { GroceryItem } from '../types';

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

  const toggle = useMutation({
    mutationFn: (item: GroceryItem) => api.updateGrocery(item.id, { checked: !item.checked }),
    // Tick instantly; the next poll confirms.
    onMutate: (item) =>
      queryClient.setQueryData<GroceryItem[]>(['groceries'], (prev) =>
        prev?.map((i) => (i.id === item.id ? { ...i, checked: !i.checked } : i)),
      ),
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeGrocery, onSettled: refresh });
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
  const groups = new Map<string, GroceryItem[]>();
  for (const item of open) {
    if (!item.aisle) continue;
    const aisle = AISLES.includes(item.aisle) ? item.aisle : 'Other';
    groups.set(aisle, [...(groups.get(aisle) ?? []), item]);
  }
  const ordered = AISLES.filter((a) => groups.has(a));

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
          {unsorted.map((item) => (
            <GroceryRow key={item.id} item={item} onToggle={() => toggle.mutate(item)} />
          ))}
        </ul>
      )}

      {ordered.map((aisle) => (
        <section key={aisle} className="aisle">
          <h2>{aisle}</h2>
          <ul className="grocery-list">
            {groups.get(aisle)!.map((item) => (
              <GroceryRow key={item.id} item={item} onToggle={() => toggle.mutate(item)} />
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
              {checked.map((item) => (
                <GroceryRow
                  key={item.id}
                  item={item}
                  onToggle={() => toggle.mutate(item)}
                  onRemove={() => remove.mutate(item.id)}
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
  item,
  onToggle,
  onRemove,
}: {
  item: GroceryItem;
  onToggle: () => void;
  onRemove?: () => void;
}) {
  return (
    <li className={`grocery ${item.checked ? 'done' : ''}`}>
      <button type="button" className="grocery-main" onClick={onToggle}>
        <span className={`check-circle ${item.checked ? 'on' : ''}`}>{item.checked ? '✓' : ''}</span>
        <span className="grocery-text">
          {item.text}
          {item.recipe && <span className="grocery-recipe">{item.recipe.title}</span>}
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
