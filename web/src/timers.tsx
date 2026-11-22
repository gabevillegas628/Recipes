import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { formatDuration, rangeSteps } from './durations';

/**
 * Kitchen timers. In-app timers are stored as end times, so they survive reloads
 * and a locked phone (they ring as soon as the app is visible again). On iPhone
 * they can instead be handed to the Clock app through a "Recipe Timer" Shortcut.
 */

interface Timer {
  id: string;
  label: string;
  seconds: number;
  endsAt: number;
  dismissed?: boolean;
}

export type TimerMode = 'app' | 'shortcut';

const STORAGE = 'timers';
const MODE_STORAGE = 'timer-mode';
export const SHORTCUT_NAME = 'Recipe Timer';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable; timers still work until reload.
  }
}

interface TimerContextValue {
  timers: Timer[];
  now: number;
  mode: TimerMode;
  setMode: (mode: TimerMode) => void;
  start: (seconds: number, label: string) => void;
  dismiss: (id: string) => void;
  /** The timer just started, offered for undo for a few seconds. */
  justStarted: Timer | null;
  clearJustStarted: () => void;
}

const UNDO_MS = 5000;

const TimerContext = createContext<TimerContextValue | null>(null);

export function useTimers() {
  const ctx = useContext(TimerContext);
  if (!ctx) throw new Error('useTimers outside TimerProvider');
  return ctx;
}

/** A short repeating beep, via Web Audio (unlocked by the tap that started the timer). */
function useAlarm() {
  const audio = useRef<AudioContext | null>(null);

  const unlock = useCallback(() => {
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume();
    } catch {
      // No audio; vibration and the on-screen alert still work.
    }
  }, []);

  const beep = useCallback(() => {
    const ctx = audio.current;
    if (ctx) {
      for (const offset of [0, 0.25, 0.5]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.2);
      }
    }
    navigator.vibrate?.([300, 150, 300, 150, 300]);
  }, []);

  return { unlock, beep };
}

