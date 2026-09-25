import { FileCode2, MessageSquare, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { SplitPaneLayout } from '../../shared/ui/SplitPaneLayout';
import { SplitPreview, type SplitPreviewDirection } from '../../shared/ui/SplitPreview';
import { resizeSplitPane, splitPaneIds, type SplitLayoutNode, type SplitPaneDirection } from '../../shared/ui/splitPaneModel';
import { placeWorkspacePane, visibleWorkspaceLayout, workspaceDropDirection, type LayoutMode, type WorkspacePaneId } from './workspaceLayoutModel';
import { WorkspaceLayoutContext, WorkspacePaneContext, WorkspacePaneVisibilityContext, workspacePaneDragType } from './WorkspaceLayoutControls';
import { beginSplitPreview } from '../../shared/ui/splitPreviewState';
import styles from './WorkspaceEditorSplit.module.css';

function PaneHost({ host, paneId, onMove, onDetach, dragSource }: {
  host: HTMLDivElement; paneId: WorkspacePaneId;
  onMove(source: WorkspacePaneId, target: WorkspacePaneId, direction: SplitPaneDirection): void;
  dragSource: RefObject<WorkspacePaneId | null>;
  onDetach(element: HTMLElement): void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<SplitPaneDirection | null>(null);
  useLayoutEffect(() => {
    mountRef.current?.append(host);
    return () => {
      const focused = host.ownerDocument.activeElement;
      if (focused && host.contains(focused)) onDetach(focused as HTMLElement);
      host.remove();
    };
  }, [host, onDetach]);
  // Portal events follow the React tree; native listeners follow the actual pane DOM.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const doc = mount.ownerDocument;
    const clear = () => setDrop(null);
    const directionAt = (event: DragEvent) => workspaceDropDirection(mount.getBoundingClientRect(), event.clientX, event.clientY);
    const accepts = (event: DragEvent) => dragSource.current !== null && dragSource.current !== paneId
      && event.dataTransfer?.types.includes(workspacePaneDragType);
    const over = (event: DragEvent) => {
      const direction = accepts(event) ? directionAt(event) : null;
      setDrop(direction);
      if (!direction || !event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    };
    const leave = (event: DragEvent) => {
      if (!mount.contains(event.relatedTarget as Node | null)) clear();
    };
    const dropPane = (event: DragEvent) => {
      const direction = accepts(event) ? directionAt(event) : null;
      const source = dragSource.current;
      clear();
      if (!direction || !source || event.dataTransfer?.getData(workspacePaneDragType) !== source) return;
      event.preventDefault();
      onMove(source, paneId, direction);
    };
    mount.addEventListener('dragover', over);
    mount.addEventListener('dragleave', leave);
    mount.addEventListener('drop', dropPane);
    doc.addEventListener('dragend', clear);
    doc.addEventListener('drop', clear);
    doc.defaultView?.addEventListener('blur', clear);
    return () => {
      mount.removeEventListener('dragover', over);
      mount.removeEventListener('dragleave', leave);
      mount.removeEventListener('drop', dropPane);
      doc.removeEventListener('dragend', clear);
      doc.removeEventListener('drop', clear);
      doc.defaultView?.removeEventListener('blur', clear);
    };
  }, [dragSource, paneId, onMove]);
  return <div className={styles.mount} ref={mountRef} data-workspace-pane={paneId} data-drop={drop ?? undefined} />;
}

/** Persistent portal hosts keep drafts, editor controllers and terminal sessions alive during rearrangement. */
export function WorkspaceEditorSplit({ mode, children, editor, terminal, terminalPrimary = false,
  layout: customLayout, onLayoutChange, onOpenPane, disabled = false }: {
  mode: LayoutMode;
  children: ReactNode;
  editor: ReactNode;
  terminal?: ReactNode;
  terminalPrimary?: boolean;
  layout?: SplitLayoutNode | null;
  onLayoutChange?: (layout: SplitLayoutNode) => void;
  onOpenPane?: (pane: WorkspacePaneId) => void;
  disabled?: boolean;
}) {
  const dragSource = useRef<WorkspacePaneId | null>(null);
  const releaseDrag = useRef<(() => void) | null>(null);
  const endDrag = useCallback(() => {
    dragSource.current = null;
    releaseDrag.current?.();
    releaseDrag.current = null;
  }, []);
  useEffect(() => {
    document.addEventListener('dragend', endDrag);
    document.addEventListener('drop', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      document.removeEventListener('dragend', endDrag);
      document.removeEventListener('drop', endDrag);
      window.removeEventListener('blur', endDrag);
      endDrag();
    };
  }, [endDrag]);
  useEffect(() => { if (disabled) endDrag(); }, [disabled, endDrag]);
  const focusPane = useRef<WorkspacePaneId | null>(null);
  const detachedFocus = useRef<HTMLElement | null>(null);
  const onDetach = useCallback((element: HTMLElement) => { detachedFocus.current = element; }, []);
  const [hosts] = useState(() => ({ primary: document.createElement('div'), editor: document.createElement('div'), terminal: document.createElement('div') }));
  const [ratio, setRatio] = useState(.5);
  const [maximized, setMaximized] = useState<WorkspacePaneId | null>(null);
  const [preview, setPreview] = useState<{ target: HTMLElement; pane: WorkspacePaneId; direction: SplitPreviewDirection } | null>(null);
  const layout = customLayout ?? visibleWorkspaceLayout(mode, terminalPrimary, ratio);
  const ids = splitPaneIds(layout);
  const canMaximize = ids.length > 1;
  useEffect(() => { if (!canMaximize) setMaximized(null); }, [canMaximize]);
  const shownLayout = maximized && ids.includes(maximized) ? { type: 'pane' as const, paneId: maximized } : layout;
  useLayoutEffect(() => {
    for (const host of Object.values(hosts)) { host.className = styles.host ?? ''; host.tabIndex = -1; }
  }, [hosts]);
  useEffect(() => { if (mode === 'primary') setRatio(.5); }, [mode]);
  useEffect(() => { if (disabled) setPreview(null); }, [disabled]);
  const focusDestination = () => {
    const id = focusPane.current;
    if (!id) return;
    focusPane.current = null;
    hosts[id].ownerDocument.defaultView?.requestAnimationFrame(() => hosts[id].focus({ preventScroll: true }));
  };
  const move = (source: WorkspacePaneId, target: WorkspacePaneId, direction: SplitPaneDirection) => {
    if (disabled || !onLayoutChange || !ids.includes(source) || !ids.includes(target)) return;
    const next = placeWorkspacePane(layout, target, source, direction);
    if (next !== layout) { onLayoutChange?.(next); focusPane.current = source; focusDestination(); }
  };
  const controls = {
    startDrag: (pane: WorkspacePaneId) => {
      endDrag();
      dragSource.current = pane;
      // Native terminal surfaces must not intercept HTML drop targets.
      releaseDrag.current = beginSplitPreview();
    },
    split: (pane: WorkspacePaneId, direction: SplitPreviewDirection) => {
      if (disabled || !onLayoutChange) return;
      const target = hosts[pane];
      if (target) setPreview({ target, pane, direction });
    },
    maximize: (id: WorkspacePaneId) => {
      if (canMaximize) setMaximized(current => current === id ? null : id);
    },
    canMaximize,
    maximized,
  };
  useLayoutEffect(() => {
    const previous = detachedFocus.current;
    detachedFocus.current = null;
    if (!previous || document.activeElement !== document.body) return;
    const visible = splitPaneIds(shownLayout);
    const previousPane = Object.entries(hosts).find(([, host]) => host.contains(previous))?.[0];
    if (previousPane && visible.includes(previousPane)) previous.focus({ preventScroll: true });
    else hosts[visible[0] as WorkspacePaneId]?.focus({ preventScroll: true });
  });
  const contents = { primary: children, editor, terminal };
  const shownIds = splitPaneIds(shownLayout);
  return <WorkspaceLayoutContext.Provider value={onLayoutChange && !disabled ? controls : null}>
    <div className={styles.root}>
      <SplitPaneLayout layout={shownLayout} resizeLabel="Resize workspace panes"
        onResizeSplit={(id, value) => {
          if (onLayoutChange) onLayoutChange(resizeSplitPane(layout, id, value));
          else setRatio(value);
        }} renderPane={id => <PaneHost host={hosts[id as WorkspacePaneId]} paneId={id as WorkspacePaneId} onMove={move} onDetach={onDetach} dragSource={dragSource} />} />
      <div hidden>{Object.entries(hosts).filter(([id]) => !shownIds.includes(id)).map(([id, host]) =>
        <PaneHost key={id} host={host} paneId={id as WorkspacePaneId} onMove={move} onDetach={onDetach} dragSource={dragSource} />)}</div>
      {Object.entries(contents).map(([id, content]) => createPortal(
        <WorkspacePaneContext.Provider value={id as WorkspacePaneId}><WorkspacePaneVisibilityContext.Provider value={shownIds.includes(id)}>{content}</WorkspacePaneVisibilityContext.Provider></WorkspacePaneContext.Provider>, hosts[id as WorkspacePaneId], `workspace-${id}`))}
    </div>
    {preview && <SplitPreview target={preview.target} direction={preview.direction}
      title={preview.direction === 'right' ? 'Split right' : 'Split down'} onClose={() => setPreview(null)} onCommitted={focusDestination}
      choices={[
        { id: 'editor', label: 'Editor', icon: <FileCode2 aria-hidden="true" /> },
        { id: 'primary', label: 'Codex', icon: <MessageSquare aria-hidden="true" /> },
        { id: 'terminal', label: 'Terminal', icon: <SquareTerminal aria-hidden="true" /> },
      ].map(choice => ({ ...choice,
        description: ids.includes(choice.id) ? 'Move this area here' : 'Open this area',
        disabledReason: preview.pane === choice.id || (ids.length === 1 && ids[0] === choice.id)
          ? 'Already in this area. Use its session split controls to add another session.' : undefined,
      }))} onChoose={id => {
        const pane = id as WorkspacePaneId;
        const next = placeWorkspacePane(layout, preview.pane, pane, preview.direction);
        if (next === layout) return false;
        focusPane.current = pane;
        setMaximized(null);
        onLayoutChange?.(next);
        onOpenPane?.(pane);
        return true;
      }} />}
  </WorkspaceLayoutContext.Provider>;
}
