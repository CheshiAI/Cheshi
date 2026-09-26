import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { EditorView } from '@codemirror/view';
import { cheshiDesktop as workspace, type LanguageServerCodeAction, type LanguageServerWorkspaceEdit,
  type WorkspaceFileVersion, type WorkspaceFilesWriteResult } from '../../cheshiDesktop';
import { errorMessage as toErrorMessage } from '../../shared/errorMessage';
import { languageServerLanguageForPath, normalizeLanguageServerRenameResult } from './languageServerDiagnostics';
import { assertLanguageServerValue, assertWorkspaceEditPreviewCurrent, assertWorkspaceFilesWritten,
  isTabDirty, requireLanguageServerRenameEdit, type PreparedWorkspaceEdit,
  type PreparedWorkspaceEditFile, type WorkspaceTab } from './workspaceEditorModel';
import { applyLanguageServerTextEdits } from './workspaceTextEdits';
import { normalizeWorkspaceEditorContent } from './workspaceFileLoad';
import { beginWorkspaceEditorRequest, type WorkspaceEditorRequest, type WorkspaceRequestTracker } from './workspaceEditorRequest';
import type { WorkspaceEditorAssistState } from './workspaceEditorAssistState';
import type { PendingWorkspaceRename } from './useWorkspaceAssistRequests';

interface Options {
  api?: Pick<NonNullable<typeof workspace>, 'readWorkspaceFile' | 'renameLanguageServerSymbol' | 'writeWorkspaceFiles'>;
  assistStateRef: RefObject<WorkspaceEditorAssistState | null>;
  assistRequests: WorkspaceRequestTracker;
  pendingRenameRef: RefObject<PendingWorkspaceRename | null>;
  editorViewRef: RefObject<EditorView | null>;
  editorPathRef: RefObject<string | null>;
  selectedPathRef: RefObject<string | null>;
  tabsRef: RefObject<WorkspaceTab[]>;
  nextTabGeneration: RefObject<number>;
  nextLanguageServerDocumentVersion: (path: string) => number;
  destroyEditor: (captureState?: boolean) => void;
  replaceTabs: (update: (tabs: WorkspaceTab[]) => WorkspaceTab[]) => void;
  setAssistState: Dispatch<SetStateAction<WorkspaceEditorAssistState | null>>;
  setErrorMessage: Dispatch<SetStateAction<string>>;
}

