import {
  isWithinRoot,
  openWorkspaceRoot,
  relativeWorkspacePath,
  resolveWorkspaceTarget,
  WorkspaceRequestError,
} from "./workspace-file-paths.mts";
import type { WorkspaceRoot } from "./workspace-file-types.mts";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename as renameFileSystemEntry } from "node:fs/promises";
import path from "node:path";

function validateWorkspaceEntryName(value: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceRequestError(
      "Workspace entry names must be non-empty strings.",
      400,
    );
  }
  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new WorkspaceRequestError(
      "Workspace entry names cannot contain path separators.",
      400,
    );
  }
}

/**
 * @param {string} entryName
 * @returns {never}
 */
function assertWorkspaceEntryNameAvailable(entryName: string): never {
  throw new WorkspaceRequestError(
    `An entry named "${entryName}" already exists.`,
    409,
  );
}

async function assertWorkspaceEntryDestinationAvailable(
  destination: string,
  entryName: string,
) {
  try {
    await lstat(destination);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  assertWorkspaceEntryNameAvailable(entryName);
}

function rethrowWorkspaceEntryCreationError(error: unknown, entryName: string) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    assertWorkspaceEntryNameAvailable(entryName);
  }
  throw error;
}

async function openMutableWorkspaceEntry(projectRoot: any, relativePath: any) {
  const root = await openWorkspaceRoot(projectRoot);
  const target = await resolveWorkspaceTarget(root, relativePath);
  if (target === root.resolved) {
    throw new WorkspaceRequestError(
      "The selected workspace root cannot be changed.",
      403,
    );
  }
  return { root, target };
}

async function openWorkspaceDirectory(
  root: WorkspaceRoot,
  relativePath: string,
) {
  const target = await resolveWorkspaceTarget(root, relativePath);
  const targetStats = await lstat(target);
  if (!targetStats.isDirectory()) {
    throw new WorkspaceRequestError(
      "The requested workspace path is not a directory.",
      400,
    );
  }
  return target;
}

export async function getWorkspaceEntryLocation(
  projectRoot: any,
  relativePath: any,
) {
  const { root, target } = await openMutableWorkspaceEntry(
    projectRoot,
    relativePath,
  );
  return {
    path: relativeWorkspacePath(root, target),
    absolutePath: target,
  };
}

export async function createWorkspaceEntry(
  projectRoot: any,
  request: { directoryPath: string; name: string; kind: string } | null,
) {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new WorkspaceRequestError(
      "Workspace create request must be an object.",
      400,
    );
  }
  if (
    typeof request.directoryPath !== "string" ||
    !request.directoryPath.trim()
  ) {
    throw new WorkspaceRequestError(
      "Workspace create directory must be a non-empty string.",
      400,
    );
  }
  validateWorkspaceEntryName(request.name);
  if (request.kind !== "file" && request.kind !== "directory") {
    throw new WorkspaceRequestError(
      "Workspace entry kind must be file or directory.",
      400,
    );
  }

  const root = await openWorkspaceRoot(projectRoot);
  const directory = await openWorkspaceDirectory(root, request.directoryPath);
  const destination = path.join(directory, request.name);
  if (!isWithinRoot(root.resolved, destination)) {
    throw new WorkspaceRequestError(
      "Workspace path escapes the selected root.",
      403,
    );
  }

  try {
    if (request.kind === "directory") {
      await mkdir(destination);
    } else {
      const handle = await open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o666,
      );
      await handle.close();
    }
  } catch (error) {
    rethrowWorkspaceEntryCreationError(error, request.name);
  }

  return {
    path: relativeWorkspacePath(root, destination),
    kind: request.kind,
  };
}

export async function renameWorkspaceEntry(
  projectRoot: any,
  request: { path: string; newName: string } | null,
) {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new WorkspaceRequestError(
      "Workspace rename request must be an object.",
      400,
    );
  }
  if (typeof request.path !== "string" || !request.path.trim()) {
    throw new WorkspaceRequestError(
      "Workspace rename path must be a non-empty string.",
      400,
    );
  }
  validateWorkspaceEntryName(request.newName);

  const { root, target: source } = await openMutableWorkspaceEntry(
    projectRoot,
    request.path,
  );
  const previousPath = relativeWorkspacePath(root, source);
  if (path.basename(source) === request.newName) {
    return { previousPath, path: previousPath };
  }

  const destination = path.join(path.dirname(source), request.newName);
  if (!isWithinRoot(root.resolved, destination)) {
    throw new WorkspaceRequestError(
      "Workspace path escapes the selected root.",
      403,
    );
  }
  await assertWorkspaceEntryDestinationAvailable(destination, request.newName);

  await renameFileSystemEntry(source, destination);
  return {
    previousPath,
    path: relativeWorkspacePath(root, destination),
  };
}

export async function moveWorkspaceEntry(
  projectRoot: any,
  request: { path: string; destinationDirectory: string } | null,
) {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new WorkspaceRequestError(
      "Workspace move request must be an object.",
      400,
    );
  }
  if (typeof request.path !== "string" || !request.path.trim()) {
    throw new WorkspaceRequestError(
      "Workspace move path must be a non-empty string.",
      400,
    );
  }
  if (
    typeof request.destinationDirectory !== "string" ||
    !request.destinationDirectory.trim()
  ) {
    throw new WorkspaceRequestError(
      "Workspace move destination must be a non-empty string.",
      400,
    );
  }

  const { root, target: source } = await openMutableWorkspaceEntry(
    projectRoot,
    request.path,
  );
  const previousPath = relativeWorkspacePath(root, source);
  const destinationDirectory = await openWorkspaceDirectory(
    root,
    request.destinationDirectory,
  );
  if (isWithinRoot(source, destinationDirectory)) {
    throw new WorkspaceRequestError(
      "A folder cannot be moved into itself or one of its descendants.",
      400,
    );
  }

  const entryName = path.basename(source);
  const destination = path.join(destinationDirectory, entryName);
  if (destination === source) return { previousPath, path: previousPath };
  if (!isWithinRoot(root.resolved, destination)) {
    throw new WorkspaceRequestError(
      "Workspace path escapes the selected root.",
      403,
    );
  }
  await assertWorkspaceEntryDestinationAvailable(destination, entryName);
  await renameFileSystemEntry(source, destination);
  return {
    previousPath,
    path: relativeWorkspacePath(root, destination),
  };
}
