import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, thumbUrl } from '../api';
import { GroceryPicker, type PickerRecipe } from '../components/GroceryPicker';
import type { PlanDraft, PlanSuggestion } from '../types';

type Mode = 'pick' | 'random' | 'invent';

const MODES: { id: Mode; title: string; detail: string }[] = [
  { id: 'pick', title: 'Start from a recipe', detail: 'Pick one; the rest share its ingredients.' },
  { id: 'random', title: 'Surprise me', detail: 'A random recipe, and others that go with it.' },
  { id: 'invent', title: 'Adventurous', detail: 'Claude writes new recipes around one of yours.' },
];

interface Picked {
  id: string;
  title: string;
}

/**
 * Plans several recipes at once that share ingredients, so a pound of sausage
 * bought for one gets finished by another. Swap any but the first; add them all
 * to this week (and their ingredients to the grocery list) when it looks right.
 * Opened from a recipe (?recipe=<id>), it starts from that recipe.
 */
export function PlanMealsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const startWith = params.get('recipe');
  const [count, setCount] = useState(4);
  const [mode, setMode] = useState<Mode>('pick');
  const [anchor, setAnchor] = useState<Picked | null>(null);
  const [plan, setPlan] = useState<PlanSuggestion | null>(null);
  // Turned down so far, so swaps and "try again" don't bring them back.
  const [excluded, setExcluded] = useState<string[]>([]);
  const [avoid, setAvoid] = useState<string[]>([]);
  // After adding to the week: the recipes, to pick their groceries.
  const [shopping, setShopping] = useState<PickerRecipe[] | null>(null);

  const starter = useQuery({ queryKey: ['recipe', startWith], queryFn: () => api.getRecipe(startWith!), enabled: Boolean(startWith) });
  useEffect(() => {
    if (starter.data) setAnchor({ id: starter.data.id, title: starter.data.title });
  }, [starter.data]);

  const run = useMutation({
    mutationFn: (args: { keep?: string[]; keepDrafts?: PlanDraft[]; exclude?: string[]; avoid?: string[]; anchorId?: string }) =>
      mode === 'invent'
        ? api.inventPlan({ count, anchorId: args.anchorId, keep: args.keepDrafts, avoid: args.avoid })
        : api.suggestPlan({ count, anchorId: args.anchorId, keep: args.keep, exclude: args.exclude }),
    onSuccess: setPlan,
  });

  const accept = useMutation({
    mutationFn: async ({ plan: p, groceries }: { plan: PlanSuggestion; groceries: boolean }) => {
      const { recipeIds } = await api.acceptPlan(
        p.recipes.flatMap((r) => (r.id ? [r.id] : [])),
        p.recipes.flatMap((r) => (r.draft ? [r.draft] : [])),
      );
      // Claude's recipes only have ids now they're saved, so load them all fresh.
      return groceries ? Promise.all(recipeIds.map((id) => api.getRecipe(id))) : null;
    },
    onSuccess: (recipes) => {
      queryClient.invalidateQueries({ queryKey: ['plan'] });
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      if (recipes) setShopping(recipes.map((r) => ({ id: r.id, title: r.title, ingredients: r.ingredients, scale: 1 })));
      else navigate('/week');
    },
  });

  const first = plan?.recipes[0];

  function start() {
    setExcluded([]);
    setAvoid([]);
    run.mutate({ anchorId: mode === 'random' ? undefined : anchor?.id });
  }

  /** Replaces one recipe, keeping the rest. */
  function swap(key: string) {
    if (!plan || !first) return;
    const out = plan.recipes.find((r) => r.key === key)!;
    const rest = plan.recipes.filter((r) => r.key !== key);
    if (mode === 'invent') {
      const nextAvoid = [...avoid, out.title];
      setAvoid(nextAvoid);
      run.mutate({ anchorId: first.id!, keepDrafts: rest.flatMap((r) => (r.draft ? [r.draft] : [])), avoid: nextAvoid });
    } else {
      const nextExcluded = [...excluded, key];
      setExcluded(nextExcluded);
      run.mutate({ keep: rest.map((r) => r.key), exclude: nextExcluded });
    }
  }

  /** Same starting recipe, different company. */
  function again() {
    if (!plan || !first) return;
    const others = plan.recipes.slice(1);
    if (mode === 'invent') {
      const nextAvoid = [...avoid, ...others.map((r) => r.title)];
      setAvoid(nextAvoid);
      run.mutate({ anchorId: first.id!, avoid: nextAvoid });
    } else {
      const nextExcluded = [...excluded, ...others.map((r) => r.key)];
      setExcluded(nextExcluded);
      run.mutate({ keep: [first.key], exclude: nextExcluded });
    }
  }

  const needsAnchor = mode === 'pick' && !anchor;

  return (
    <div className="page plan-meals">
      <Link to="/week" className="back-link">
        ‹ This week
      </Link>
      <h1 className="form-title">Plan meals together</h1>

      {!plan ? (
        <>
          <p className="muted">
            Recipes that share ingredients, so what you buy for one gets used up by another.
          </p>

          <div className="servings plan-count">
            <span className="servings-label">How many recipes</span>
            <button type="button" className="stepper" onClick={() => setCount(count - 1)} disabled={count <= 2} aria-label="Fewer">
              −
            </button>
            <span className="servings-value">{count}</span>
            <button type="button" className="stepper" onClick={() => setCount(count + 1)} disabled={count >= 7} aria-label="More">
              +
            </button>
          </div>

          <div className="plan-modes" role="radiogroup" aria-label="How to start">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                className={`plan-mode ${mode === m.id ? 'on' : ''}`}
                onClick={() => setMode(m.id)}
              >
                <strong>{m.title}</strong>
                <span className="muted small">{m.detail}</span>
              </button>
            ))}
          </div>

          {mode !== 'random' && (
            <RecipePicker
              picked={anchor}
              onPick={setAnchor}
              hint={mode === 'invent' ? 'Leave empty and one is picked at random.' : null}
            />
          )}

          {run.error && <p className="error">{run.error.message}</p>}
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={needsAnchor || run.isPending} onClick={start}>
              {run.isPending ? (mode === 'invent' ? 'Claude is writing…' : 'Planning…') : `Plan ${count} recipes`}
            </button>
          </div>
          {run.isPending && mode === 'invent' && <p className="muted small">This can take a minute.</p>}
        </>
      ) : (
        <PlanResult
          plan={plan}
          busy={run.isPending}
          error={run.error?.message ?? accept.error?.message ?? null}
          inventing={mode === 'invent'}
          onSwap={swap}
          onAgain={again}
          onStartOver={() => {
            setPlan(null);
            run.reset();
          }}
          onAccept={(groceries) => accept.mutate({ plan, groceries })}
          accepting={accept.isPending}
        />
      )}

      {shopping && <GroceryPicker recipes={shopping} onClose={() => navigate('/week')} />}
    </div>
  );
}

