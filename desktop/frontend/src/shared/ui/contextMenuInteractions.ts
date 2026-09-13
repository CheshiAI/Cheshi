import {
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

const enabledMenuItemSelector = '[role="menuitem"]:not(:disabled)';
const navigationKeys = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export function focusAdjacentMenuItem(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!navigationKeys.has(event.key)) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(enabledMenuItemSelector),
  );
  if (items.length === 0) return;
  event.preventDefault();
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : event.key === 'ArrowDown'
        ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex]?.focus();
}

export function useContextMenuInteractions<T extends HTMLElement>(
  menuRef: RefObject<T | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(enabledMenuItemSelector)?.focus();
    });
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const closeMenu = (): void => onClose();

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [menuRef, onClose]);
}
