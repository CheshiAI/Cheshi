import {
  isGitMetadataPath,
  normalizeRelativePath,
  openWorkspaceRoot,
} from "./workspace-file-paths.mts";
import type {
  WorkspaceFilesChangedEvent,
  WorkspaceFileWatchOptions,
} from "./workspace-file-types.mts";
import { watch } from "node:fs";

const DEFAULT_WORKSPACE_WATCH_DEBOUNCE_MS = 150;

const DEFAULT_WORKSPACE_WATCH_PATH_LIMIT = 512;

export async function watchWorkspaceFiles(
  projectRoot: string,
  onChange: (event: WorkspaceFilesChangedEvent) => void,
  options: WorkspaceFileWatchOptions = {},
): Promise<() => void> {
  if (typeof onChange !== "function") {
    throw new TypeError(
      "Workspace file watcher change handler must be a function.",
    );
  }
  const debounceMs = options.debounceMs ?? DEFAULT_WORKSPACE_WATCH_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new TypeError(
      "Workspace file watcher debounce must be a non-negative number.",
    );
  }
  const pathLimit = options.pathLimit ?? DEFAULT_WORKSPACE_WATCH_PATH_LIMIT;
  if (!Number.isSafeInteger(pathLimit) || pathLimit < 1) {
    throw new TypeError(
      "Workspace file watcher path limit must be a positive integer.",
    );
  }
  const onError = options.onError ?? (() => {});
  if (typeof onError !== "function") {
    throw new TypeError(
      "Workspace file watcher error handler must be a function.",
    );
  }
  const watcherFactory = options.watcherFactory ?? watch;
  if (typeof watcherFactory !== "function") {
    throw new TypeError("Workspace file watcher factory must be a function.");
  }

  const root = await openWorkspaceRoot(projectRoot);
  const changedPaths = new Set<string>();
  let closed = false;
  let overflow = false;
  let timer: string | number | NodeJS.Timeout | null | undefined = null;
  const reportError = (error: unknown) => {
    try {
      onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Error reporting must not turn an OS watcher failure into an uncaught exception.
    }
  };
  const flush = () => {
    timer = null;
    if (closed) return;
    const event = { paths: [...changedPaths].sort(), overflow };
    changedPaths.clear();
    overflow = false;
    try {
      onChange(event);
    } catch (error) {
      reportError(error);
    }
  };
  const scheduleFlush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };
  const recordChange = (filename: { toString: () => any } | null) => {
    if (closed) return;
    let relativePath;
    try {
      relativePath =
        filename === null ? "" : normalizeRelativePath(filename.toString());
    } catch (error) {
      reportError(error);
      overflow = true;
      changedPaths.clear();
      scheduleFlush();
      return;
    }
    if (relativePath && isGitMetadataPath(relativePath)) return;
    if (!relativePath) {
      overflow = true;
      changedPaths.clear();
    } else if (!overflow && !changedPaths.has(relativePath)) {
      if (changedPaths.size >= pathLimit) {
        overflow = true;
        changedPaths.clear();
      } else {
        changedPaths.add(relativePath);
      }
    }
    scheduleFlush();
  };

  const watcher = watcherFactory(
    root.resolved,
    { recursive: true },
    (_eventType: any, filename: any) => {
      recordChange(filename);
    },
  );
  watcher.on("error", reportError);

  return () => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    watcher.close();
  };
}
