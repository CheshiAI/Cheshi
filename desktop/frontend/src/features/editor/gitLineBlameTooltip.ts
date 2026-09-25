import type { GitLineBlame } from '../../../../shared/git-line-blame';
import panelStyles from '../../shared/ui/LiquidGlassPanel.module.css';
import { beginSplitPreview } from '../../shared/ui/splitPreviewState';
import './git-line-blame-tooltip.css';

let nextTooltipId = 0;

/** Attach a hover/focus card to an inline blame widget without using a native title. */
export function attachGitLineBlameTooltip(anchor: HTMLElement, blame: Extract<GitLineBlame, { status: 'committed' }>) {
  const document = anchor.ownerDocument;
  const window = document.defaultView!;
  const id = `git-line-blame-tooltip-${++nextTooltipId}`;
  let tooltip: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restoreNativeSurfaces: (() => void) | undefined;

  const close = () => {
    clearTimeout(timer);
    tooltip?.remove();
    tooltip = null;
    anchor.removeAttribute('aria-describedby');
    restoreNativeSurfaces?.();
    restoreNativeSurfaces = undefined;
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    window.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', close, true);
  };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  const onScroll = (event: Event) => {
    if (event.target instanceof window.Node && tooltip?.contains(event.target)) return;
    close();
  };
  const keepOpen = () => { clearTimeout(timer); };
  const leave = () => { clearTimeout(timer); timer = setTimeout(close, 120); };

  const open = () => {
    clearTimeout(timer);
    if (tooltip || !anchor.isConnected) return;
    tooltip = document.createElement('div');
    tooltip.className = 'git-line-blame-tooltip-anchor';
    const panel = document.createElement('div');
    panel.className = `${panelStyles.panel} git-line-blame-tooltip`;
    panel.id = id;
    panel.setAttribute('role', 'tooltip');
    panel.dataset.liquidGlassBackdrop = 'true';

    const heading = document.createElement('div');
    heading.className = 'git-line-blame-tooltip-heading';
    const title = document.createElement('span');
    title.textContent = 'LAST CHANGE';
    const hash = document.createElement('code');
    hash.textContent = blame.hash.slice(0, 8);
    heading.append(title, hash);

    const metadata = document.createElement('div');
    metadata.className = 'git-line-blame-tooltip-metadata';
    const author = document.createElement('span');
    author.textContent = blame.author;
    const date = document.createElement('time');
    date.dateTime = blame.authoredAt;
    date.textContent = new Date(blame.authoredAt).toLocaleString();
    metadata.append(author, date);

    const message = document.createElement('p');
    message.className = 'git-line-blame-tooltip-message';
    message.textContent = blame.summary;
    panel.append(heading, metadata, message);
    tooltip.append(panel);
    tooltip.addEventListener('pointerenter', keepOpen);
    tooltip.addEventListener('pointerleave', leave);
    document.body.append(tooltip);
    anchor.setAttribute('aria-describedby', id);
    restoreNativeSurfaces = beginSplitPreview();

    const bounds = anchor.getBoundingClientRect();
    const size = tooltip.getBoundingClientRect();
    const gap = 8;
    tooltip.style.left = `${Math.max(gap, Math.min(bounds.left, window.innerWidth - size.width - gap))}px`;
    const below = bounds.bottom + gap;
    tooltip.style.top = `${Math.max(gap, Math.min(
      below + size.height <= window.innerHeight - gap ? below : bounds.top - size.height - gap,
      window.innerHeight - size.height - gap,
    ))}px`;
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', close, true);
  };
  const enter = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    clearTimeout(timer);
    timer = setTimeout(open, 250);
  };
  anchor.addEventListener('pointerenter', enter);
  anchor.addEventListener('pointerleave', leave);
  anchor.addEventListener('focus', open);
  anchor.addEventListener('blur', close);
  return () => {
    close();
    anchor.removeEventListener('pointerenter', enter);
    anchor.removeEventListener('pointerleave', leave);
    anchor.removeEventListener('focus', open);
    anchor.removeEventListener('blur', close);
  };
}
