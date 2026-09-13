import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type SubmitEvent as ReactSubmitEvent,
} from 'react';

import { errorMessage } from '../../shared/errorMessage';
import {
  isWorkspacePathAtOrBelow,
  renameWorkspacePathPrefix,
  workspaceDirectoriesAffectedByChanges,
  workspaceParentDirectory,
} from '../../shared/workspacePaths';
import {
  cheshiDesktop as workspace,
  type CheshiWorkspaceEntry,
  type WorkspaceEntryMutation,
} from '../../cheshiDesktop';
import type { WorkspaceFileContextMenuTarget } from './WorkspaceFileContextMenu';

const workspaceFileTreeManualRefreshIndicatorMs = 600;

type WorkspaceFileTreeRefreshMode = 'background' | 'interactive';

export interface VisibleWorkspaceEntry {
  entry: CheshiWorkspaceEntry;
  depth: number;
}

export type WorkspaceFileTreeEdit =
  | { mode: 'create'; directoryPath: string; entryKind: 'file' | 'directory' }
  | { mode: 'move'; entry: CheshiWorkspaceEntry }
  | { mode: 'rename'; entry: CheshiWorkspaceEntry };

interface WorkspaceFileTreeControllerOptions {
  onEntryMutation: (mutation: WorkspaceEntryMutation) => void;
  onOpenFile: (path: string) => void;
}

function entriesForVisibility(
  entries: CheshiWorkspaceEntry[],
  showHiddenFiles: boolean,
): CheshiWorkspaceEntry[] {
  return showHiddenFiles ? entries : entries.filter((entry) => !entry.name.startsWith('.'));
}

function assertWorkspaceRootRefreshSucceeded<T>(
  result: PromiseSettledResult<T> | undefined,
): asserts result is PromiseFulfilledResult<T> {
  if (!result) throw new Error('Could not refresh the Workspace root.');
  if (result.status === 'rejected') throw result.reason;
}

function workspaceBaseName(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath;
}

