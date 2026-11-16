import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SplitPaneDirection } from '../../shared/ui/splitPaneModel';
import { workspaceDropDirection } from '../shell/workspaceLayoutModel';
import { acceptsEditorFileDrop, EDITOR_TAB_TRANSFER_TYPE } from './editorFileDrop';
import styles from './EditorPanes.module.css';

export function EditorPaneHost({ host, id, onDrop, onDetach }: {
  host: HTMLDivElement;
  id: string;
  onDrop(data: DataTransfer, target: string, direction: SplitPaneDirection | null): void;
  onDetach(element: HTMLElement): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<SplitPaneDirection | 'center' | null>(null);
  useLayoutEffect(() => {
    ref.current?.append(host);
    return () => {
      const focused = host.ownerDocument.activeElement;
      if (focused instanceof HTMLElement && host.contains(focused)) onDetach(focused);
      host.remove();
    };
  }, [host, onDetach]);
  useEffect(() => {
    const mount = ref.current;
    if (!mount) return;
    const clear = () => setDrop(null);
    const directionAt = (event: DragEvent) => {
      // Tab bars remain reorder/open targets; the content surface supplies split edges.
      if (event.target instanceof Element && event.target.closest('[role="tablist"]')) return null;
      const content = host.querySelector('.workspace-editor-stage') ?? mount;
      return workspaceDropDirection(content.getBoundingClientRect(), event.clientX, event.clientY);
    };
    const over = (event: DragEvent) => {
      if (!event.dataTransfer || !acceptsEditorFileDrop(event.dataTransfer)) { clear(); return; }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = event.dataTransfer.types.includes(EDITOR_TAB_TRANSFER_TYPE) ? 'move' : 'copy';
      setDrop(directionAt(event) ?? 'center');
    };
    const leave = (event: DragEvent) => { if (!mount.contains(event.relatedTarget as Node | null)) clear(); };
    const receive = (event: DragEvent) => {
      clear();
      if (!event.dataTransfer || !acceptsEditorFileDrop(event.dataTransfer)) return;
      // Same-list tab reordering is handled by FlatTab before this bubble listener.
      event.preventDefault(); event.stopPropagation();
      onDrop(event.dataTransfer, id, directionAt(event));
    };
    mount.addEventListener('dragover', over);
    mount.addEventListener('dragleave', leave);
    mount.addEventListener('drop', receive);
    document.addEventListener('dragend', clear);
    document.addEventListener('drop', clear);
    window.addEventListener('blur', clear);
    return () => {
      mount.removeEventListener('dragover', over);
      mount.removeEventListener('dragleave', leave);
      mount.removeEventListener('drop', receive);
      document.removeEventListener('dragend', clear);
      document.removeEventListener('drop', clear);
      window.removeEventListener('blur', clear);
    };
  }, [host, id, onDrop]);
  return <div ref={ref} className={styles.mount} data-editor-pane={id} data-editor-drop={drop ?? undefined} />;
}
