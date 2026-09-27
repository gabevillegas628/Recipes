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
import { formatDuration } from './durations';

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
}

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
  const { unlock, beep } = useAlarm();

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
      setTimers((prev) => [
        ...prev.filter((t) => !t.dismissed),
        // randomUUID only exists on HTTPS/localhost; plain-http LAN testing needs a fallback.
        { id: crypto.randomUUID?.() ?? String(Math.random()), label, seconds, endsAt: Date.now() + seconds * 1000 },
      ]);
    },
    [mode, unlock],
  );

  const dismiss = useCallback((id: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(
    () => ({ timers: active, now, mode, setMode, start, dismiss }),
    [active, now, mode, setMode, start, dismiss],
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

/** Running timers, pinned to the top of the screen on every page. */
export function TimerTray() {
  const { timers, now, dismiss } = useTimers();

  // Let page layouts make room for the tray.
  useEffect(() => {
    document.documentElement.classList.toggle('has-timers', timers.length > 0);
  }, [timers.length]);

  if (timers.length === 0) return null;
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

/** A duration in a step, as a tappable timer button. */
export function TimerChip({ seconds, text, label }: { seconds: number; text: string; label: string }) {
  const { start } = useTimers();
  return (
    <button
      type="button"
      className="timer-chip"
      onClick={(e) => {
        e.stopPropagation();
        start(seconds, label);
      }}
      title={`Start a ${formatDuration(seconds)} timer`}
    >
      ⏱ {text}
    </button>
  );
}
