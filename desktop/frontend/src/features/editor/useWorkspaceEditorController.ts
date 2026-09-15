import {
  findNext,
  findPrevious,
  replaceAll as replaceAllSearchMatches,
  replaceNext as replaceNextSearchMatch,
  selectMatches,
} from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useEditorSession } from './useEditorSession';
import type { EditorSessionMode } from '../../../../shared/editor-session';
import { useEditorUpdateResume } from './useEditorUpdateResume';
import { errorMessage as toErrorMessage } from '../../shared/errorMessage';
import { isWorkspacePathAtOrBelow, renameWorkspacePathPrefix } from '../../shared/workspacePaths';
import {
  cheshiDesktop as workspace,
  type LanguageServerCodeAction,
  type LanguageServerLocation,
  type LanguageServerPosition,
  type LanguageServerWorkspaceEdit,
  type WorkspaceEntryMutation,
  type WorkspaceFileExcerptResult,
  type WorkspaceFileReadResult,
  type WorkspaceFileVersion,
  type WorkspaceFileWriteResult,
  type WorkspaceFilesWriteResult,
} from '../../cheshiDesktop';
import { useCodeEditorSearch } from './codeEditorSearch';
import {
  languageServerLanguageForPath,
  normalizeLanguageServerRenameResult,
} from './languageServerDiagnostics';
import type { WorkspaceEditorAssistState } from './WorkspaceEditorAssistPanel';
import { DEFAULT_WORKSPACE_PROBLEMS_RATIO } from './WorkspaceProblemsResizer';
import {
  assertLanguageServerValue,
  assertSourceExcerptReaderAvailable,
  assertWorkspaceEditPreviewCurrent,
  assertWorkspaceFilesWritten,
  isTabDirty,
  languageServerPositionAt,
  MAX_NAVIGATION_HISTORY,
  requireLanguageServerRenameEdit,
  sameNavigationLocation,
  SOURCE_EXCERPT_CONTEXT_LINES,
  type NavigationLocation,
  type PreparedWorkspaceEdit,
  type PreparedWorkspaceEditFile,
  type WorkspaceTab,
} from './workspaceEditorModel';
import { applyLanguageServerTextEdits } from './workspaceTextEdits';
import { confirmWorkspaceTabsClose } from './workspaceTabClose';
import { applyWorkspaceFileSaveResult, canSaveWorkspaceTab } from './workspaceFileSave';
import {
  canApplyWorkspaceFileLoad,
  createWorkspaceFileLoadTracker,
  normalizeWorkspaceEditorContent,
} from './workspaceFileLoad';
import { useWorkspaceCodeEditor } from './useWorkspaceCodeEditor';
import { useWorkspaceCodeExplanation } from './useWorkspaceCodeExplanation';
import { useWorkspaceLanguageServer } from './useWorkspaceLanguageServer';

export interface WorkspaceEditorTarget {
  path: string;
  line?: number | null;
  requestId: number;
}

export type WorkspaceEditorMutation = WorkspaceEntryMutation & { requestId: number };

interface UseWorkspaceEditorControllerOptions {
  sessionMode?: EditorSessionMode;
  onSessionRestored?: () => void;
  active: boolean;
  mutation: WorkspaceEditorMutation | null;
  target: WorkspaceEditorTarget | null;
  onAllTabsClosed: () => void;
  onSelectedPathChange: (path: string | null) => void;
}

