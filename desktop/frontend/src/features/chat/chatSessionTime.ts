import { useEffect, useState } from 'react';

export function formatSessionElapsedTime(updatedAt: number, now: number): string {
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return '—';
  const seconds = Math.max(0, Math.floor(now / 1_000 - updatedAt));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor(minutes / 60) % 24;
  const remainingMinutes = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, remainingMinutes && `${remainingMinutes}m`]
    .filter(Boolean).join(' ');
}

// One clock per list; memoized rows only update when their displayed time changes.
export function useChatSessionClock(enabled: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}
