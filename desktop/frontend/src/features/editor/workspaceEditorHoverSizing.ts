/** Fit the hover surface to its wrapped lines instead of retaining the wrapping limit. */
export function fitWorkspaceEditorHover(content: HTMLElement): void {
  const host = content.closest<HTMLElement>('.cm-tooltip-hover') ?? content;
  const sections = host === content ? [content]
    : [...host.querySelectorAll<HTMLElement>(':scope > .cm-tooltip-section')];
  if (sections.some(section => !section.classList.contains('workspace-editor-symbol-hover'))) return;
  const window = host.ownerDocument.defaultView;
  if (!window) return;

  const previousWidth = host.style.width;
  // Recompute from the natural wrapping limit so a resized window can grow the hover again.
  host.style.width = 'max-content';
  const bounds = host.getBoundingClientRect();
  const borderRight = Number.parseFloat(window.getComputedStyle(host).borderRightWidth) || 0;
  let width = 0;
  for (const section of sections) {
    const paddingRight = Number.parseFloat(window.getComputedStyle(section).paddingRight) || 0;
    for (const block of section.querySelectorAll('pre, p')) {
      const range = host.ownerDocument.createRange();
      range.selectNodeContents(block);
      for (const line of range.getClientRects()) {
        if (line.width > 0) width = Math.max(width, line.right - bounds.left + paddingRight + borderRight);
      }
    }
  }
  host.style.width = width > 0 ? `${Math.ceil(Math.min(width, bounds.width))}px` : previousWidth;
}