export function useWorkspaceEditorController({
  sessionMode = 'restore',
  onSessionRestored,
  active,
  mutation,
  target,
  onAllTabsClosed,
  onSelectedPathChange,
}: UseWorkspaceEditorControllerOptions) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [problemsOpen, setProblemsOpen] = useState(true);
  const [problemsRatio, setProblemsRatio] = useState(DEFAULT_WORKSPACE_PROBLEMS_RATIO);
  const [assistState, setAssistState] = useState<WorkspaceEditorAssistState | null>(null);
  const [navigationAvailability, setNavigationAvailability] = useState({ back: false, forward: false });
  const editorHostRef = useRef<HTMLDivElement>(null);
  const assistStateRef = useRef(assistState);
  const editorViewRef = useRef<EditorView | null>(null);
  const editorPathRef = useRef<string | null>(null);
  const referencePreviewRequestSequence = useRef(0);
  const pendingLineRef = useRef<number | null>(null);
  const pendingCharacterRef = useRef<number | null>(null);
  const navigationBackRef = useRef<NavigationLocation[]>([]);
  const navigationForwardRef = useRef<NavigationLocation[]>([]);
  const pendingRenameRef = useRef<{ path: string; position: LanguageServerPosition } | null>(null);
  const preparedWorkspaceEditRef = useRef<PreparedWorkspaceEdit | null>(null);
  const loadFileRef = useRef<(
    relativePath: string,
    lineNumber?: number | null,
    forceReload?: boolean,
    character?: number | null,
  ) => Promise<void>>(async () => undefined);
  const fileLoadTracker = useMemo(createWorkspaceFileLoadTracker, []);
  const nextTabGeneration = useRef(0);
  const tabsRef = useRef(tabs);
  const selectedPathRef = useRef(selectedPath);
  tabsRef.current = tabs;
  selectedPathRef.current = selectedPath;
  assistStateRef.current = assistState;

  const {
    editorSearchOpen,
    editorSearchControls,
    editorSearchInputRef,
    editorSearchQueryValid,
    updateEditorSearchControls,
    openEditorSearch,
    closeEditorSearch,
    runEditorSearchCommand,
    syncEditorSearchPanel,
  } = useCodeEditorSearch(editorViewRef);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === selectedPath) ?? null,
    [selectedPath, tabs],
  );
  const currentFile = activeTab?.file ?? null;
  const codeExplanation = useWorkspaceCodeExplanation({
    active,
    path: selectedPath,
    firstLine: activeTab?.sourceExcerpt?.startLine ?? 1,
    editorViewRef,
  });
  const activeLanguageServerLanguage = currentFile ? languageServerLanguageForPath(currentFile.path) : null;
  const problemsVisible = problemsOpen && currentFile?.fileKind === 'text';
  const isDirty = activeTab ? isTabDirty(activeTab) : false;
  const conflictMessage = activeTab?.conflictMessage ?? '';

  const invalidatePendingFileLoad = useCallback((): void => {
    fileLoadTracker.invalidate();
    setLoading(false);
  }, [fileLoadTracker]);

  const toggleEditorSearch = (): void => {
    if (editorSearchOpen) {
      closeEditorSearch();
      return;
    }
    const view = editorViewRef.current;
    if (view) openEditorSearch(view);
  };

  const selectPath = useCallback((path: string | null): void => {
    if (path !== selectedPathRef.current) {
      referencePreviewRequestSequence.current += 1;
      pendingRenameRef.current = null;
      preparedWorkspaceEditRef.current = null;
      setAssistState(null);
    }
    selectedPathRef.current = path;
    setSelectedPath(path);
  }, []);

  const replaceTabs = useCallback((update: (current: WorkspaceTab[]) => WorkspaceTab[]): void => {
    setTabs((current) => {
      const next = update(current);
      tabsRef.current = next;
      return next;
    });
  }, []);

  const sessionReady = useEditorSession({ mode: sessionMode, tabs, selectedPath, nextTabGeneration,
    replaceTabs, selectPath, onSessionRestored: () => onSessionRestored?.(), onError: setErrorMessage });

  const updateDraftsPreserved = useEditorUpdateResume({
    tabsRef, selectedPathRef, nextTabGeneration, savingRef, loading: loading || !sessionReady,
    applyingEdit: assistState?.kind === 'edit-preview' && assistState.applying,
    problemsOpen, problemsRatio, replaceTabs, selectPath, setProblemsOpen, setProblemsRatio,
  });

  const updateTab = useCallback((path: string, update: (tab: WorkspaceTab) => WorkspaceTab): void => {
    replaceTabs((current) => current.map((tab) => tab.path === path ? update(tab) : tab));
  }, [replaceTabs]);

  const syncNavigationAvailability = useCallback((): void => {
    setNavigationAvailability({
      back: navigationBackRef.current.length > 0,
      forward: navigationForwardRef.current.length > 0,
    });
  }, []);

  const currentNavigationLocation = useCallback((): NavigationLocation | null => {
    const path = selectedPathRef.current;
    const view = editorViewRef.current;
    if (!path || !view) return null;
    const position = languageServerPositionAt(view, view.state.selection.main.head);
    const tab = tabsRef.current.find((candidate) => candidate.path === path);
    return {
      path,
      line: (tab?.sourceExcerpt?.startLine ?? 1) + position.line,
      character: position.character,
    };
  }, []);

  const recordNavigationOrigin = useCallback((): void => {
    const location = currentNavigationLocation();
    if (!location) return;
    const previous = navigationBackRef.current.at(-1) ?? null;
    if (!sameNavigationLocation(previous, location)) {
      navigationBackRef.current.push(location);
      if (navigationBackRef.current.length > MAX_NAVIGATION_HISTORY) navigationBackRef.current.shift();
    }
    navigationForwardRef.current = [];
    syncNavigationAvailability();
  }, [currentNavigationLocation, syncNavigationAvailability]);

  const activateOpenTab = useCallback((path: string): void => {
    if (!tabsRef.current.some((tab) => tab.path === path)) return;
    invalidatePendingFileLoad();
    if (path === selectedPathRef.current) return;
    recordNavigationOrigin();
    pendingLineRef.current = null;
    pendingCharacterRef.current = null;
    selectPath(path);
  }, [invalidatePendingFileLoad, recordNavigationOrigin, selectPath]);

  const navigateHistory = useCallback(async (direction: 'back' | 'forward'): Promise<void> => {
    const source = direction === 'back' ? navigationBackRef.current : navigationForwardRef.current;
    const destination = direction === 'back' ? navigationForwardRef.current : navigationBackRef.current;
    let targetLocation = source.pop() ?? null;
    const current = currentNavigationLocation();
    while (targetLocation && sameNavigationLocation(targetLocation, current)) {
      targetLocation = source.pop() ?? null;
    }
    if (!targetLocation) {
      syncNavigationAvailability();
      return;
    }
    if (current && !sameNavigationLocation(destination.at(-1) ?? null, current)) {
      destination.push(current);
      if (destination.length > MAX_NAVIGATION_HISTORY) destination.shift();
    }
    syncNavigationAvailability();
    await loadFileRef.current(
      targetLocation.path,
      targetLocation.line,
      false,
      targetLocation.character,
    );
  }, [currentNavigationLocation, syncNavigationAvailability]);

  const languageServer = useWorkspaceLanguageServer({
    activeLanguageServerLanguage,
    editorPathRef,
    editorViewRef,
    loadFileRef,
    pendingRenameRef,
    recordNavigationOrigin,
    referencePreviewRequestSequence,
    setAssistState,
    setErrorMessage,
  });
  const {
    configureActiveLanguageServer,
    diagnostics,
    diagnosticsStatus,
    languageServerConfiguring,
    languageServers,
    loadReferencePreview,
    nextLanguageServerDocumentVersion,
    requestLanguageServerCodeActions,
    requestLanguageServerReferences,
    requestLanguageServerRename,
    resetLanguageServerRequests,
  } = languageServer;
  const activeLanguageServer = activeLanguageServerLanguage
    ? languageServers.find((status) => status.language === activeLanguageServerLanguage) ?? null
    : null;

  const {
    closeTabRef,
    createEditor,
    createSourceExcerptViewer,
    destroyEditor,
    revealDiagnostic,
    revealLine,
    saveFileRef,
  } = useWorkspaceCodeEditor({
    activateOpenTab,
    assistStateRef,
    editorHostRef,
    editorPathRef,
    editorViewRef,
    languageServer,
    navigateHistory,
    openEditorSearch,
    recordNavigationOrigin,
    setAssistState,
    syncEditorSearchPanel,
    tabsRef,
    updateTab,
  });

  useEffect(() => {
    if (!active || !activeTab || (activeTab.file.fileKind !== 'text' && !activeTab.sourceExcerpt)) {
      destroyEditor();
      return;
    }
    const lineNumber = pendingLineRef.current;
    const character = pendingCharacterRef.current;
    pendingLineRef.current = null;
    pendingCharacterRef.current = null;
    const frame = requestAnimationFrame(() => {
      if (activeTab.file.fileKind === 'text') {
        createEditor(activeTab, lineNumber, character);
      } else {
        createSourceExcerptViewer(activeTab, lineNumber, character);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    active,
    activeTab?.loadGeneration,
    activeTab?.path,
    createEditor,
    createSourceExcerptViewer,
    destroyEditor,
  ]);

  const activateTab = useCallback((
    path: string,
    lineNumber?: number | null,
    character?: number | null,
  ): void => {
    const tab = tabsRef.current.find((candidate) => candidate.path === path);
    if (!tab) return;
    if (path === selectedPathRef.current) {
      const displayedLine = lineNumber && tab.sourceExcerpt
        ? lineNumber - tab.sourceExcerpt.startLine + 1
        : lineNumber;
      revealLine(displayedLine, character ?? 0);
      return;
    }
    pendingLineRef.current = lineNumber ?? null;
    pendingCharacterRef.current = character ?? null;
    selectPath(path);
  }, [revealLine, selectPath]);

  const closeTab = useCallback((path: string | null): void => {
    if (!path) return;
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.path === path);
    const tab = current[index];
    if (!tab) return;
    if (!confirmWorkspaceTabsClose([tab], isTabDirty, (dirtyPath) => window.confirm(`Discard unsaved changes in ${dirtyPath}?`))) return;
    invalidatePendingFileLoad();
    const nextTabs = current.filter((candidate) => candidate.path !== path);
    replaceTabs(() => nextTabs);
    if (nextTabs.length === 0) {
      pendingLineRef.current = null;
      pendingCharacterRef.current = null;
      selectPath(null);
      if (active) onAllTabsClosed();
      return;
    }
    if (selectedPathRef.current !== path) return;
    const nextTab = nextTabs[index] ?? nextTabs[index - 1] ?? null;
    pendingLineRef.current = null;
    pendingCharacterRef.current = null;
    selectPath(nextTab?.path ?? null);
  }, [active, invalidatePendingFileLoad, onAllTabsClosed, replaceTabs, selectPath]);
  closeTabRef.current = closeTab;

  const closeAllTabs = useCallback((): void => {
    const current = tabsRef.current;
    if (current.length === 0) return;
    if (!confirmWorkspaceTabsClose(current, isTabDirty, (path) => window.confirm(`Discard unsaved changes in ${path}?`))) return;
    invalidatePendingFileLoad();
    replaceTabs(() => []);
    pendingLineRef.current = null;
    pendingCharacterRef.current = null;
    selectPath(null);
    if (active) onAllTabsClosed();
  }, [active, invalidatePendingFileLoad, onAllTabsClosed, replaceTabs, selectPath]);

  const copyTabFullPath = useCallback(async (path: string): Promise<void> => {
    if (!workspace?.copyWorkspaceEntryFullPath) {
      setErrorMessage('Electron Workspace clipboard API is unavailable.');
      return;
    }
    try {
      await workspace.copyWorkspaceEntryFullPath(path);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!mutation) return;
    invalidatePendingFileLoad();
    const currentTabs = tabsRef.current;

    if (mutation.type === 'renamed' || mutation.type === 'moved') {
      const rewriteHistory = (locations: NavigationLocation[]): NavigationLocation[] => locations.map((location) => (
        isWorkspacePathAtOrBelow(location.path, mutation.previousPath)
          ? {
              ...location,
              path: renameWorkspacePathPrefix(location.path, mutation.previousPath, mutation.path),
            }
          : location
      ));
      navigationBackRef.current = rewriteHistory(navigationBackRef.current);
      navigationForwardRef.current = rewriteHistory(navigationForwardRef.current);
      syncNavigationAvailability();
      if (!currentTabs.some((tab) => isWorkspacePathAtOrBelow(tab.path, mutation.previousPath))) return;
      if (editorPathRef.current && isWorkspacePathAtOrBelow(editorPathRef.current, mutation.previousPath)) {
        destroyEditor(false);
      }
      const nextTabs = currentTabs.map((tab) => {
        if (!isWorkspacePathAtOrBelow(tab.path, mutation.previousPath)) return tab;
        const nextPath = renameWorkspacePathPrefix(tab.path, mutation.previousPath, mutation.path);
        return {
          ...tab,
          path: nextPath,
          file: {
            ...tab.file,
            path: nextPath,
            name: nextPath.split('/').at(-1) ?? nextPath,
          },
          sourceExcerpt: tab.sourceExcerpt ? {
            ...tab.sourceExcerpt,
            file: {
              ...tab.sourceExcerpt.file,
              path: nextPath,
              name: nextPath.split('/').at(-1) ?? nextPath,
            },
          } : null,
          loadGeneration: ++nextTabGeneration.current,
          editorState: undefined,
        };
      });
      replaceTabs(() => nextTabs);
      const currentSelectedPath = selectedPathRef.current;
      if (currentSelectedPath && isWorkspacePathAtOrBelow(currentSelectedPath, mutation.previousPath)) {
        pendingLineRef.current = null;
        pendingCharacterRef.current = null;
        selectPath(renameWorkspacePathPrefix(currentSelectedPath, mutation.previousPath, mutation.path));
      }
      return;
    }

    const selectedIndex = currentTabs.findIndex((tab) => tab.path === selectedPathRef.current);
    navigationBackRef.current = navigationBackRef.current.filter(
      (location) => !isWorkspacePathAtOrBelow(location.path, mutation.path),
    );
    navigationForwardRef.current = navigationForwardRef.current.filter(
      (location) => !isWorkspacePathAtOrBelow(location.path, mutation.path),
    );
    syncNavigationAvailability();
    const affectedTabs = currentTabs.filter((tab) => isWorkspacePathAtOrBelow(tab.path, mutation.path));
    if (affectedTabs.length === 0) return;
    if (editorPathRef.current && isWorkspacePathAtOrBelow(editorPathRef.current, mutation.path)) {
      destroyEditor(false);
    }
    const nextTabs = currentTabs.filter((tab) => !isWorkspacePathAtOrBelow(tab.path, mutation.path));
    replaceTabs(() => nextTabs);
    if (nextTabs.length === 0) {
      pendingLineRef.current = null;
      pendingCharacterRef.current = null;
      selectPath(null);
      onAllTabsClosed();
      return;
    }
    if (selectedPathRef.current && isWorkspacePathAtOrBelow(selectedPathRef.current, mutation.path)) {
      const nextTab = nextTabs[Math.min(Math.max(selectedIndex, 0), nextTabs.length - 1)];
      pendingLineRef.current = null;
      pendingCharacterRef.current = null;
      selectPath(nextTab?.path ?? null);
    }
  }, [
    active,
    destroyEditor,
    invalidatePendingFileLoad,
    mutation,
    onAllTabsClosed,
    replaceTabs,
    selectPath,
    syncNavigationAvailability,
  ]);

  const loadFile = useCallback(async (
    relativePath: string,
    lineNumber?: number | null,
    forceReload = false,
    character?: number | null,
  ): Promise<void> => {
    invalidatePendingFileLoad();
    const existing = tabsRef.current.find((tab) => tab.path === relativePath);
    const requestedLine = lineNumber ?? (forceReload ? existing?.sourceExcerpt?.targetLine ?? null : null);
    const existingExcerpt = existing?.sourceExcerpt;
    const needsSourceExcerpt = Boolean(
      requestedLine
      && existing?.file.fileKind === 'too_large'
      && (
        !existingExcerpt
        || requestedLine < existingExcerpt.startLine
        || requestedLine > existingExcerpt.endLine
      ),
    );
    if (existing && !forceReload && !needsSourceExcerpt) {
      activateTab(relativePath, requestedLine, character);
      return;
    }
    if (!workspace?.readWorkspaceFile) {
      setErrorMessage('Electron Workspace API is unavailable.');
      return;
    }
    const sequence = fileLoadTracker.begin();
    setLoading(true);
    setErrorMessage('');
    try {
      const response: WorkspaceFileReadResult = await workspace.readWorkspaceFile(relativePath);
      if (!fileLoadTracker.isCurrent(sequence)) return;
      let sourceExcerpt: WorkspaceFileExcerptResult | null = null;
      if (response.file.fileKind === 'too_large' && requestedLine) {
        const readSourceExcerpt = workspace.readWorkspaceFileExcerpt;
        assertSourceExcerptReaderAvailable(readSourceExcerpt);
        sourceExcerpt = await readSourceExcerpt({
          path: relativePath,
          line: requestedLine,
          contextLines: SOURCE_EXCERPT_CONTEXT_LINES,
        });
        if (!fileLoadTracker.isCurrent(sequence)) return;
      }
      if (!canApplyWorkspaceFileLoad(existing, tabsRef.current.find((tab) => tab.path === relativePath))) return;
      const content = normalizeWorkspaceEditorContent(response.content ?? '');
      const nextTab: WorkspaceTab = {
        path: relativePath,
        file: sourceExcerpt?.file ?? response.file,
        previewDataUrl: response.dataUrl,
        sourceExcerpt,
        savedContent: content,
        draftContent: content,
        conflictMessage: null,
        loadGeneration: ++nextTabGeneration.current,
      };
      if (forceReload && relativePath === selectedPathRef.current) destroyEditor(false, false);
      replaceTabs((current) => {
        const index = current.findIndex((tab) => tab.path === relativePath);
        if (index < 0) return [...current, nextTab];
        const next = [...current];
        next[index] = nextTab;
        return next;
      });
      pendingLineRef.current = requestedLine;
      pendingCharacterRef.current = character ?? null;
      selectPath(relativePath);
    } catch (error) {
      if (fileLoadTracker.isCurrent(sequence)) setErrorMessage(toErrorMessage(error));
    } finally {
      if (fileLoadTracker.isCurrent(sequence)) setLoading(false);
    }
  }, [activateTab, destroyEditor, fileLoadTracker, invalidatePendingFileLoad, replaceTabs, selectPath]);
  loadFileRef.current = loadFile;

  const closeAssist = useCallback((): void => {
    referencePreviewRequestSequence.current += 1;
    preparedWorkspaceEditRef.current = null;
    pendingRenameRef.current = null;
    setAssistState(null);
    editorViewRef.current?.focus();
  }, []);

  const selectReference = useCallback((index: number): void => {
    const current = assistStateRef.current;
    if (current?.kind !== 'references') return;
    const location = current.locations[index];
    if (location) void loadReferencePreview(location, index);
  }, [loadReferencePreview]);

  const openReference = useCallback((location: LanguageServerLocation): void => {
    recordNavigationOrigin();
    closeAssist();
    void loadFileRef.current(
      location.path,
      location.range.start.line + 1,
      false,
      location.range.start.character,
    );
  }, [closeAssist, recordNavigationOrigin]);

  const prepareWorkspaceEdit = useCallback(async (
    title: string,
    edit: LanguageServerWorkspaceEdit,
  ): Promise<void> => {
    if (edit.files.length === 0) throw new Error('The language server returned an empty edit.');
    const files = await Promise.all(edit.files.map(async (editFile): Promise<PreparedWorkspaceEditFile> => {
      const openTab = tabsRef.current.find((tab) => tab.path === editFile.path);
      if (openTab && openTab.file.fileKind !== 'text') {
        throw new Error(`Only editable text files can be changed: ${editFile.path}`);
      }
      if (openTab && isTabDirty(openTab) && openTab.path !== selectedPathRef.current) {
        throw new Error(`Save or reload ${editFile.path} before applying a multi-file edit.`);
      }
      let file: WorkspaceFileVersion;
      let originalContent: string;
      if (openTab) {
        file = openTab.file;
        originalContent = openTab.draftContent;
      } else {
        const response = await workspace?.readWorkspaceFile?.(editFile.path);
        if (!response || response.file.fileKind !== 'text' || response.content === null) {
          throw new Error(`Only editable UTF-8 files can be changed: ${editFile.path}`);
        }
        file = response.file;
        originalContent = response.content;
      }
      const applied = applyLanguageServerTextEdits(originalContent, editFile.edits);
      return {
        path: editFile.path,
        originalContent,
        nextContent: applied.content,
        file,
        previews: applied.previews,
      };
    }));
    preparedWorkspaceEditRef.current = { title, files };
    setAssistState({
      kind: 'edit-preview',
      title,
      files: files.map((file) => ({ path: file.path, edits: file.previews })),
      applying: false,
    });
  }, []);

  const chooseCodeAction = useCallback((action: LanguageServerCodeAction): void => {
    if (!action.edit || action.disabledReason) return;
    void prepareWorkspaceEdit(action.title, action.edit).catch((error) => {
      setErrorMessage(toErrorMessage(error));
    });
  }, [prepareWorkspaceEdit]);

  const changeRenameValue = useCallback((value: string): void => {
    setAssistState((current) => current?.kind === 'rename' ? { ...current, value } : current);
  }, []);

  const submitRename = useCallback(async (): Promise<void> => {
    const current = assistStateRef.current;
    const pending = pendingRenameRef.current;
    const view = editorViewRef.current;
    const language = pending ? languageServerLanguageForPath(pending.path) : null;
    const renameSymbol = workspace?.renameLanguageServerSymbol;
    if (
      current?.kind !== 'rename'
      || !pending
      || !view
      || editorPathRef.current !== pending.path
      || !language
      || !renameSymbol
      || !current.value
    ) return;
    setAssistState({ ...current, submitting: true });
    setErrorMessage('');
    try {
      const response = normalizeLanguageServerRenameResult(await renameSymbol({
        language,
        path: pending.path,
        content: view.state.doc.toString(),
        version: nextLanguageServerDocumentVersion(pending.path),
        position: pending.position,
        newName: current.value,
      }));
      assertLanguageServerValue(response, 'Cheshi returned an invalid language server rename result.');
      const edit = requireLanguageServerRenameEdit(response);
      await prepareWorkspaceEdit(
        `Rename ${current.placeholder} to ${current.value}`,
        edit,
      );
    } catch (error) {
      setAssistState((state) => state?.kind === 'rename' ? { ...state, submitting: false } : state);
      setErrorMessage(toErrorMessage(error));
    }
  }, [nextLanguageServerDocumentVersion, prepareWorkspaceEdit]);

  const applyPreparedWorkspaceEdit = useCallback(async (): Promise<void> => {
    const prepared = preparedWorkspaceEditRef.current;
    const writeWorkspaceFiles = workspace?.writeWorkspaceFiles;
    if (!prepared || !writeWorkspaceFiles) return;
    setAssistState((current) => current?.kind === 'edit-preview'
      ? { ...current, applying: true }
      : current);
    setErrorMessage('');
    try {
      for (const file of prepared.files) {
        const tab = tabsRef.current.find((candidate) => candidate.path === file.path);
        assertWorkspaceEditPreviewCurrent(file, tab);
      }
      const response: WorkspaceFilesWriteResult = await writeWorkspaceFiles({
        files: prepared.files.map((file) => ({
          path: file.path,
          content: file.nextContent,
          expectedRevision: file.file.revision,
          hasBom: file.file.hasBom,
          lineEnding: file.file.lineEnding,
        })),
      });
      assertWorkspaceFilesWritten(response);
      const updatedVersions = new Map(response.files.map((file) => [file.path, file]));
      const affectedPaths = new Set(prepared.files.map((file) => file.path));
      if (selectedPathRef.current && affectedPaths.has(selectedPathRef.current)) destroyEditor(false, false);
      replaceTabs((currentTabs) => currentTabs.map((tab) => {
        const file = prepared.files.find((candidate) => candidate.path === tab.path);
        const version = updatedVersions.get(tab.path);
        if (!file || !version) return tab;
        const content = normalizeWorkspaceEditorContent(file.nextContent);
        return {
          ...tab,
          file: version,
          savedContent: content,
          draftContent: content,
          conflictMessage: null,
          loadGeneration: ++nextTabGeneration.current,
          editorState: undefined,
        };
      }));
      preparedWorkspaceEditRef.current = null;
      pendingRenameRef.current = null;
      setAssistState(null);
    } catch (error) {
      setAssistState((current) => current?.kind === 'edit-preview'
        ? { ...current, applying: false }
        : current);
      setErrorMessage(toErrorMessage(error));
    }
  }, [destroyEditor, replaceTabs]);

  const saveFile = useCallback(async (): Promise<void> => {
    const tab = tabsRef.current.find((candidate) => candidate.path === selectedPathRef.current);
    if (!canSaveWorkspaceTab(tab, savingRef.current)) return;
    if (!workspace?.writeWorkspaceFile) {
      setErrorMessage('Electron Workspace API is unavailable.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrorMessage('');
    try {
      const response: WorkspaceFileWriteResult = await workspace.writeWorkspaceFile({
        path: tab.file.path,
        content: tab.draftContent,
        expectedRevision: tab.file.revision,
        hasBom: tab.file.hasBom,
        lineEnding: tab.file.lineEnding,
      });
      updateTab(tab.path, (current) => applyWorkspaceFileSaveResult(current, tab, response));
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [updateTab]);
  saveFileRef.current = saveFile;

  useEffect(() => {
    onSelectedPathChange(selectedPath);
  }, [onSelectedPathChange, selectedPath]);

  useEffect(() => {
    if (!active) {
      invalidatePendingFileLoad();
      return;
    }
    if (!target || !sessionReady) return;
    void loadFile(target.path, target.line);
  }, [active, invalidatePendingFileLoad, loadFile, target, sessionReady]);

  useEffect(() => {
    const getWorkspaceFileVersion = workspace?.getWorkspaceFileVersion;
    if (!active || loading || !selectedPath || !currentFile || !getWorkspaceFileVersion) return;
    let cancelled = false;
    const poller = window.setInterval(() => {
      void (async () => {
        try {
          const latest = await getWorkspaceFileVersion(selectedPath);
          if (cancelled || selectedPathRef.current !== selectedPath) return;
          const tab = tabsRef.current.find((candidate) => candidate.path === selectedPath);
          if (!tab || latest.revision === tab.file.revision) return;
          if (isTabDirty(tab)) {
            updateTab(tab.path, (current) => ({
              ...current,
              file: latest,
              conflictMessage: 'This file changed outside the editor. Save is disabled until you reload it.',
            }));
            return;
          }
          await loadFile(selectedPath, tab.sourceExcerpt?.targetLine ?? null, true);
        } catch {
          // A later poll or explicit file-open request reports transient failures.
        }
      })();
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(poller);
    };
  }, [active, currentFile?.revision, loadFile, loading, selectedPath, updateTab]);

  useEffect(() => {
    const handleBeforeUnload = (): string | undefined => (
      tabsRef.current.some(isTabDirty) && !updateDraftsPreserved() ? '' : undefined
    );
    window.onbeforeunload = handleBeforeUnload;
    return () => {
      if (window.onbeforeunload === handleBeforeUnload) window.onbeforeunload = null;
    };
  }, []);

  useEffect(() => () => {
    fileLoadTracker.invalidate();
    resetLanguageServerRequests();
    const path = editorPathRef.current;
    const language = path ? languageServerLanguageForPath(path) : null;
    if (path && language) void workspace?.closeLanguageServerDocument?.({ language, path });
    editorViewRef.current?.destroy();
    editorViewRef.current = null;
    editorPathRef.current = null;
  }, [fileLoadTracker, resetLanguageServerRequests]);

  const requestReferencesAtSelection = (): void => {
    const view = editorViewRef.current;
    const path = editorPathRef.current;
    if (view && path) void requestLanguageServerReferences(view, path, view.state.selection.main.head);
  };

  const requestCodeActionsAtSelection = (): void => {
    const view = editorViewRef.current;
    const path = editorPathRef.current;
    if (view && path) void requestLanguageServerCodeActions(view, path);
  };

  const requestRenameAtSelection = (): void => {
    const view = editorViewRef.current;
    const path = editorPathRef.current;
    if (view && path) void requestLanguageServerRename(view, path, view.state.selection.main.head);
  };

  const reloadSelectedFile = (): void => {
    if (selectedPath) void loadFile(selectedPath, target?.line, true);
  };

  return {
    active,
    activeLanguageServer,
    activeTab,
    activateOpenTab,
    applyPreparedWorkspaceEdit,
    assistState,
    changeRenameValue,
    chooseCodeAction,
    closeAllTabs,
    closeAssist,
    closeEditorSearch,
    closeTab,
    configureActiveLanguageServer,
    codeExplanation,
    conflictMessage,
    copyTabFullPath,
    currentFile,
    diagnostics,
    diagnosticsStatus,
    editorHostRef,
    editorSearchControls,
    editorSearchInputRef,
    editorSearchOpen,
    editorSearchQueryValid,
    errorMessage,
    findNextMatch: () => runEditorSearchCommand(findNext),
    findPreviousMatch: () => runEditorSearchCommand(findPrevious),
    isDirty,
    languageServerConfiguring,
    languageServers,
    loadFile,
    loading,
    navigateHistory,
    navigationAvailability,
    openReference,
    problemsOpen,
    problemsRatio,
    problemsVisible,
    reloadSelectedFile,
    replaceAllMatches: () => runEditorSearchCommand(replaceAllSearchMatches),
    replaceNextMatch: () => runEditorSearchCommand(replaceNextSearchMatch),
    requestCodeActionsAtSelection,
    requestReferencesAtSelection,
    requestRenameAtSelection,
    revealDiagnostic,
    saveFile,
    saving,
    selectAllMatches: () => runEditorSearchCommand(selectMatches),
    selectedPath,
    selectReference,
    setProblemsOpen,
    setProblemsRatio,
    submitRename,
    tabs,
    toggleEditorSearch,
    updateEditorSearchControls,
  };
}
