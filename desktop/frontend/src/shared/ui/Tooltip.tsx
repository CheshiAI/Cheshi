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

function isVisibleAnchor(anchor: Element): boolean {
  if (!anchor.isConnected || anchor.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const visibility = anchor.ownerDocument.defaultView?.getComputedStyle(anchor).visibility;
  return visibility !== 'hidden' && visibility !== 'collapse'
    && Array.from(anchor.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
}

interface TooltipProps<T extends Element> {
  content?: string;
  placement?: 'above' | 'below';
  horizontalOffset?: number;
  delay?: number;
  blurSourceRef?: RefObject<HTMLElement | null>;
  resolveAnchor?: (element: T) => Element;
  children: (props: TooltipTriggerProps<T>) => ReactNode;
}

function TooltipContent({ anchor, content, id, blurSourceRef, placement, horizontalOffset }: {
  anchor: Element; content: string; id: string; blurSourceRef?: RefObject<HTMLElement | null>;
  placement: 'above' | 'below';
  horizontalOffset: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    const tooltip = ref.current;
    if (!tooltip) return;
    const bounds = anchor.getBoundingClientRect();
    const { width, height } = tooltip.getBoundingClientRect();
    const gap = 16;
    const viewportMargin = 8;
    const below = bounds.bottom + gap;
    const aboveTop = bounds.top - height - gap;
    const above = placement === 'above' ? aboveTop >= viewportMargin : below + height > window.innerHeight - viewportMargin;
    const left = Math.max(viewportMargin, Math.min(bounds.left + horizontalOffset, window.innerWidth - width - viewportMargin));
    setPosition({
      left,
      top: Math.max(viewportMargin, above ? aboveTop : below),
      above,
    });
  }, [anchor, content, placement, horizontalOffset]);

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
    </div>,
    anchor.closest('dialog') ?? anchor.ownerDocument.body,
  );
}

export function Tooltip<T extends Element = HTMLElement>({ content, placement = 'below', horizontalOffset = 0, delay = 1000, blurSourceRef, resolveAnchor, children }: TooltipProps<T>) {
  const id = useId();
  const [anchor, setAnchor] = useState<Element | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!anchor || !content) return;
    let timer: number | undefined;
    const dismiss = () => {
      window.clearTimeout(timer);
      setVisible(false);
      setAnchor(null);
    };
    if (!isVisibleAnchor(anchor)) {
      dismiss();
      return;
    }
    const checkAnchor = () => { if (!isVisibleAnchor(anchor)) dismiss(); };
    // Kept-alive workspace panes can hide without pointerleave or blur events.
    // Watch only the anchor's ancestor chain, not all document mutations.
    const observer = new window.MutationObserver(checkAnchor);
    for (let element: Element | null = anchor; element; element = element.parentElement) {
      observer.observe(element, { attributes: true, childList: true,
        attributeFilter: ['hidden', 'inert', 'aria-hidden', 'class', 'style'] });
    }
    const resizeObserver = new window.ResizeObserver(checkAnchor);
    resizeObserver.observe(anchor);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    timer = window.setTimeout(() => {
      if (isVisibleAnchor(anchor)) setVisible(true);
      else dismiss();
    }, delay);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('contextmenu', dismiss, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      resizeObserver.disconnect();
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

  const tooltip = visible && anchor && content ? <TooltipContent anchor={anchor} content={content} id={id} blurSourceRef={blurSourceRef} placement={placement} horizontalOffset={horizontalOffset} /> : null;
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