export function useWorkspaceFileTreeController({
  onEntryMutation,
  onOpenFile,
}: WorkspaceFileTreeControllerOptions) {
  const listWorkspaceDirectory = workspace?.listWorkspaceDirectory;
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, CheshiWorkspaceEntry[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set(['.']));
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [loadingDirectory, setLoadingDirectory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<WorkspaceFileContextMenuTarget | null>(null);
  const [entryEdit, setEntryEdit] = useState<WorkspaceFileTreeEdit | null>(null);
  const [entryEditValue, setEntryEditValue] = useState('');
  const [mutatingPath, setMutatingPath] = useState<string | null>(null);
  const mutationInFlightRef = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const entryEditInputRef = useRef<HTMLInputElement>(null);
  const entriesByDirectoryRef = useRef(entriesByDirectory);
  const pendingRefreshDirectoriesRef = useRef<Set<string>>(new Set());
  const refreshInFlightRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    entriesByDirectoryRef.current = entriesByDirectory;
  }, [entriesByDirectory]);

  const loadDirectory = useCallback(async (directory: string): Promise<void> => {
    if (!listWorkspaceDirectory) {
      setError('Electron Workspace API is unavailable.');
      return;
    }

    setLoadingDirectory(directory);
    try {
      const response = await listWorkspaceDirectory(directory);
      setEntriesByDirectory((currentEntries) => ({ ...currentEntries, [response.path]: response.entries }));
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoadingDirectory((currentDirectory) => (currentDirectory === directory ? null : currentDirectory));
    }
  }, [listWorkspaceDirectory]);

  useEffect(() => {
    void loadDirectory('.');
  }, [loadDirectory]);

  const refreshWorkspaceFiles = useCallback(async (
    mode: WorkspaceFileTreeRefreshMode = 'interactive',
    requestedDirectories?: readonly string[],
  ): Promise<void> => {
    if (!listWorkspaceDirectory) {
      setError('Electron Workspace API is unavailable.');
      return;
    }
    const initialDirectories = [...new Set(requestedDirectories ?? [
      '.',
      ...Object.keys(entriesByDirectoryRef.current).filter((directory) => directory !== '.'),
    ])];
    if (initialDirectories.length === 0) return;
    if (refreshInFlightRef.current) {
      for (const directory of initialDirectories) pendingRefreshDirectoriesRef.current.add(directory);
      return;
    }

    refreshInFlightRef.current = true;
    setRefreshing(true);
    const minimumIndicator = mode === 'interactive'
      ? new Promise<void>((resolve) => window.setTimeout(resolve, workspaceFileTreeManualRefreshIndicatorMs))
      : undefined;

    const takePendingDirectories = (): string[] => {
      const pendingDirectories = [...pendingRefreshDirectoriesRef.current];
      pendingRefreshDirectoriesRef.current.clear();
      return pendingDirectories;
    };
    const refreshDirectories = async (directories: readonly string[]): Promise<void> => {
      const uniqueDirectories = [...new Set(directories)];
      if (uniqueDirectories.length === 0) return;
      const results = await Promise.allSettled(
        uniqueDirectories.map((directory) => listWorkspaceDirectory(directory)),
      );
      const rootDirectoryIndex = uniqueDirectories.indexOf('.');
      if (rootDirectoryIndex >= 0) assertWorkspaceRootRefreshSucceeded(results[rootDirectoryIndex]);

      const unavailableDirectories = new Set<string>();
      const refreshedEntries: Record<string, CheshiWorkspaceEntry[]> = {};
      results.forEach((result, index) => {
        const directory = uniqueDirectories[index];
        if (!directory) return;
        if (result.status === 'fulfilled') {
          refreshedEntries[result.value.path] = result.value.entries;
        } else {
          unavailableDirectories.add(directory);
        }
      });

      setEntriesByDirectory((currentEntries) => {
        const nextEntries = { ...currentEntries };
        for (const unavailableDirectory of unavailableDirectories) {
          for (const directory of Object.keys(nextEntries)) {
            if (isWorkspacePathAtOrBelow(directory, unavailableDirectory)) delete nextEntries[directory];
          }
        }
        return { ...nextEntries, ...refreshedEntries };
      });
      if (unavailableDirectories.size > 0) {
        const unavailableDirectoryList = [...unavailableDirectories];
        setExpandedDirectories((currentDirectories) => new Set(
          [...currentDirectories].filter((directory) => (
            unavailableDirectoryList.every((unavailableDirectory) => (
              !isWorkspacePathAtOrBelow(directory, unavailableDirectory)
            ))
          )),
        ));
      }
    };
    const drainRefreshQueue = async (directories: readonly string[]): Promise<void> => {
      let nextDirectories = [...directories];
      while (nextDirectories.length > 0) {
        await refreshDirectories(nextDirectories);
        nextDirectories = takePendingDirectories();
      }
    };

    try {
      await drainRefreshQueue(initialDirectories);
      await minimumIndicator;
      await drainRefreshQueue(takePendingDirectories());
      setError(null);
    } catch (refreshError) {
      await minimumIndicator;
      setError(errorMessage(refreshError));
    } finally {
      pendingRefreshDirectoriesRef.current.clear();
      refreshInFlightRef.current = false;
      setRefreshing(false);
    }
  }, [listWorkspaceDirectory]);

  useEffect(() => {
    return workspace?.onWorkspaceFilesChanged?.((event) => {
      const loadedDirectories = Object.keys(entriesByDirectoryRef.current);
      const affectedDirectories = workspaceDirectoriesAffectedByChanges(
        loadedDirectories,
        event.paths,
        event.overflow,
      );
      if (affectedDirectories.length > 0) {
        void refreshWorkspaceFiles('background', affectedDirectories);
      }
    });
  }, [refreshWorkspaceFiles]);

  useEffect(() => {
    if (!entryEdit) return undefined;
    const frame = requestAnimationFrame(() => {
      entryEditInputRef.current?.focus();
      entryEditInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [entryEdit]);

  const closeContextMenu = useCallback((): void => setContextMenu(null), []);

  const toggleDirectory = (directory: string): void => {
    const isExpanded = expandedDirectories.has(directory);
    setExpandedDirectories((currentDirectories) => {
      const nextDirectories = new Set(currentDirectories);
      if (isExpanded) nextDirectories.delete(directory);
      else nextDirectories.add(directory);
      return nextDirectories;
    });
    if (!isExpanded && !Object.hasOwn(entriesByDirectory, directory)) void loadDirectory(directory);
  };

  const activateEntry = (entry: CheshiWorkspaceEntry): void => {
    if (entry.kind === 'directory') toggleDirectory(entry.path);
    else onOpenFile(entry.path);
  };

  const openContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    entry: CheshiWorkspaceEntry | null,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const directoryPath = entry?.kind === 'directory'
      ? entry.path
      : workspaceParentDirectory(entry?.path ?? '.');
    setContextMenu({ directoryPath, entry, x: event.clientX, y: event.clientY });
    setError(null);
  };

  const beginRename = (entry: CheshiWorkspaceEntry): void => {
    if (mutationInFlightRef.current) return;
    setContextMenu(null);
    setEntryEdit({ mode: 'rename', entry });
    setEntryEditValue(entry.name);
    setError(null);
  };

  const beginCreate = (directoryPath: string, entryKind: 'file' | 'directory'): void => {
    if (mutationInFlightRef.current) return;
    setContextMenu(null);
    setEntryEdit({ mode: 'create', directoryPath, entryKind });
    setEntryEditValue('');
    setError(null);
    setExpandedDirectories((currentDirectories) => {
      const nextDirectories = new Set(currentDirectories);
      nextDirectories.add(directoryPath);
      return nextDirectories;
    });
    if (!Object.hasOwn(entriesByDirectoryRef.current, directoryPath)) void loadDirectory(directoryPath);
  };

  const beginMove = (entry: CheshiWorkspaceEntry): void => {
    if (mutationInFlightRef.current) return;
    setContextMenu(null);
    setEntryEdit({ mode: 'move', entry });
    setEntryEditValue(workspaceParentDirectory(entry.path));
    setError(null);
  };

  const updateTreeAfterPathChange = (previousPath: string, nextPath: string): void => {
    const previousDirectory = workspaceParentDirectory(previousPath);
    const nextParentDirectory = workspaceParentDirectory(nextPath);
    const movedToAnotherDirectory = previousDirectory !== nextParentDirectory;
    setEntriesByDirectory((currentEntries) => {
      const nextEntries: Record<string, CheshiWorkspaceEntry[]> = {};
      for (const [directory, entries] of Object.entries(currentEntries)) {
        const nextDirectory = renameWorkspacePathPrefix(directory, previousPath, nextPath);
        const retainedEntries = movedToAnotherDirectory && directory === previousDirectory
          ? entries.filter((entry) => entry.path !== previousPath)
          : entries;
        nextEntries[nextDirectory] = retainedEntries.map((entry) => {
          const path = renameWorkspacePathPrefix(entry.path, previousPath, nextPath);
          if (path === entry.path) return entry;
          return {
            ...entry,
            path,
            name: entry.path === previousPath ? workspaceBaseName(nextPath) : entry.name,
          };
        });
      }
      return nextEntries;
    });
    setExpandedDirectories((currentDirectories) => new Set(
      [...currentDirectories].map((directory) => renameWorkspacePathPrefix(directory, previousPath, nextPath)),
    ));
    const changedDirectories = new Set([previousDirectory, nextParentDirectory]);
    void Promise.all([...changedDirectories].map((directory) => loadDirectory(directory)));
  };

  const focusEntryEditor = (): void => {
    requestAnimationFrame(() => entryEditInputRef.current?.focus());
  };

  const cancelEntryEdit = (): void => {
    if (!mutationInFlightRef.current) setEntryEdit(null);
  };

  const submitRename = async (event: ReactSubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (mutationInFlightRef.current) return;
    const edit = entryEdit;
    if (edit?.mode !== 'rename') return;
    const { entry } = edit;
    const newName = entryEditValue.trim();
    if (!newName) {
      setError('Workspace entry name must not be empty.');
      focusEntryEditor();
      return;
    }
    if (newName === entry.name) {
      setEntryEdit(null);
      return;
    }
    if (!workspace?.renameWorkspaceEntry) {
      setError('Electron Workspace rename API is unavailable.');
      return;
    }

    mutationInFlightRef.current = true;
    setMutatingPath(entry.path);
    setError(null);
    try {
      const result = await workspace.renameWorkspaceEntry({ path: entry.path, newName });
      updateTreeAfterPathChange(result.previousPath, result.path);
      setEntryEdit(null);
      setAnnouncement(`Renamed ${entry.name} to ${newName}.`);
      onEntryMutation({ type: 'renamed', previousPath: result.previousPath, path: result.path });
    } catch (renameError) {
      setError(errorMessage(renameError));
      focusEntryEditor();
    } finally {
      mutationInFlightRef.current = false;
      setMutatingPath(null);
    }
  };

  const submitCreate = async (event: ReactSubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (mutationInFlightRef.current) return;
    const edit = entryEdit;
    if (edit?.mode !== 'create') return;
    const name = entryEditValue.trim();
    if (!name) {
      setError('Workspace entry name must not be empty.');
      focusEntryEditor();
      return;
    }
    if (!workspace?.createWorkspaceEntry) {
      setError('Electron Workspace create API is unavailable.');
      return;
    }

    mutationInFlightRef.current = true;
    setMutatingPath(edit.directoryPath);
    setError(null);
    try {
      const result = await workspace.createWorkspaceEntry({
        directoryPath: edit.directoryPath,
        name,
        kind: edit.entryKind,
      });
      await loadDirectory(edit.directoryPath);
      setEntryEdit(null);
      setAnnouncement(`Created ${edit.entryKind === 'directory' ? 'folder' : 'file'} ${name}.`);
      if (result.kind === 'file') onOpenFile(result.path);
    } catch (createError) {
      setError(errorMessage(createError));
      focusEntryEditor();
    } finally {
      mutationInFlightRef.current = false;
      setMutatingPath(null);
    }
  };

  const submitMove = async (event: ReactSubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (mutationInFlightRef.current) return;
    const edit = entryEdit;
    if (edit?.mode !== 'move') return;
    const destinationDirectory = entryEditValue.trim();
    if (!destinationDirectory) {
      setError('Move destination must not be empty. Use . for the Workspace root.');
      focusEntryEditor();
      return;
    }
    if (!workspace?.moveWorkspaceEntry) {
      setError('Electron Workspace move API is unavailable.');
      return;
    }

    mutationInFlightRef.current = true;
    setMutatingPath(edit.entry.path);
    setError(null);
    try {
      const result = await workspace.moveWorkspaceEntry({
        path: edit.entry.path,
        destinationDirectory,
      });
      setEntryEdit(null);
      if (result.previousPath === result.path) {
        setAnnouncement(`${edit.entry.name} is already in ${destinationDirectory}.`);
        return;
      }
      updateTreeAfterPathChange(result.previousPath, result.path);
      setExpandedDirectories((currentDirectories) => {
        const nextDirectories = new Set(currentDirectories);
        nextDirectories.add(workspaceParentDirectory(result.path));
        return nextDirectories;
      });
      setAnnouncement(`Moved ${edit.entry.name} to ${destinationDirectory}.`);
      onEntryMutation({ type: 'moved', previousPath: result.previousPath, path: result.path });
    } catch (moveError) {
      setError(errorMessage(moveError));
      focusEntryEditor();
    } finally {
      mutationInFlightRef.current = false;
      setMutatingPath(null);
    }
  };

  const copyFullPath = async (entry: CheshiWorkspaceEntry): Promise<void> => {
    setContextMenu(null);
    if (!workspace?.copyWorkspaceEntryFullPath) {
      setError('Electron Workspace clipboard API is unavailable.');
      return;
    }
    try {
      await workspace.copyWorkspaceEntryFullPath(entry.path);
      setAnnouncement(`Copied the full path for ${entry.name}.`);
      setError(null);
    } catch (copyError) {
      setError(errorMessage(copyError));
    }
  };

  const deleteEntry = async (entry: CheshiWorkspaceEntry): Promise<void> => {
    if (mutationInFlightRef.current) return;
    setContextMenu(null);
    const entryKind = entry.kind === 'directory' ? 'folder' : 'file';
    if (!window.confirm(`Move the ${entryKind} "${entry.name}" to Trash?`)) return;
    if (!workspace?.deleteWorkspaceEntry) {
      setError('Electron Workspace delete API is unavailable.');
      return;
    }

    mutationInFlightRef.current = true;
    setMutatingPath(entry.path);
    setError(null);
    try {
      const result = await workspace.deleteWorkspaceEntry(entry.path);
      setEntriesByDirectory((currentEntries) => {
        const nextEntries: Record<string, CheshiWorkspaceEntry[]> = {};
        for (const [directory, entries] of Object.entries(currentEntries)) {
          if (isWorkspacePathAtOrBelow(directory, result.path)) continue;
          nextEntries[directory] = entries.filter((candidate) => (
            !isWorkspacePathAtOrBelow(candidate.path, result.path)
          ));
        }
        return nextEntries;
      });
      setExpandedDirectories((currentDirectories) => new Set(
        [...currentDirectories].filter((directory) => !isWorkspacePathAtOrBelow(directory, result.path)),
      ));
      void loadDirectory(workspaceParentDirectory(result.path));
      setAnnouncement(`Moved ${entry.name} to Trash.`);
      onEntryMutation({ type: 'deleted', path: result.path });
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      mutationInFlightRef.current = false;
      setMutatingPath(null);
    }
  };

  const visibleEntries = useMemo<VisibleWorkspaceEntry[]>(() => {
    const result: VisibleWorkspaceEntry[] = [];
    const appendDirectory = (directory: string, depth: number): void => {
      for (const entry of entriesForVisibility(entriesByDirectory[directory] ?? [], showHiddenFiles)) {
        result.push({ entry, depth });
        if (entry.kind === 'directory' && expandedDirectories.has(entry.path)) {
          appendDirectory(entry.path, depth + 1);
        }
      }
    };
    if (expandedDirectories.has('.')) appendDirectory('.', 0);
    return result;
  }, [entriesByDirectory, expandedDirectories, showHiddenFiles]);

  return {
    activateEntry,
    announcement,
    beginCreate,
    beginMove,
    beginRename,
    cancelEntryEdit,
    closeContextMenu,
    contextMenu,
    copyFullPath,
    deleteEntry,
    entryEdit,
    entryEditInputRef,
    entryEditValue,
    error,
    expandedDirectories,
    loadingDirectory,
    mutatingPath,
    openContextMenu,
    refreshWorkspaceFiles,
    refreshing,
    rootEntries: entriesForVisibility(entriesByDirectory['.'] ?? [], showHiddenFiles),
    rootExpanded: expandedDirectories.has('.'),
    setEntryEditValue,
    setShowHiddenFiles,
    showHiddenFiles,
    submitCreate,
    submitMove,
    submitRename,
    toggleDirectory,
    visibleEntries,
  };
}

export type WorkspaceFileTreeController = ReturnType<typeof useWorkspaceFileTreeController>;