export function useWorkspaceEditorEdits({ assistStateRef, assistRequests, pendingRenameRef, editorViewRef,
  editorPathRef, selectedPathRef, tabsRef, nextTabGeneration, nextLanguageServerDocumentVersion,
  destroyEditor, replaceTabs, setAssistState, setErrorMessage, api = workspace }: Options) {
  const preparedWorkspaceEditRef = useRef<(PreparedWorkspaceEdit & { request: WorkspaceEditorRequest }) | null>(null);
  const applyingRef = useRef(false);
  const prepareWorkspaceEdit = useCallback(async (
    title: string,
    edit: LanguageServerWorkspaceEdit,
    request: WorkspaceEditorRequest,
  ): Promise<void> => {
    if (!request.isCurrent()) return;
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
        const response = await api?.readWorkspaceFile?.(editFile.path);
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
    if (!request.isCurrent()) return;
    preparedWorkspaceEditRef.current = { title, files, request };
    setAssistState({
      kind: 'edit-preview',
      title,
      files: files.map((file) => ({ path: file.path, edits: file.previews })),
      applying: false,
    });
  }, [api]);

  const chooseCodeAction = useCallback((action: LanguageServerCodeAction): void => {
    const previous = assistRequests.current();
    const view = editorViewRef.current;
    const path = editorPathRef.current;
    if (!action.edit || action.disabledReason || !previous?.isCurrent() || !view || !path) return;
    const request = beginWorkspaceEditorRequest(assistRequests, view, path, editorViewRef, editorPathRef);
    void prepareWorkspaceEdit(action.title, action.edit, request).catch((error) => {
      if (request.isCurrent()) setErrorMessage(toErrorMessage(error));
    });
  }, [assistRequests, prepareWorkspaceEdit]);

  const changeRenameValue = useCallback((value: string): void => {
    setAssistState((current) => current?.kind === 'rename' ? { ...current, value } : current);
  }, []);

  const submitRename = useCallback(async (): Promise<void> => {
    const current = assistStateRef.current;
    const pending = pendingRenameRef.current;
    const view = editorViewRef.current;
    const language = pending ? languageServerLanguageForPath(pending.path) : null;
    const renameSymbol = api?.renameLanguageServerSymbol;
    if (
      current?.kind !== 'rename'
      || !pending
      || !pending.request.isCurrent()
      || current.submitting
      || !view
      || editorPathRef.current !== pending.path
      || !language
      || !renameSymbol
      || !current.value
    ) return;
    const request = beginWorkspaceEditorRequest(assistRequests, view, pending.path, editorViewRef, editorPathRef);
    pendingRenameRef.current = { ...pending, request };
    const submitting = { ...current, submitting: true };
    assistStateRef.current = submitting;
    setAssistState(submitting);
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
      if (!request.isCurrent()) return;
      assertLanguageServerValue(response, 'Cheshi returned an invalid language server rename result.');
      const edit = requireLanguageServerRenameEdit(response);
      await prepareWorkspaceEdit(
        `Rename ${current.placeholder} to ${current.value}`,
        edit,
        request,
      );
    } catch (error) {
      if (!request.isCurrent()) return;
      setAssistState((state) => state?.kind === 'rename' ? { ...state, submitting: false } : state);
      setErrorMessage(toErrorMessage(error));
    }
  }, [api, assistRequests, nextLanguageServerDocumentVersion, prepareWorkspaceEdit]);

  const applyPreparedWorkspaceEdit = useCallback(async (): Promise<void> => {
    const prepared = preparedWorkspaceEditRef.current;
    const writeWorkspaceFiles = api?.writeWorkspaceFiles;
    if (!prepared || !prepared.request.isCurrent() || !writeWorkspaceFiles || applyingRef.current) return;
    applyingRef.current = true;
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
      const ownsPanel = prepared.request.isCurrent();
      const updatedVersions = new Map(response.files.map((file) => [file.path, file]));
      const affectedPaths = new Set(prepared.files.map((file) => file.path));
      if (selectedPathRef.current && affectedPaths.has(selectedPathRef.current)) destroyEditor(false);
      replaceTabs((currentTabs) => currentTabs.map((tab) => {
        const file = prepared.files.find((candidate) => candidate.path === tab.path);
        const version = updatedVersions.get(tab.path);
        if (!file || !version) return tab;
        const content = normalizeWorkspaceEditorContent(file.nextContent);
        const draftChanged = tab.draftContent !== file.originalContent;
        return {
          ...tab,
          file: version,
          savedContent: content,
          draftContent: draftChanged ? tab.draftContent : content,
          conflictMessage: null,
          loadGeneration: ++nextTabGeneration.current,
          editorState: undefined,
        };
      }));
      if (preparedWorkspaceEditRef.current === prepared) preparedWorkspaceEditRef.current = null;
      if (ownsPanel) {
        pendingRenameRef.current = null;
        setAssistState(null);
      }
    } catch (error) {
      if (!prepared.request.isCurrent()) return;
      setAssistState((current) => current?.kind === 'edit-preview'
        ? { ...current, applying: false }
        : current);
      setErrorMessage(toErrorMessage(error));
    } finally {
      applyingRef.current = false;
    }
  }, [api, destroyEditor, replaceTabs]);

  return { chooseCodeAction, changeRenameValue, submitRename, applyPreparedWorkspaceEdit };
}
