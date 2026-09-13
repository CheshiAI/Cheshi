import { useEffect, useState } from 'react';

import styles from './LoadingState.module.css';
import { ALICE_THINKING_QUOTES } from './loadingThinkingQuotes';

export type LoadingStateType = 'working' | 'processing' | 'preparing' | 'thinking';

interface LoadingStateProps {
  type?: LoadingStateType;
  className?: string;
  label?: string;
}

const LOADING_LABELS: Record<LoadingStateType, string> = {
  working: 'Working...',
  processing: 'Processing...',
  preparing: 'Preparing...',
  thinking: 'Thinking...',
};

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const position = ORBIT_ORDER.indexOf(index);
  return position === -1 ? null : position * 110;
});

function useThinkingQuote(type: LoadingStateType) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * ALICE_THINKING_QUOTES.length));

  useEffect(() => {
    if (type !== 'thinking') return;
    const interval = window.setInterval(() => {
      // Pick from the other entries so consecutive quotes never repeat.
      setIndex(previous => (previous + 1 + Math.floor(Math.random() * (ALICE_THINKING_QUOTES.length - 1)))
        % ALICE_THINKING_QUOTES.length);
    }, 6_000);
    return () => window.clearInterval(interval);
  }, [type]);

  return type === 'thinking' ? ALICE_THINKING_QUOTES[index] : undefined;
}

function useElapsed() {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = performance.now();
    const interval = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAt);
    }, 100);
    return () => window.clearInterval(interval);
  }, []);

  const totalSeconds = Math.floor(elapsedMs / 100) / 10;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  return `${Math.floor(totalSeconds / 60)}m ${(totalSeconds % 60).toFixed(1)}s`;
}

export function LoadingIndicator({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      className={className ? `${styles.grid} ${className}` : styles.grid}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    >
      {ORBIT_DELAYS.map((delay, index) => (
        <span
          key={index}
          className={styles.cell}
          data-idle={delay === null ? 'true' : undefined}
          style={delay === null ? undefined : { animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

export function LoadingState({ type = 'preparing', className, label }: LoadingStateProps) {
  const elapsed = useElapsed();
  const quote = useThinkingQuote(type);
  const statusLabel = label ?? LOADING_LABELS[type];

  return (
    <div className={className ? `${styles.root} ${className}` : styles.root} role="status" aria-label={statusLabel}>
      <LoadingIndicator />
      <span
        className={quote ? `${styles.label} ${styles.quote}` : styles.label}
        lang={quote ? 'en' : undefined}
        aria-hidden={quote ? 'true' : undefined}
        title={quote ? `${quote.speaker} · Alice’s Adventures in Wonderland, Chapter ${quote.chapter}` : undefined}
      >{quote ? quote.text : statusLabel}</span>
      <span className={styles.elapsed} aria-hidden="true">{elapsed}</span>
    </div>
  );
}
