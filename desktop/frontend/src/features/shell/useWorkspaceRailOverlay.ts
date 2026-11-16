import { useEffect, useRef } from 'react';
import type { WorkspaceHostApi } from '../../../../shared/workspace-host';

/** Continue the clipped label in a native layer above retained workspace views. */
export function useWorkspaceRailOverlay(api: WorkspaceHostApi, disabled = false) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (disabled) { api.railOverlay(null); return; }
    const rail = ref.current?.querySelector<HTMLElement>('[aria-label="Application navigation"]');
    if (!rail) return;
    let button: HTMLButtonElement | null = null;
    let keyboardNavigation = false;
    const publish = () => {
      const label = button?.querySelector<HTMLElement>('[data-rail-label]');
      if (!button || !label) return;
      const bounds = button.getBoundingClientRect(), edge = rail.getBoundingClientRect().right;
      const style = window.getComputedStyle(button), text = window.getComputedStyle(label);
      api.railOverlay({ id: button.dataset.railButton!, label: label.textContent ?? '',
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        clipLeft: edge, labelLeft: label.getBoundingClientRect().left - bounds.left,
        font: text.font, color: text.color, background: style.backgroundColor, radius: style.borderRadius });
    };
    const observer = new ResizeObserver(publish);
    const clear = () => {
      observer.disconnect();
      button?.removeAttribute('data-rail-expanded');
      button = null;
      api.railOverlay(null);
    };
    const enter = (event: Event) => {
      const next = event.target instanceof window.Element ? event.target.closest<HTMLButtonElement>('[data-rail-button]') : null;
      if (!next || next.disabled || !rail.contains(next)) { clear(); return; }
      if (next === button) return;
      clear(); button = next; button.setAttribute('data-rail-expanded', 'true');
      observer.observe(button); publish();
    };
    const leave = (event: PointerEvent) => {
      if (!button) return;
      const bounds = button.getBoundingClientRect();
      // Crossing into the native label is still inside the expanded button.
      if (event.clientX >= rail.getBoundingClientRect().right && event.clientX < bounds.right
        && event.clientY >= bounds.top && event.clientY < bounds.bottom) return;
      clear();
    };
    const unsubscribe = api.onRailEvent(event => {
      if (event.id !== button?.dataset.railButton) return;
      if (event.action === 'activate') { button.focus({ preventScroll: true }); button.click(); }
      clear();
    });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
      keyboardNavigation = !event.metaKey && !event.ctrlKey && !event.altKey
        && ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key);
    };
    // Electron restores the host renderer's last focused button when the app is
    // activated. That focus event is not a request to expand its native label.
    const focus = (event: FocusEvent) => { if (keyboardNavigation) enter(event); };
    const resetKeyboardNavigation = () => { keyboardNavigation = false; };
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof window.Node && !rail.contains(event.relatedTarget)) clear();
    };
    rail.addEventListener('pointerover', enter);
    rail.addEventListener('pointermove', enter);
    rail.addEventListener('focusin', focus);
    rail.addEventListener('focusout', blur);
    rail.addEventListener('pointerleave', leave);
    window.addEventListener('resize', clear);
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', resetKeyboardNavigation, true);
    window.addEventListener('blur', resetKeyboardNavigation);
    return () => {
      unsubscribe(); clear();
      rail.removeEventListener('pointerover', enter);
      rail.removeEventListener('pointermove', enter);
      rail.removeEventListener('focusin', focus);
      rail.removeEventListener('focusout', blur);
      rail.removeEventListener('pointerleave', leave);
      window.removeEventListener('resize', clear);
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', resetKeyboardNavigation, true);
      window.removeEventListener('blur', resetKeyboardNavigation);
    };
  }, [api, disabled]);
  return ref;
}
