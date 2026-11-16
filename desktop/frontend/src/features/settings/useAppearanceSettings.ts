import { useEffect, useRef, useState } from 'react';
import type { WindowAppearance, WindowAppearanceApi, WindowAppearanceState } from '../../../../shared/window-appearance';

export function useAppearanceSettings(api: WindowAppearanceApi | undefined) {
  const [state, setState] = useState<WindowAppearanceState | null>(null);
  const [draft, setDraft] = useState<WindowAppearance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef<WindowAppearance | null>(null);
  const running = useRef(false);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = async () => {
    clearTimeout(timer.current);
    if (!api || running.current) return;
    running.current = true;
    if (mounted.current) setBusy(true);
    try {
      while (pending.current) {
        const next = pending.current;
        const current = revision.current;
        pending.current = null;
        try {
          const value = await api.set(next);
          if (mounted.current) {
            setState(value);
            if (current === revision.current) { setDraft(value.preferences); setError(null); }
          }
        } catch {
          if (mounted.current && current === revision.current) setError('Could not save appearance settings.');
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (!api) return () => { mounted.current = false; };
    let disposed = false, received = 0;
    const receive = (value: WindowAppearanceState) => {
      if (disposed) return;
      setState(value);
      if (!pending.current && !running.current) setDraft(value.preferences);
    };
    const unsubscribe = api.onChanged(value => { received++; receive(value); });
    const current = received;
    void api.get().then(value => { if (received === current) receive(value); })
      .catch(() => { if (!disposed) setError('Could not load appearance settings.'); });
    return () => {
      disposed = true; mounted.current = false; unsubscribe(); clearTimeout(timer.current);
      // Navigating away immediately after a drag still persists the final value.
      void flush();
    };
  }, [api]);

  const update = (value: WindowAppearance, immediate = false) => {
    revision.current++;
    pending.current = value;
    setDraft(value); setError(null);
    clearTimeout(timer.current);
    // Opacity previews need only a CSS tint change, not a WindowServer call.
    document.documentElement.style.setProperty('--window-glass-opacity', String(value.opacity));
    if (immediate) void flush();
    else timer.current = setTimeout(() => { void flush(); }, 120);
  };
  return { state, draft, error, busy, update, flush };
}