function RecipePicker({ picked, onPick, hint }: { picked: Picked | null; onPick: (p: Picked | null) => void; hint: string | null }) {
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['recipes', { q, tag: undefined, favorite: false }],
    queryFn: () => api.listRecipes({ q }),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });

  if (picked) {
    return (
      <div className="plan-picked">
        <span>
          Starting from <strong>{picked.title}</strong>
        </span>
        <button type="button" className="link-btn" onClick={() => onPick(null)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="plan-picker">
      <input className="search" type="search" placeholder="Search your recipes…" value={q} onChange={(e) => setQ(e.target.value)} />
      {hint && !q.trim() && <p className="muted small">{hint}</p>}
      {q.trim() && (
        <ul className="meal-search">
          {results.data?.slice(0, 8).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="meal-search-item"
                onClick={() => {
                  onPick({ id: r.id, title: r.title });
                  setQ('');
                }}
              >
                {r.title}
              </button>
            </li>
          ))}
          {results.data?.length === 0 && <li className="muted small">No matches.</li>}
        </ul>
      )}
    </div>
  );
}

function PlanResult({
  plan,
  busy,
  error,
  inventing,
  onSwap,
  onAgain,
  onStartOver,
  onAccept,
  accepting,
}: {
  plan: PlanSuggestion;
  busy: boolean;
  error: string | null;
  inventing: boolean;
  onSwap: (key: string) => void;
  onAgain: () => void;
  onStartOver: () => void;
  onAccept: (groceries: boolean) => void;
  accepting: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <p className="muted week-summary">
        {plan.recipes.length} recipes · {plan.toBuy} things to buy
        {plan.shared.length > 0 && ` · ${plan.shared.length} shared`}
      </p>

      <ul className="recipe-list">
        {plan.recipes.map((r, i) => {
          const img = thumbUrl(r.image);
          const body = (
            <>
              {img ? <img className="thumb thumb-small" src={img} alt="" /> : <div className="thumb thumb-small thumb-empty">{r.title.charAt(0)}</div>}
              <div className="recipe-row-body">
                <div className="recipe-row-title">
                  {r.title}
                  {r.draft && <span className="badge">New</span>}
                </div>
                <div className="recipe-row-meta">
                  {i === 0 ? 'Starting point' : r.shares.length ? `Shares ${r.shares.join(', ')}` : 'Shares nothing much'}
                </div>
              </div>
            </>
          );
          return (
            <li key={r.key} className="plan-pick">
              <div className="plan-pick-row">
                {r.id ? (
                  <Link to={`/r/${r.id}`} className="plan-link">
                    {body}
                  </Link>
                ) : (
                  <button type="button" className="plan-link plan-link-btn" onClick={() => setOpen(open === r.key ? null : r.key)} aria-expanded={open === r.key}>
                    {body}
                  </button>
                )}
                {i > 0 && (
                  <button type="button" className="btn plan-swap" disabled={busy} onClick={() => onSwap(r.key)}>
                    Swap
                  </button>
                )}
              </div>
              {r.draft && open === r.key && <DraftDetail draft={r.draft} />}
            </li>
          );
        })}
      </ul>

      {plan.shared.length > 0 && (
        <section className="plan-shared">
          <h2 className="notes-section-title">Shared ingredients</h2>
          <ul>
            {plan.shared.map((s) => (
              <li key={s.name}>
                <div className="plan-shared-head">
                  <span className="plan-shared-name">
                    {s.name}
                    {s.kind === 'meat' && <span className="badge">Meat</span>}
                  </span>
                  {s.total && <span className="plan-shared-total">{s.total} in all</span>}
                </div>
                <ul className="plan-shared-uses">
                  {s.uses.map((u, i) => (
                    <li key={i}>
                      {u.line} <span className="muted">· {u.title}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="error">{error}</p>}
      {busy && <p className="muted small">{inventing ? 'Claude is writing… this can take a minute.' : 'Planning…'}</p>}
      <div className="settings-actions week-actions">
        <button type="button" className="btn btn-primary" disabled={busy || accepting} onClick={() => onAccept(true)}>
          {accepting ? 'Adding…' : 'Add to week & groceries'}
        </button>
        <button type="button" className="btn" disabled={busy || accepting} onClick={() => onAccept(false)}>
          Just add to week
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onAgain}>
          Try others
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onStartOver}>
          Start over
        </button>
      </div>
      {plan.recipes.some((r) => r.draft) && (
        <p className="muted small">Claude’s recipes are saved to your collection when you add them to the week.</p>
      )}
    </>
  );
}

function DraftDetail({ draft }: { draft: PlanDraft }) {
  const minutes = draft.prepMinutes + draft.cookMinutes;
  return (
    <div className="plan-draft">
      {draft.description && <p>{draft.description}</p>}
      <p className="muted small">
        {[draft.servings && `Serves ${draft.servings}`, minutes ? `${minutes} min` : null].filter(Boolean).join(' · ')}
      </p>
      <h3>Ingredients</h3>
      <ul>
        {draft.ingredients.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <h3>Steps</h3>
      <ol>
        {draft.steps.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
    </div>
  );
}
