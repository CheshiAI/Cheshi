import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { LiquidGlassPanel } from './LiquidGlassPanel';
import styles from './Tooltip.module.css';

type TooltipTriggerProps = Pick<HTMLAttributes<HTMLElement>,
  'aria-describedby' | 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'>;

interface TooltipProps {
  content: string;
  delay?: number;
  children: (props: TooltipTriggerProps) => ReactNode;
}

function TooltipContent({ anchor, content, id }: { anchor: HTMLElement; content: string; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const tooltip = ref.current;
    if (!tooltip) return;
    const bounds = anchor.getBoundingClientRect();
    const { width, height } = tooltip.getBoundingClientRect();
    const gap = 8;
    const below = bounds.bottom + gap;
    setPosition({
      left: Math.max(gap, Math.min(bounds.left, window.innerWidth - width - gap)),
      top: Math.max(gap, below + height <= window.innerHeight - gap ? below : bounds.top - height - gap),
    });
  }, [anchor, content]);

  return createPortal(
    <div ref={ref} className={styles.anchor} style={position ?? { visibility: 'hidden' }}>
      <LiquidGlassPanel id={id} role="tooltip" className={styles.content}>
        {content}
      </LiquidGlassPanel>
    </div>,
    document.body,
  );
}

export function Tooltip({ content, delay = 1000, children }: TooltipProps) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => {
      setVisible(false);
      setAnchor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    const timer = window.setTimeout(() => {
      if (anchor.isConnected) setVisible(true);
    }, delay);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('contextmenu', dismiss, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('contextmenu', dismiss, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchor, content, delay]);

  const dismiss = () => {
    setVisible(false);
    setAnchor(null);
  };

  return <>
    {children({
      'aria-describedby': visible && anchor ? id : undefined,
      onPointerEnter: (event) => {
        if (event.pointerType !== 'touch') setAnchor(event.currentTarget);
      },
      onPointerLeave: dismiss,
      onFocus: (event) => {
        if (event.currentTarget.matches(':focus-visible')) setAnchor(event.currentTarget);
      },
      onBlur: dismiss,
    })}
    {visible && anchor && <TooltipContent anchor={anchor} content={content} id={id} />}
  </>;
}
