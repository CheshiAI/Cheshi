interface HeldContent {
  element: HTMLElement;
  width: string;
  priority: string;
}

function milliseconds(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number * (value.trim().endsWith('ms') ? 1 : 1000) : 0;
}

function widthTransitionDuration(style: CSSStyleDeclaration): number {
  const properties = style.transitionProperty.split(',');
  const durations = style.transitionDuration.split(',');
  const delays = style.transitionDelay.split(',');
  return Math.max(0, ...properties.map((property, index) =>
    ['width', 'all'].includes(property.trim())
      ? milliseconds(durations[index % durations.length] ?? '0s') + milliseconds(delays[index % delays.length] ?? '0s') : 0));
}

/** Let the lightweight headers resize together while retaining message line breaks. */
export function createChatSidebarMotion() {
  let held: HeldContent[] = [];
  let disconnect: (() => void) | null = null;
  let workspace: HTMLElement | null = null;

  const release = () => {
    disconnect?.();
    disconnect = null;
    const timelines = new Set(held.map(({ element }) => element.parentElement).filter(
      (element): element is HTMLElement => element !== null && element.isConnected,
    ));
    const following = [...timelines].filter(element =>
      element.scrollHeight - element.scrollTop - element.clientHeight <= 48);
    for (const { element, width, priority } of held) {
      if (width) element.style.setProperty('width', width, priority);
      else element.style.removeProperty('width');
    }
    held = [];
    workspace = null;
    // Read after restoring widths, once. Do not move a reader browsing older messages.
    for (const timeline of following) timeline.scrollTop = timeline.scrollHeight;
  };

  const begin = (root: HTMLElement | null | undefined, stage: HTMLElement | null) => {
    const view = stage?.ownerDocument.defaultView;
    if (!root || !stage || !view) { release(); return; }
    const duration = widthTransitionDuration(view.getComputedStyle(stage));
    if (duration <= 0 || view.matchMedia('(prefers-reduced-motion: reduce)').matches) { release(); return; }
    if (workspace !== root) release();
    disconnect?.();
    workspace = root;
    // Rapid reversals reuse the original widths instead of reflowing at an intermediate width.
    const retained = new Set(held.map(entry => entry.element));
    const additions = [...root.querySelectorAll<HTMLElement>('[data-chat-layout-content]')]
      .filter(element => !retained.has(element))
      .map(element => ({ element, measured: view.getComputedStyle(element).width,
        width: element.style.getPropertyValue('width'), priority: element.style.getPropertyPriority('width') }))
      .filter(entry => Number.parseFloat(entry.measured) > 0);
    for (const { element, measured, width, priority } of additions) {
      held.push({ element, width, priority });
      element.style.setProperty('width', measured);
    }
    const finish = (event: TransitionEvent) => {
      if (event.target === stage && event.propertyName === 'width') release();
    };
    stage.addEventListener('transitionend', finish);
    // A hidden/unmounted stage or a cancelled transition might not emit transitionend.
    const timer = view.setTimeout(release, duration + 50);
    disconnect = () => {
      stage.removeEventListener('transitionend', finish);
      view.clearTimeout(timer);
    };
  };
  return { begin, dispose: release };
}
