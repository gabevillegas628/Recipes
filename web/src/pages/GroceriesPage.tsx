import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
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

export function GroceriesPage() {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [showChecked, setShowChecked] = useState(false);

  // Poll so both phones stay in sync at the store.
  const list = useQuery({ queryKey: ['groceries'], queryFn: api.groceries, refetchInterval: 4000 });
  const items = list.data ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['groceries'] });

  const add = useMutation({
    mutationFn: (t: string) => api.addGroceries(t.split(/\n|,(?![^(]*\))/).map((s) => ({ text: s }))),
    onSuccess: () => {
      setText('');
      refresh();
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

  const open = items.filter((i) => !i.checked);
  const checked = items.filter((i) => i.checked);
  const groups = new Map<string, GroceryItem[]>();
  for (const item of open) {
    const aisle = item.aisle && AISLES.includes(item.aisle) ? item.aisle : 'Other';
    groups.set(aisle, [...(groups.get(aisle) ?? []), item]);
  }
  const ordered = AISLES.filter((a) => groups.has(a));

  return (
    <div className="page">
      <h1 className="form-title">Groceries</h1>

      <form className="add-item" onSubmit={submit}>
        <input
          placeholder="Add an item (e.g. 2 lemons)"
          value={text}
          onChange={(e) => setText(e.target.value)}
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
