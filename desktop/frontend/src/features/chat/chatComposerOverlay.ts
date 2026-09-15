type OverlayRoot = { style: Pick<CSSStyleDeclaration, 'setProperty'> };
type Timeline = Pick<HTMLElement, 'scrollHeight' | 'scrollTo'>;

export function syncChatComposerOverlayHeight(
  root: OverlayRoot,
  height: number,
  timeline: Timeline | null,
  followBottom: boolean,
): boolean {
  root.style.setProperty('--composer-overlay-height', `${Math.ceil(height)}px`);
  if (!timeline || !followBottom) return false;

  // Read after updating the padding so a newly opened card cannot cover the latest message.
  timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'instant' });
  return true;
}
