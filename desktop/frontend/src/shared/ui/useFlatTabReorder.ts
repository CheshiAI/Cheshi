import { useEffect, useRef, useState, type DragEvent } from 'react';

export type TabDropSide = 'before' | 'after';
export type ReorderTab = (source: string, target: string, side: TabDropSide) => void;

export function useFlatTabReorder(onReorder?: ReorderTab, onStart?: (event: DragEvent<HTMLElement>, id: string) => void) {
  const sourceRef = useRef<string | null>(null);
  const [target, setTarget] = useState<{ id: string; side: TabDropSide } | null>(null);
  const finish = () => {
    sourceRef.current = null;
    setTarget(null);
  };
  useEffect(() => {
    document.addEventListener('dragend', finish);
    document.addEventListener('drop', finish);
    window.addEventListener('blur', finish);
    return () => {
      document.removeEventListener('dragend', finish);
      document.removeEventListener('drop', finish);
      window.removeEventListener('blur', finish);
    };
  }, []);
  const sideAt = (event: DragEvent<HTMLElement>): TabDropSide => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
  };

  return {
    enabled: Boolean(onReorder),
    target,
    start(event: DragEvent<HTMLElement>, id: string) {
      if (!onReorder) return;
      sourceRef.current = id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-cheshi-tab', id);
      onStart?.(event, id);
    },
    over(event: DragEvent<HTMLElement>, id: string) {
      if (!onReorder || sourceRef.current === null) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      const side = sideAt(event);
      setTarget(current => current?.id === id && current.side === side ? current : { id, side });
      const list = event.currentTarget.closest<HTMLElement>('[role="tablist"]');
      if (list) {
        const bounds = list.getBoundingClientRect();
        if (event.clientX < bounds.left + 24) list.scrollLeft -= 24;
        else if (event.clientX > bounds.right - 24) list.scrollLeft += 24;
      }
    },
    leave(event: DragEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
    },
    drop(event: DragEvent<HTMLElement>, id: string) {
      const source = sourceRef.current;
      if (!onReorder || source === null) return;
      event.preventDefault();
      event.stopPropagation();
      const side = sideAt(event);
      finish();
      onReorder(source, id, side);
    },
    finish,
  };
}
