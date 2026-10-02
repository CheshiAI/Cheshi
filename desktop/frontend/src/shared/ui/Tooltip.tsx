import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { registerTooltipBlur } from './tooltipBlur';
import { LiquidGlassPanel } from './LiquidGlassPanel';
import styles from './Tooltip.module.css';

type TooltipTriggerProps<T extends Element> = Pick<HTMLAttributes<T>,
  'aria-describedby' | 'onPointerEnter' | 'onPointerOver' | 'onPointerLeave' | 'onFocus' | 'onBlur'> & {
    'data-tooltip-trigger'?: string;
  };

function isNearestTrigger(target: EventTarget, current: Element): boolean {
  return 'closest' in target && typeof target.closest === 'function'
    && target.closest('[data-tooltip-trigger]') === current;
}

interface TooltipProps<T extends Element> {
  content?: string;
  placement?: 'above' | 'below';
  delay?: number;
  blurSourceRef?: RefObject<HTMLElement | null>;
  resolveAnchor?: (element: T) => Element;
  children: (props: TooltipTriggerProps<T>) => ReactNode;
}

function TooltipContent({ anchor, content, id, blurSourceRef, placement }: {
  anchor: Element; content: string; id: string; blurSourceRef?: RefObject<HTMLElement | null>;
  placement: 'above' | 'below';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean; arrowLeft: number } | null>(null);

  useLayoutEffect(() => {
    const tooltip = ref.current;
    if (!tooltip) return;
    const bounds = anchor.getBoundingClientRect();
    const { width, height } = tooltip.getBoundingClientRect();
    const gap = 8;
    const below = bounds.bottom + gap;
    const aboveTop = bounds.top - height - gap;
    const above = placement === 'above' ? aboveTop >= gap : below + height > window.innerHeight - gap;
    const left = Math.max(gap, Math.min(bounds.left, window.innerWidth - width - gap));
    setPosition({
      left,
      top: Math.max(gap, above ? aboveTop : below),
      above,
      arrowLeft: Math.max(12, Math.min(bounds.left + bounds.width / 2 - left, width - 12)),
    });
  }, [anchor, content, placement]);

  useLayoutEffect(() => {
    const panel = ref.current?.firstElementChild as HTMLElement | null;
    if (panel) return registerTooltipBlur(panel, blurSourceRef?.current ?? undefined);
    return undefined;
  }, [blurSourceRef]);

  return createPortal(
    <div ref={ref} data-tooltip-blur-portal="true" data-placement={position?.above ? 'above' : 'below'}
      className={styles.anchor} style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}>
      <LiquidGlassPanel id={id} role="tooltip" className={styles.content} data-liquid-glass-backdrop="false">
        {content}
      </LiquidGlassPanel>
      <span aria-hidden="true" className={styles.arrow} style={{ left: position?.arrowLeft }} />
    </div>,
    anchor.closest('dialog') ?? anchor.ownerDocument.body,
  );
}

export function Tooltip<T extends Element = HTMLElement>({ content, placement = 'below', delay = 1000, blurSourceRef, resolveAnchor, children }: TooltipProps<T>) {
  const id = useId();
  const [anchor, setAnchor] = useState<Element | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!anchor || !content) return;
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

  const tooltip = visible && anchor && content ? <TooltipContent anchor={anchor} content={content} id={id} blurSourceRef={blurSourceRef} placement={placement} /> : null;
  return <>
    {children({
      'data-tooltip-trigger': content ? id : undefined,
      'aria-describedby': visible && anchor && content ? id : undefined,
      onPointerEnter: (event) => {
        if (content && event.pointerType !== 'touch' && isNearestTrigger(event.target, event.currentTarget)) {
          setAnchor(resolveAnchor?.(event.currentTarget) ?? event.currentTarget);
        }
      },
      onPointerOver: (event) => {
        if (!isNearestTrigger(event.target, event.currentTarget)) dismiss();
        else if (content && event.pointerType !== 'touch') setAnchor(resolveAnchor?.(event.currentTarget) ?? event.currentTarget);
      },
      onPointerLeave: dismiss,
      onFocus: (event) => {
        const target = resolveAnchor?.(event.currentTarget) ?? event.currentTarget;
        if (content && isNearestTrigger(event.target, event.currentTarget) && event.target.matches(':focus-visible')) setAnchor(target);
      },
      onBlur: dismiss,
    })}
    {tooltip}
  </>;
}
