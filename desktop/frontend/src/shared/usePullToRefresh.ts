import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const PULL_THRESHOLD = 72;
const WHEEL_IDLE_MS = 180;

/** A refresh gesture starts at the top; reaching the top during ordinary scrolling is not enough. */
export function usePullToRefresh(onRefresh?: () => Promise<void>, disabled = false) {
  const [viewport, viewportRef] = useState<HTMLDivElement | null>(null);
  const latest = useRef({ onRefresh, disabled });
  useLayoutEffect(() => { latest.current = { onRefresh, disabled }; }, [onRefresh, disabled]);
  const mounted = useRef(false);
  const pending = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pull, setPull] = useState(0);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const current = latest.current;
    if (!current.onRefresh || current.disabled || pending.current) return;
    pending.current = true; setRefreshing(true); setError(''); setPull(0);
    try { await current.onRefresh(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; if (mounted.current) setRefreshing(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setPull(0);
    const view = viewport?.ownerDocument.defaultView;
    if (!viewport || !view) return;
    let pointer: { id: number; x: number; y: number; captured: boolean } | undefined;
    let distance = 0;
    let suppressClickUntil = 0;
    let wheelBlocked = false;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = () => pending.current || latest.current.disabled || !latest.current.onRefresh;
    const display = (value: number) => { distance = Math.max(0, Math.min(120, value)); setPull(distance); };
    const release = () => {
      if (pointer && viewport.hasPointerCapture?.(pointer.id)) viewport.releasePointerCapture(pointer.id);
      pointer = undefined;
    };
    const cancel = () => {
      if (pointer?.captured) suppressClickUntil = Date.now() + 400;
      release(); display(0);
    };
    const wheelEnd = () => {
      wheelTimer = undefined;
      const ready = !wheelBlocked && distance >= PULL_THRESHOLD && viewport.scrollTop <= 1;
      display(0); wheelBlocked = false;
      if (ready) void refresh();
    };
    const wheel = (event: WheelEvent) => {
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(wheelEnd, WHEEL_IDLE_MS);
      if (pointer || unavailable() || event.ctrlKey || event.metaKey || event.deltaY >= 0
        || Math.abs(event.deltaX) > Math.abs(event.deltaY) || viewport.scrollTop > 1) {
        wheelBlocked = true;
        if (!pointer) display(0);
        return;
      }
      if (wheelBlocked) return;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      display(distance - event.deltaY * units);
      event.preventDefault();
    };
    const down = (event: PointerEvent) => {
      suppressClickUntil = 0;
      if (unavailable() || viewport.scrollTop > 1 || event.button !== 0 || !event.isPrimary
        || event.pointerType === 'touch' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (target instanceof view.Element
        && target.closest('input, textarea, select, [contenteditable="true"], [draggable="true"]')) return;
      clearTimeout(wheelTimer); wheelTimer = undefined; wheelBlocked = false;
      display(0);
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, captured: false };
    };
    const move = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dy = event.clientY - pointer.y, dx = Math.abs(event.clientX - pointer.x);
      if (unavailable() || viewport.scrollTop > 1 || dy < -8 || (dx > 8 && dx > Math.abs(dy))) { cancel(); return; }
      if (dy <= 8 && !pointer.captured) return;
      if (!pointer.captured) {
        pointer.captured = true;
        viewport.setPointerCapture?.(pointer.id);
      }
      event.preventDefault();
      display(dy);
    };
    const up = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const ready = distance >= PULL_THRESHOLD && viewport.scrollTop <= 1;
      if (pointer.captured) suppressClickUntil = Date.now() + 400;
      cancel();
      if (ready) void refresh();
    };
    const pointerCancel = (event: PointerEvent) => { if (pointer?.id === event.pointerId) cancel(); };
    const click = (event: MouseEvent) => {
      if (event.detail !== 0 && Date.now() < suppressClickUntil) {
        suppressClickUntil = 0; event.preventDefault(); event.stopPropagation();
      }
    };
    const selection = (event: Event) => { if (pointer?.captured) event.preventDefault(); };
    const blur = () => { clearTimeout(wheelTimer); wheelTimer = undefined; wheelBlocked = false; cancel(); };
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('pointerdown', down);
    viewport.addEventListener('click', click, true);
    viewport.addEventListener('selectstart', selection);
    view.addEventListener('pointermove', move, { passive: false });
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', pointerCancel);
    view.addEventListener('blur', blur);
    return () => {
      clearTimeout(wheelTimer); release();
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('pointerdown', down);
      viewport.removeEventListener('click', click, true);
      viewport.removeEventListener('selectstart', selection);
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', up);
      view.removeEventListener('pointercancel', pointerCancel);
      view.removeEventListener('blur', blur);
    };
  }, [refresh, viewport]);
  // Once armed, keep the revealed space unchanged when the gesture becomes a request.
  const pullHeight = (refreshing ? PULL_THRESHOLD : Math.min(pull, PULL_THRESHOLD)) / 2;
  return { viewportRef, refresh, refreshing, pullHeight, ready: pull >= PULL_THRESHOLD, error };
}
