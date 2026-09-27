import { splitTimers } from '../durations';
import { TimerChip } from '../timers';

/** A recipe step with its cooking times turned into timer buttons. */
export function StepText({ text, recipeTitle }: { text: string; recipeTitle: string }) {
  return (
    <>
      {splitTimers(text).map((part, i) =>
        part.type === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : (
          <TimerChip key={i} seconds={part.seconds} text={part.text} label={recipeTitle} />
        ),
      )}
    </>
  );
}
