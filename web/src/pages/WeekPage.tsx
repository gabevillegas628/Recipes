import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import { GroceryPicker } from '../components/GroceryPicker';
import { recipeQuery } from '../components/MealSwitcher';
import { servingsLabel } from '../scale';
import type { PlanItem } from '../types';

export function WeekPage() {
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: ['plan'], queryFn: api.plan });
  const [picking, setPicking] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plan'] });

  const clear = useMutation({ mutationFn: api.clearPlan, onSuccess: refresh });

  const items = plan.data ?? [];
  const left = items.filter((i) => !i.cookedAt).length;
  const carried = items.filter((i) => carriedOver(i)).length;

  return (
    <div className="page">
      <header className="list-header">
        <h1 className="form-title">This week</h1>
      </header>

      {plan.error && <p className="error">{plan.error.message}</p>}

      {plan.data && items.length === 0 && (
        <div className="empty">
          <p>Nothing planned yet.</p>
          <p className="muted">
            Tap <strong>Add to this week</strong> on any recipe. Cooked recipes drop off by themselves 7
            days after you add them; ones you haven’t made yet carry over.
          </p>
          <div className="settings-actions week-empty-actions">
            <Link to="/week/plan" className="btn btn-primary">
              Plan meals together
            </Link>
            <Link to="/recipes" className="btn">
              Browse recipes
            </Link>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <>
          <p className="muted week-summary">
            {left === 0 ? 'All cooked. Nice.' : `${left} of ${items.length} left to make`}
            {carried > 0 && ` · ${carried} carried over`}
          </p>
          <ul className="recipe-list">
            {groupByMeal(items).map((block) =>
              block.meal ? (
                <MealGroup key={block.meal.id} meal={block.meal} items={block.items} onChange={refresh} />
              ) : (
                <PlanRow key={block.items[0].id} item={block.items[0]} onChange={refresh} />
              ),
            )}
          </ul>

          <div className="settings-actions week-actions">
            <button type="button" className="btn btn-primary" onClick={() => setPicking(true)}>
              Add groceries for the week
            </button>
            <Link to="/week/plan" className="btn">
              Plan more together
            </Link>
            <button
              type="button"
              className="btn"
              onClick={() => confirm('Clear this week and start fresh?') && clear.mutate()}
            >
              Start new week
            </button>
          </div>
          <p className="muted small">
            Cooked recipes drop off 7 days after they were added. Ones not made yet carry over (up to 4 weeks);
            adding one again starts its week over.
          </p>
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

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Not cooked yet and added over a week ago: carried over from an earlier week. */
function carriedOver(item: PlanItem): boolean {
  return !item.cookedAt && Date.now() - new Date(item.createdAt).getTime() > WEEK;
}

/** "from last week", "from 2 weeks ago", or null for this week's recipes. */
function carriedLabel(item: PlanItem): string | null {
  if (!carriedOver(item)) return null;
  const weeks = Math.floor((Date.now() - new Date(item.createdAt).getTime()) / WEEK);
  return weeks <= 1 ? 'from last week' : `from ${weeks} weeks ago`;
}

type Block = { meal: PlanItem['meal']; items: PlanItem[] };

/** Recipes added as part of a meal stay together, in the order the meal was added. */
function groupByMeal(items: PlanItem[]): Block[] {
  const blocks: Block[] = [];
  const byMeal = new Map<string, Block>();
  for (const item of items) {
    if (!item.meal) {
      blocks.push({ meal: null, items: [item] });
      continue;
    }
    let block = byMeal.get(item.meal.id);
    if (!block) {
      block = { meal: item.meal, items: [] };
      byMeal.set(item.meal.id, block);
      blocks.push(block);
    }
    block.items.push(item);
  }
  return blocks;
}

function MealGroup({
  meal,
  items,
  onChange,
}: {
  meal: NonNullable<PlanItem['meal']>;
  items: PlanItem[];
  onChange: () => void;
}) {
  const remove = useMutation({ mutationFn: () => api.removeMealFromPlan(meal.id), onSuccess: onChange });
  const done = items.filter((i) => i.cookedAt).length;
  return (
    <li className="meal-group">
      <div className="meal-group-header">
        <Link to={`/m/${meal.id}`} className="meal-group-title">
          {meal.name}
        </Link>
        <span className="muted small">
          {done}/{items.length} made
        </span>
        <button
          type="button"
          className="cook-icon-btn"
          onClick={() => confirm(`Remove "${meal.name}" from this week?`) && remove.mutate()}
          aria-label="Remove meal from this week"
        >
          ✕
        </button>
      </div>
      <ul className="recipe-list">
        {items.map((item) => (
          <PlanRow key={item.id} item={item} onChange={onChange} inMeal />
        ))}
      </ul>
    </li>
  );
}

function PlanRow({ item, onChange, inMeal = false }: { item: PlanItem; onChange: () => void; inMeal?: boolean }) {
  const cooked = Boolean(item.cookedAt);
  const toggle = useMutation({ mutationFn: () => api.updatePlanItem(item.id, { cooked: !cooked }), onSuccess: onChange });
  const remove = useMutation({ mutationFn: () => api.removePlanItem(item.id), onSuccess: onChange });

  const amount = item.scale === 1 ? null : servingsLabel(item.recipe.servings, item.scale);
  const img = thumbUrl(item.recipe.image);
  const carried = carriedLabel(item);
  const meta = [amount, item.addedBy ? `added by ${item.addedBy.name}` : null].filter(Boolean).join(' · ');

  return (
    <li className={`plan-row ${cooked ? 'cooked' : ''} ${inMeal ? 'in-meal' : ''}`}>
      <button
        type="button"
        className={`check-circle ${cooked ? 'on' : ''}`}
        onClick={() => toggle.mutate()}
        aria-label={cooked ? 'Mark as not cooked' : 'Mark as cooked'}
      >
        {cooked ? '✓' : ''}
      </button>
      <Link to={`/r/${item.recipe.id}${recipeQuery(item.scale, inMeal ? (item.meal?.id ?? null) : null)}`} className="plan-link">
        {img ? <img className="thumb thumb-small" src={img} alt="" /> : <div className="thumb thumb-small thumb-empty">{item.recipe.title.charAt(0)}</div>}
        <div className="recipe-row-body">
          <div className="recipe-row-title">{item.recipe.title}</div>
          <div className="recipe-row-meta">
            {carried && <span className="carried-over">{carried}</span>}
            {carried && meta && ' · '}
            {meta}
          </div>
        </div>
      </Link>
      {!inMeal && (
        <button type="button" className="cook-icon-btn" onClick={() => remove.mutate()} aria-label="Remove from this week">
          ✕
        </button>
      )}
    </li>
  );
}
