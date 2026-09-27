import { baseServings, formatAmount } from '../scale';

const MULTIPLIERS = [0.5, 1, 1.5, 2, 3];

/**
 * Pick how much to make. With a known serving count: a − / + stepper.
 * Without one ("1 loaf", or nothing): multiplier chips.
 */
export function ServingsControl({
  servings,
  scale,
  onChange,
}: {
  servings: string | null;
  scale: number;
  onChange: (scale: number) => void;
}) {
  const base = baseServings(servings);

  if (base) {
    const current = Math.round(base * scale * 100) / 100;
    const step = (delta: number) => {
      const next = Math.max(1, Math.round(current) + delta);
      onChange(next / base);
    };
    return (
      <div className="servings">
        <span className="servings-label">Serves</span>
        <button type="button" className="stepper" onClick={() => step(-1)} disabled={current <= 1} aria-label="Fewer servings">
          −
        </button>
        <span className="servings-value">{formatAmount(current, null)}</span>
        <button type="button" className="stepper" onClick={() => step(1)} aria-label="More servings">
          +
        </button>
        {scale !== 1 && (
          <button type="button" className="link-btn" onClick={() => onChange(1)}>
            Reset to {servings}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="servings">
      <span className="servings-label">Make</span>
      <div className="chips">
        {MULTIPLIERS.map((m) => (
          <button key={m} type="button" className={`chip ${m === scale ? 'chip-on' : ''}`} onClick={() => onChange(m)}>
            {m === 0.5 ? '½' : m === 1.5 ? '1½' : m}×
          </button>
        ))}
      </div>
    </div>
  );
}