export function TimerProvider({ children }: { children: ReactNode }) {
  const [timers, setTimers] = useState<Timer[]>(() =>
    load<Timer[]>(STORAGE, []).filter((t) => !t.dismissed),
  );
  const [mode, setModeState] = useState<TimerMode>(() => load<TimerMode>(MODE_STORAGE, 'app'));
  const [now, setNow] = useState(() => Date.now());
  const [justStarted, setJustStarted] = useState<Timer | null>(null);
  const { unlock, beep } = useAlarm();

  useEffect(() => {
    if (!justStarted) return;
    const id = setTimeout(() => setJustStarted(null), UNDO_MS);
    return () => clearTimeout(id);
  }, [justStarted]);

  const clearJustStarted = useCallback(() => setJustStarted(null), []);

  useEffect(() => save(STORAGE, timers), [timers]);

  const active = timers.filter((t) => !t.dismissed);
  const ringing = active.some((t) => t.endsAt <= now);

  // Tick while anything is running or ringing.
  useEffect(() => {
    if (active.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active.length]);

  // Beep every couple of seconds until a finished timer is dismissed.
  useEffect(() => {
    if (!ringing) return;
    beep();
    const id = setInterval(beep, 2500);
    return () => clearInterval(id);
  }, [ringing, beep]);

  const setMode = useCallback((m: TimerMode) => {
    setModeState(m);
    save(MODE_STORAGE, m);
  }, []);

  const start = useCallback(
    (seconds: number, label: string) => {
      if (mode === 'shortcut') {
        const url = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&input=text&text=${seconds}`;
        window.location.href = url;
        return;
      }
      unlock();
      setNow(Date.now());
      const timer: Timer = {
        // randomUUID only exists on HTTPS/localhost; plain-http LAN testing needs a fallback.
        id: crypto.randomUUID?.() ?? String(Math.random()),
        label,
        seconds,
        endsAt: Date.now() + seconds * 1000,
      };
      setTimers((prev) => [...prev.filter((t) => !t.dismissed), timer]);
      setJustStarted(timer);
    },
    [mode, unlock],
  );

  const dismiss = useCallback((id: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(
    () => ({ timers: active, now, mode, setMode, start, dismiss, justStarted, clearJustStarted }),
    [active, now, mode, setMode, start, dismiss, justStarted, clearJustStarted],
  );
  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

function clock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "Timer started · Undo", so a mis-tap or a slip of the slider is one tap to fix. */
function UndoToast() {
  const { justStarted, dismiss, clearJustStarted } = useTimers();
  if (!justStarted) return null;
  return (
    <div className="timer-toast" role="status">
      <span>{formatDuration(justStarted.seconds)} timer started</span>
      <button
        type="button"
        onClick={() => {
          dismiss(justStarted.id);
          clearJustStarted();
        }}
      >
        Undo
      </button>
    </div>
  );
}

/** Running timers, pinned to the top of the screen on every page. */
export function TimerTray() {
  const { timers, now, dismiss } = useTimers();

  // Let page layouts make room for the tray.
  useEffect(() => {
    document.documentElement.classList.toggle('has-timers', timers.length > 0);
  }, [timers.length]);

  return (
    <>
      <UndoToast />
      {timers.length > 0 && <RunningTimers timers={timers} now={now} dismiss={dismiss} />}
    </>
  );
}

function RunningTimers({ timers, now, dismiss }: { timers: Timer[]; now: number; dismiss: (id: string) => void }) {
  return (
    <div className="timer-tray" role="status">
      {timers.map((t) => {
        const left = t.endsAt - now;
        const done = left <= 0;
        return (
          <button
            key={t.id}
            type="button"
            className={`timer-pill ${done ? 'done' : ''}`}
            onClick={() => {
              if (done || confirm(`Cancel the ${formatDuration(t.seconds)} timer?`)) dismiss(t.id);
            }}
          >
            <span className="timer-time">{done ? 'Done!' : clock(left)}</span>
            <span className="timer-label">{t.label}</span>
            <span aria-hidden>✕</span>
          </button>
        );
      })}
    </div>
  );
}

/** A duration in a step, as a tappable timer button. Ranges open a slider to pick the time. */
export function TimerChip({
  seconds,
  maxSeconds,
  text,
  label,
}: {
  seconds: number;
  maxSeconds?: number;
  text: string;
  label: string;
}) {
  const { start } = useTimers();
  const [picking, setPicking] = useState(false);
  const isRange = maxSeconds !== undefined;
  return (
    <>
      <button
        type="button"
        className="timer-chip"
        onClick={(e) => {
          e.stopPropagation();
          if (isRange) setPicking(true);
          else start(seconds, label);
        }}
        title={
          isRange
            ? `Pick a ${formatDuration(seconds)} to ${formatDuration(maxSeconds)} timer`
            : `Start a ${formatDuration(seconds)} timer`
        }
      >
        ⏱ {text}
      </button>
      {picking && isRange && (
        <TimerRangeSheet
          low={seconds}
          high={maxSeconds}
          onPick={(s) => {
            setPicking(false);
            start(s, label);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

/** How far above the track (px) a finger can drift before letting go cancels. */
const CANCEL_DISTANCE = 70;

/**
 * A bottom sheet with a slider over a range of times. Press anywhere on the
 * track, slide, and let go to start the timer; drag up off the slider first to
 * let go without starting. Tapping outside closes it.
 */
function TimerRangeSheet({
  low,
  high,
  onPick,
  onClose,
}: {
  low: number;
  high: number;
  onPick: (seconds: number) => void;
  onClose: () => void;
}) {
  const values = useMemo(() => rangeSteps(low, high), [low, high]);
  const [index, setIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const lastIndex = values.length - 1;

  useEffect(() => {
    track.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const indexAt = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(fraction * lastIndex);
  };
  const isCancel = (clientY: number) =>
    clientY < track.current!.getBoundingClientRect().top - CANCEL_DISTANCE;

  const percent = lastIndex ? (index / lastIndex) * 100 : 0;

  // Events from a portal still bubble through the React tree, into cook mode's
  // swipe handlers and the step's own click handler; keep them in here.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return createPortal(
    <div
      className="cook-sheet-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onTouchStart={stop}
      onTouchEnd={stop}
    >
      <section
        className="cook-sheet timer-range-sheet"
        role="dialog"
        aria-label="Pick a timer length"
        onClick={stop}
      >
        <p className={`timer-range-value ${cancelling ? 'cancelling' : ''}`}>
          {cancelling ? 'Let go to cancel' : formatDuration(values[index])}
        </p>
        <div
          ref={track}
          className={`timer-range-track ${dragging ? 'dragging' : ''}`}
          role="slider"
          tabIndex={0}
          aria-valuemin={low}
          aria-valuemax={high}
          aria-valuenow={values[index]}
          aria-valuetext={formatDuration(values[index])}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            setCancelling(false);
            setIndex(indexAt(e.clientX));
          }}
          onPointerMove={(e) => {
            if (!dragging) return;
            setIndex(indexAt(e.clientX));
            setCancelling(isCancel(e.clientY));
          }}
          onPointerUp={(e) => {
            if (!dragging) return;
            setDragging(false);
            setCancelling(false);
            if (!isCancel(e.clientY)) onPick(values[indexAt(e.clientX)]);
          }}
          onPointerCancel={() => {
            setDragging(false);
            setCancelling(false);
          }}
          // Stops iOS turning the lift into a click on whatever is under the closed sheet.
          onTouchEnd={(e) => e.cancelable && e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setIndex((i) => Math.max(0, i - 1));
            else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setIndex((i) => Math.min(lastIndex, i + 1));
            else if (e.key === 'Home') setIndex(0);
            else if (e.key === 'End') setIndex(lastIndex);
            else if (e.key === 'Enter' || e.key === ' ') onPick(values[index]);
            else return;
            e.preventDefault();
          }}
        >
          <div className="timer-range-rail">
            <div className="timer-range-fill" style={{ width: `${percent}%` }} />
            {values.map((_, i) => (
              <span
                key={i}
                className={`timer-range-tick ${i <= index ? 'on' : ''}`}
                style={{ left: `${lastIndex ? (i / lastIndex) * 100 : 0}%` }}
              />
            ))}
            <div className="timer-range-thumb" style={{ left: `${percent}%` }} />
          </div>
        </div>
        <div className="timer-range-ends" aria-hidden>
          <span>{formatDuration(low)}</span>
          <span>{formatDuration(high)}</span>
        </div>
        <p className="timer-range-hint">Slide and let go to start · drag up to cancel</p>
      </section>
    </div>,
    document.body,
  );
}
