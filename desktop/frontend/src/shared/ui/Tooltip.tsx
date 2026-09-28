import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { registerTooltipBlur } from './tooltipBlur';
import { LiquidGlassPanel } from './LiquidGlassPanel';
import styles from './Tooltip.module.css';

type TooltipTriggerProps<T extends Element> = Pick<HTMLAttributes<T>,
  'aria-describedby' | 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'>;

interface TooltipProps<T extends Element> {
  content: string;
  delay?: number;
  blurSourceRef?: RefObject<HTMLElement | null>;
  children: (props: TooltipTriggerProps<T>) => ReactNode;
}

function TooltipContent({ anchor, content, id, blurSourceRef }: {
  anchor: Element; content: string; id: string; blurSourceRef?: RefObject<HTMLElement | null>;
}) {
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

  useLayoutEffect(() => {
    const panel = ref.current?.firstElementChild as HTMLElement | null;
    if (panel) return registerTooltipBlur(panel, blurSourceRef?.current ?? undefined);
    return undefined;
  }, [blurSourceRef]);

  return createPortal(
    <div ref={ref} data-tooltip-blur-portal="true" className={styles.anchor} style={position ?? { visibility: 'hidden' }}>
      <LiquidGlassPanel id={id} role="tooltip" className={styles.content} data-liquid-glass-backdrop="false">
        {content}
      </LiquidGlassPanel>
    </div>,
    anchor.closest('dialog') ?? anchor.ownerDocument.body,
  );
}

export function Tooltip<T extends Element = HTMLElement>({ content, delay = 1000, blurSourceRef, children }: TooltipProps<T>) {
  const id = useId();
  const [anchor, setAnchor] = useState<Element | null>(null);
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

  const tooltip = visible && anchor ? <TooltipContent anchor={anchor} content={content} id={id} blurSourceRef={blurSourceRef} /> : null;
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
    {tooltip}
  </>;
}
