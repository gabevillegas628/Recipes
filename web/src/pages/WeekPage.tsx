import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import { GroceryPicker } from '../components/GroceryPicker';
import { baseServings, formatAmount } from '../scale';
import type { PlanItem } from '../types';

export function WeekPage() {
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: ['plan'], queryFn: api.plan });
  const [picking, setPicking] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plan'] });

  const clear = useMutation({ mutationFn: api.clearPlan, onSuccess: refresh });

  const items = plan.data ?? [];
  const left = items.filter((i) => !i.cookedAt).length;

  return (
    <div className="page">
      <h1 className="form-title">This week</h1>

      {plan.error && <p className="error">{plan.error.message}</p>}

      {plan.data && items.length === 0 && (
        <div className="empty">
          <p>Nothing planned yet.</p>
          <p className="muted">
            Tap <strong>Add to this week</strong> on any recipe. Recipes drop off by themselves 7 days
            after you add them.
          </p>
          <Link to="/" className="btn">
            Browse recipes
          </Link>
        </div>
      )}

      {items.length > 0 && (
        <>
          <p className="muted week-summary">
            {left === 0 ? 'All cooked. Nice.' : `${left} of ${items.length} left to make`}
          </p>
          <ul className="recipe-list">
            {items.map((item) => (
              <PlanRow key={item.id} item={item} onChange={refresh} />
            ))}
          </ul>

          <div className="settings-actions week-actions">
            <button type="button" className="btn btn-primary" onClick={() => setPicking(true)}>
              Add groceries for the week
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => confirm('Clear this week and start fresh?') && clear.mutate()}
            >
              Start new week
            </button>
          </div>
          <p className="muted small">Recipes drop off by themselves 7 days after they were added.</p>
        </>
      )}

      {picking && (
        <GroceryPicker
          recipes={items
            .filter((i) => !i.cookedAt)
            .map((i) => ({ ...i.recipe, scale: i.scale }))}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function PlanRow({ item, onChange }: { item: PlanItem; onChange: () => void }) {
  const cooked = Boolean(item.cookedAt);
  const toggle = useMutation({ mutationFn: () => api.updatePlanItem(item.id, { cooked: !cooked }), onSuccess: onChange });
  const remove = useMutation({ mutationFn: () => api.removePlanItem(item.id), onSuccess: onChange });

  const base = baseServings(item.recipe.servings);
  const amount =
    item.scale === 1
      ? null
      : base
        ? `Serves ${formatAmount(base * item.scale, null)}`
        : `${formatAmount(item.scale, null)}×`;
  const img = thumbUrl(item.recipe.image);

  return (
    <li className={`plan-row ${cooked ? 'cooked' : ''}`}>
      <button
        type="button"
        className={`check-circle ${cooked ? 'on' : ''}`}
        onClick={() => toggle.mutate()}
        aria-label={cooked ? 'Mark as not cooked' : 'Mark as cooked'}
      >
        {cooked ? '✓' : ''}
      </button>
      <Link to={`/r/${item.recipe.id}${item.scale !== 1 ? `?scale=${item.scale}` : ''}`} className="plan-link">
        {img ? <img className="thumb thumb-small" src={img} alt="" /> : <div className="thumb thumb-small thumb-empty">{item.recipe.title.charAt(0)}</div>}
        <div className="recipe-row-body">
          <div className="recipe-row-title">{item.recipe.title}</div>
          <div className="recipe-row-meta">
            {[amount, item.addedBy ? `added by ${item.addedBy.name}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
      </Link>
      <button type="button" className="cook-icon-btn" onClick={() => remove.mutate()} aria-label="Remove from this week">
        ✕
      </button>
    </li>
  );
}
