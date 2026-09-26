import { useCallback, useEffect, useRef, useState } from 'react';

/** Keeps the phone screen awake while cooking. Released when leaving the page. */
export function useWakeLock() {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const [active, setActive] = useState(false);
  const wanted = useRef(false);

  const acquire = useCallback(async () => {
    try {
      sentinel.current = await navigator.wakeLock.request('screen');
      sentinel.current.addEventListener('release', () => setActive(false));
      setActive(true);
    } catch {
      setActive(false);
    }
  }, []);

  const release = useCallback(async () => {
    await sentinel.current?.release();
    sentinel.current = null;
    setActive(false);
  }, []);

  const toggle = useCallback(() => {
    wanted.current = !wanted.current;
    if (wanted.current) acquire();
    else release();
  }, [acquire, release]);

  // The browser drops the lock when the tab is hidden; take it back on return.
  useEffect(() => {
    const onVisible = () => {
      if (wanted.current && document.visibilityState === 'visible') acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      wanted.current = false;
      sentinel.current?.release();
    };
  }, [acquire]);

  return { supported, active, toggle };
}
