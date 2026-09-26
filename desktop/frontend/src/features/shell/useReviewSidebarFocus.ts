import { useLayoutEffect, useRef, useState, type FocusEvent, type RefObject } from 'react';

function canRestoreFocus(element: HTMLElement, slot: HTMLElement): boolean {
  return element.isConnected && !slot.contains(element)
    && !element.closest('[inert], [aria-hidden="true"], [hidden]')
    && !element.matches(':disabled');
}

function restoreFocus(slot: HTMLElement, previous: HTMLElement | null): void {
  const document = slot.ownerDocument;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !slot.contains(active)) return;

  const workspace = slot.parentElement?.querySelector('.workspace-column');
  const candidates = [previous, ...(workspace?.querySelectorAll<HTMLElement>(
    '.cm-content, button, a[href], input, textarea, select, [tabindex]',
  ) ?? [])];
  for (const candidate of candidates) {
    if (!candidate || !canRestoreFocus(candidate, slot)) continue;
    candidate.focus({ preventScroll: true });
    if (document.activeElement === candidate) return;
  }
  // A removed opener must not leave focus inside content that is being hidden.
  active.blur();
}

export function useReviewSidebarFocus(visible: boolean, slotRef: RefObject<HTMLElement | null>) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const [exposed, setExposed] = useState(visible);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot) {
      if (visible) {
        const active = slot.ownerDocument.activeElement;
        if (active instanceof HTMLElement && active !== slot.ownerDocument.body
          && canRestoreFocus(active, slot)) returnFocus.current = active;
      } else {
        restoreFocus(slot, returnFocus.current);
        returnFocus.current = null;
      }
    }
    setExposed(visible);
  }, [visible, slotRef]);

  const onFocusCapture = (event: FocusEvent<HTMLElement>): void => {
    const previous = event.relatedTarget;
    if (previous instanceof HTMLElement && previous !== event.currentTarget.ownerDocument.body
      && canRestoreFocus(previous, event.currentTarget)) returnFocus.current = previous;
  };

  // Closing takes two commits: move focus first, then hide the retained content.
  return { hidden: !visible && !exposed, onFocusCapture };
}
