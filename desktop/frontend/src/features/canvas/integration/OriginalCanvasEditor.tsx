import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasLibraryListing, CanvasRestoreRequest } from '../../../../../shared/canvas';
import { isCanvasOverlayList, type CanvasRectangle } from '../../../../../shared/canvas-layout';
import { cheshiDesktop } from '../../../cheshiDesktop';
import { Modal, NeumorphicButton, NeumorphicTextField } from '../../../shared/ui';
import { StatusToast, type StatusToastMessage } from '../../../shared/ui/StatusToast';
import { useHelpLanguage } from '../../../shared/useHelpLanguage';
import { canvasErrorNotification } from './sdk/canvasNotifications';
import styles from './OriginalCanvasEditor.module.css';
import { CanvasSidebar } from '../CanvasSidebar';
import { CanvasEmptyState } from '../CanvasEmptyState';
import { CanvasCloseDialog, type CanvasCloseChoice } from '../CanvasCloseDialog';
import { useCanvasDock } from './useCanvasDock';

const channel = 'cheshi:open-pencil:v1';
const editorURL = new URL('open-pencil/index.html', document.baseURI).href;
type Pending = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export function OriginalCanvasEditor({ active, target, sidebarTarget, onOpenFile, onDirtyChange }: {
  active: boolean;
  target: { path: string; requestId: number } | null;
  sidebarTarget: HTMLDivElement | null;
  onOpenFile(path: string): void;
  onDirtyChange(dirty: boolean): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const [frameHost, setFrameHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setFrameHost(workspace.current?.closest<HTMLElement>('.app-layout') ?? document.body);
  }, []);
  const [layersTarget, setLayersTarget] = useState<HTMLDivElement | null>(null);
  const [overlays, setOverlays] = useState<CanvasRectangle[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [hasDocument, setHasDocument] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [refresh, setRefresh] = useState(0);
  const operationPending = useRef(false);
  const [notification, setNotification] = useState<StatusToastMessage | null>(null);
  const [savePath, setSavePath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [createName, setCreateName] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingPath = useRef<string | null>(null);
  const savePicker = useRef<((path: string | null) => void) | null>(null);
  const [closeDocumentName, setCloseDocumentName] = useState<string | null>(null);
  const closePicker = useRef<((choice: CanvasCloseChoice) => void) | null>(null);
  const revisions = useRef(new Map<string, string>());
  const relocationAttempts = useRef(new Map<string, string>());
  const pending = useRef(new Map<number, Pending>());
  const sequence = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const handledTarget = useRef<number | null>(null);
  const [language] = useHelpLanguage();
  const languageRef = useRef(language);
  languageRef.current = language;
  const api = cheshiDesktop?.canvas;
  const report = useCallback((reason: unknown) => {
    setNotification({ ...canvasErrorNotification(reason, 'edit', languageRef.current), id: ++sequence.current });
  }, []);
  const post = useCallback((message: object) => {
    frame.current?.contentWindow?.postMessage({ channel, ...message }, location.origin === 'null' ? '*' : location.origin);
  }, []);
  useCanvasDock(frame, workspace, layersTarget, active && hasDocument, ready, overlays, post);
  const command = useCallback((method: string, payload?: unknown) => new Promise<void>((resolve, reject) => {
    const id = ++sequence.current;
    const timer = setTimeout(() => { pending.current.delete(id); reject(new Error('Canvas operation timed out.')); }, 120_000);
    pending.current.set(id, { resolve, reject, timer });
    post({ type: 'command', id, method, payload });
  }), [post]);
  const open = useCallback(async (next: string) => {
    if (!api) throw new Error('Canvas file service is unavailable.');
    const document = await api.read(next);
    const previouslyLoaded = revisions.current.get(document.path);
    await command('open', document);
    revisions.current.set(document.path, previouslyLoaded ?? document.revision);
    await api.rememberDocument(document.path);
  }, [api, command]);
  const perform = useCallback(async (operation: () => Promise<void>) => {
    if (operationPending.current) throw new Error('Wait for the current canvas operation to finish.');
    operationPending.current = true;
    setBusy(true);
    try { await operation(); }
    finally { operationPending.current = false; setBusy(false); setRefresh(value => value + 1); }
  }, []);
  const run = useCallback(async (operation: () => Promise<void>) => {
    try { await perform(operation); } catch (error) { report(error); }
  }, [perform, report]);
  const reconcilePaths = useCallback(async (listing: CanvasLibraryListing, selectedPath: string) => {
    if (listing.truncated) return selectedPath;
    let next = selectedPath;
    for (const move of listing.relocations ?? []) {
      const revision = revisions.current.get(move.previousPath);
      if (revision === undefined || revisions.current.has(move.path)) continue;
      await command('renamed', move);
      revisions.current.delete(move.previousPath);
      revisions.current.set(move.path, revision);
      if (next === move.previousPath) {
        next = move.path;
        setCurrentPath(next);
        await api?.rememberDocument(next);
      }
    }
    return next;
  }, [api, command]);
  const onListing = useCallback((listing: CanvasLibraryListing) => {
    if (!ready || listing.truncated || operationPending.current || saving || closePicker.current) return;
    const moves = (listing.relocations ?? []).filter(move => revisions.current.has(move.previousPath)
      && !revisions.current.has(move.path) && relocationAttempts.current.get(move.previousPath) !== move.path);
    if (!moves.length) return;
    // A rejected bridge command must not create a list -> rename -> list retry loop.
    // The refresh button remains an explicit retry, including for a failed move.
    for (const move of moves) relocationAttempts.current.set(move.previousPath, move.path);
    while (relocationAttempts.current.size > 1000) relocationAttempts.current.delete(relocationAttempts.current.keys().next().value!);
    void run(async () => { await reconcilePaths({ ...listing, relocations: moves }, currentPath); });
  }, [ready, saving, currentPath, reconcilePaths, run]);
  const refreshDocument = useCallback(() => run(async () => {
    if (!api || !currentPath || !hasDocument) return;
    const next = await reconcilePaths(await api.list(), currentPath);
    const document = await api.read(next);
    if (document.revision === revisions.current.get(document.path)) return;
    await command('refresh', document);
    revisions.current.set(document.path, document.revision);
  }), [api, command, currentPath, hasDocument, reconcilePaths, run]);
  const restore = useCallback(async (request: CanvasRestoreRequest) => {
    await perform(async () => {
      if (!api) throw new Error('Canvas file service is unavailable.');
      await command('assert-clean');
      const restored = await api.restore(request);
      await command('reload', restored);
      revisions.current.set(restored.path, restored.revision);
      await api.rememberDocument(restored.path);
    });
  }, [api, command, perform]);
  const rename = useCallback(async (path: string, name: string) => {
    await perform(async () => {
      if (!api) throw new Error('Canvas file service is unavailable.');
      await command('deactivate');
      const result = await api.rename({ path, name, expectedRevision: revisions.current.get(path) });
      revisions.current.delete(result.previousPath);
      revisions.current.set(result.path, result.revision);
      await command('renamed', result);
    });
  }, [api, command, perform]);
  useEffect(() => { if (ready) post({ type: 'host-state', payload: { busy: busy || saving, revision: refresh } }); }, [ready, busy, saving, refresh, post]);
  useEffect(() => cheshiDesktop?.onWorkspaceFilesChanged(event => {
    if (event.overflow || event.paths.some(path => path.endsWith('.fig'))) setRefresh(value => value + 1);
  }), []);

  useEffect(() => {
    async function receive(event: MessageEvent) {
      const sameOrigin = location.protocol === 'file:'
        ? event.origin === 'null' || event.origin === 'file://'
        : event.origin === location.origin;
      if (event.source !== frame.current?.contentWindow || !sameOrigin || event.data?.channel !== channel) return;
      const message = event.data;
      if (message.type === 'overlays') {
        if (isCanvasOverlayList(message.payload)) setOverlays(message.payload);
        return;
      }
      if (message.type === 'ready') { setReady(true); return; }
      if (message.type === 'state') {
        const state = message.payload;
        if (!state || typeof state.dirty !== 'boolean' || typeof state.path !== 'string' || typeof state.name !== 'string'
          || typeof state.hasDocument !== 'boolean') return;
        setDirty(state.dirty); setCurrentPath(state.path); setHasDocument(state.hasDocument);
        if (Array.isArray(state.paths)) for (const key of revisions.current.keys()) {
          if (!state.paths.includes(key)) revisions.current.delete(key);
        }
        return;
      }
      if (message.type === 'result') {
        const entry = pending.current.get(message.id);
        if (!entry) return;
        pending.current.delete(message.id); clearTimeout(entry.timer);
        if (typeof message.error === 'string') entry.reject(new Error(message.error)); else entry.resolve();
        return;
      }
      if (message.type !== 'request' || !Number.isSafeInteger(message.id)) return;
      try {
        if (!api) throw new Error('Canvas file service is unavailable.');
        let payload: unknown;
        if (message.method === 'confirm-close') {
          if (closePicker.current) throw new Error('A close confirmation is already open.');
          const documentName = message.payload?.documentName;
          if (typeof documentName !== 'string') throw new Error('Invalid canvas document name.');
          payload = await new Promise<CanvasCloseChoice>(resolve => {
            closePicker.current = resolve; setCloseDocumentName(documentName);
          });
        } else if (message.method === 'save-path') {
          if (savePicker.current) throw new Error('A save dialog is already open.');
          const suggested = message.payload?.suggested;
          if (typeof suggested !== 'string') throw new Error('Invalid file path.');
          const listing = await api.list();
          if (listing.canvasRoot === null && await api.chooseRoot() === null) payload = null;
          else payload = await new Promise<string | null>(resolve => {
            savePicker.current = resolve; setSaveError(null); setSavePath(suggested.split('/').at(-1)!.replace(/\.fig$/i, ''));
          });
        } else if (message.method === 'save') {
          const { path: next, data } = message.payload ?? {};
          if (typeof next !== 'string' || !(data instanceof Uint8Array) || data.byteLength > 64 * 1024 * 1024) throw new Error('Invalid Canvas save request.');
          setSaving(true);
          payload = await api.save({ path: next, data, expectedRevision: creatingPath.current === next ? null : revisions.current.get(next) ?? null });
          const saved = payload as { path: string; revision: string };
          revisions.current.set(saved.path, saved.revision);
          setRefresh(value => value + 1);
          await api.rememberDocument(saved.path);
        } else if (message.method === 'history') payload = await api.history(message.payload?.path);
        else if (message.method === 'read-version') payload = await api.readVersion(message.payload?.path, message.payload?.id);
        else if (message.method === 'restore-version') await restore(message.payload);
        else throw new Error('Unknown Canvas host request.');
        post({ type: 'response', id: message.id, payload });
      } catch (error) {
        report(error);
        post({ type: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (message.method === 'save') setSaving(false);
      }
    }
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      savePicker.current?.(null); savePicker.current = null;
      closePicker.current?.('cancel'); closePicker.current = null;
      for (const entry of pending.current.values()) { clearTimeout(entry.timer); entry.reject(new Error('Canvas closed.')); }
      pending.current.clear();
    };
  }, [api, post, report, restore]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void run(async () => {
      const remembered = targetRef.current ? null : await api?.lastDocument();
      if (cancelled) return;
      const request = targetRef.current;
      if (request) handledTarget.current = request.requestId;
      const next = request?.path ?? remembered;
      if (next) await open(next);
    });
    return () => { cancelled = true; };
  }, [ready, api, open, run]);
  useEffect(() => {
    if (!ready || busy || !target || handledTarget.current === target.requestId) return;
    handledTarget.current = target.requestId;
    void run(() => open(target.path));
  }, [ready, busy, target, run, open]);
  useEffect(() => { onDirtyChange(dirty || busy || saving); }, [dirty, busy, saving, onDirtyChange]);
  useEffect(() => {
    if (!ready || active) return;
    void command('deactivate').catch(report);
  }, [active, ready, command, report]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty || busy || saving) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy, saving]);
  function finishPicker(value: string | null) {
    const resolve = savePicker.current;
    savePicker.current = null; setSavePath(null); resolve?.(value);
  }
  function finishClose(choice: CanvasCloseChoice) {
    const resolve = closePicker.current;
    closePicker.current = null; setCloseDocumentName(null); resolve?.(choice);
  }
  async function saveNamedCanvas() {
    try { if (api && savePath?.trim()) finishPicker(await api.newPath(savePath)); }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
  }
  async function beginCreate() {
    await run(async () => {
      if (!api) throw new Error('Canvas file service is unavailable.');
      const listing = await api.list();
      if (listing.canvasRoot === null && await api.chooseRoot() === null) return;
      setCreateError(null); setCreateName('New canvas');
    });
  }
  async function createNamedCanvas() {
    if (!api || !createName?.trim() || operationPending.current) return;
    setCreateError(null);
    try {
      await perform(async () => {
        const next = await api.newPath(createName);
        creatingPath.current = next;
        try { await command('create', { path: next }); }
        finally { creatingPath.current = null; }
        setCreateName(null);
        onOpenFile(next);
      });
    } catch (error) { setCreateError(error instanceof Error ? error.message : String(error)); }
  }
  const isCreating = createName !== null;
  const dialogName = createName ?? savePath;
  const dialogError = isCreating ? createError : saveError;
  const closeNameDialog = () => { if (isCreating) setCreateName(null); else finishPicker(null); };

  return <><section ref={workspace} className={styles.workspace} hidden={!active} inert={!active} aria-label="Canvas">
    {!hasDocument && <CanvasEmptyState active={active} />}
    {notification && <StatusToast message={notification} onDismiss={() => setNotification(null)} />}
    {closeDocumentName !== null && <CanvasCloseDialog documentName={closeDocumentName} onChoose={finishClose} />}
    {dialogName !== null && <Modal title={isCreating ? 'New Canvas' : 'Save Canvas'} headerVariant="section" closeButtonVariant="ghost"
      closeDisabled={isCreating && busy} onClose={closeNameDialog}>
      <form className={styles.saveForm} onSubmit={event => { event.preventDefault(); void (isCreating ? createNamedCanvas() : saveNamedCanvas()); }}>
        <label>File name<NeumorphicTextField variant="standard" autoFocus aria-label={isCreating ? 'New Canvas file name' : 'Save Canvas file name'}
          disabled={isCreating && busy} value={dialogName} onChange={event => {
            if (isCreating) { setCreateName(event.target.value); setCreateError(null); }
            else { setSavePath(event.target.value); setSaveError(null); }
          }} /></label>
        {dialogError && <p role="alert">{dialogError}</p>}
        <div className={styles.actions}><NeumorphicButton variant="ghost" type="button" disabled={isCreating && busy} onClick={closeNameDialog}>Cancel</NeumorphicButton>
          <NeumorphicButton variant="standard" type="submit" disabled={!dialogName.trim() || (isCreating && busy)}>{isCreating ? 'Create' : 'Save'}</NeumorphicButton></div>
      </form>
    </Modal>}
  </section>{frameHost && createPortal(<iframe ref={frame} className={styles.editor} aria-hidden={!active || !hasDocument}
    inert={!active || !hasDocument || busy || saving || closeDocumentName !== null} title="OpenPencil editor" src={editorURL}
    allow="clipboard-read; clipboard-write; local-fonts" />, frameHost)}
  {sidebarTarget && api && createPortal(<CanvasSidebar api={api} currentPath={currentPath}
    layers={active && hasDocument
      ? <div ref={setLayersTarget} className={styles.layers} data-canvas-layers aria-label="Canvas pages and layers" />
      : undefined}
    busy={busy || saving || closeDocumentName !== null} ready={ready} canSave={hasDocument} refresh={refresh}
    onOpen={onOpenFile} onSave={() => void run(() => command('save'))} onCreate={() => void beginCreate()}
    onRefresh={() => void refreshDocument()}
    onRename={rename} onError={report} onListing={onListing} />, sidebarTarget)}</>;
}
