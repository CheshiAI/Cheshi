import type { WorkspaceRoot } from "./workspace-file-types.mts";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspaceRequestError extends Error {
  status: number;
  constructor(message: string | undefined, status = 400) {
    super(message);
    this.name = "WorkspaceRequestError";
    this.status = status;
  }
}

export function isWithinRoot(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function normalizeRelativePath(value: string) {
  if (typeof value !== "string") {
    throw new WorkspaceRequestError("Workspace paths must be strings.", 400);
  }
  const normalized = value.replaceAll("\\", "/").trim();
  if (normalized === "" || normalized === ".") return "";
  if (
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.isAbsolute(normalized)
  ) {
    throw new WorkspaceRequestError("Workspace paths must be relative.", 400);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new WorkspaceRequestError(
      "Workspace path escapes the selected root.",
      403,
    );
  }
  return segments
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

export async function openWorkspaceRoot(projectRoot: string): Promise<WorkspaceRoot> {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new WorkspaceRequestError(
      "The selected workspace root must be absolute.",
      500,
    );
  }
  const resolved = await realpath(projectRoot).catch(() => {
    throw new WorkspaceRequestError(
      "The selected workspace is unavailable.",
      404,
    );
  });
  const rootStats = await lstat(resolved);
  if (!rootStats.isDirectory()) {
    throw new WorkspaceRequestError(
      "The selected workspace root is not a directory.",
      400,
    );
  }
  return { requested: projectRoot, resolved };
}

export function isGitMetadataPath(relativePath: string) {
  return relativePath.split("/").includes(".git");
}

export function isLiteralTrue(value: unknown): value is true {
  return value === true;
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveWorkspaceTarget(
  root: WorkspaceRoot,
  relativePath: string,
  allowMissing = false,
) {
  const relative = normalizeRelativePath(relativePath);
  const candidate = path.resolve(root.resolved, relative);
  if (!isWithinRoot(root.resolved, candidate)) {
    throw new WorkspaceRequestError(
      "Workspace path escapes the selected root.",
      403,
    );
  }

  let targetStats;
  try {
    targetStats = await lstat(candidate);
  } catch (error) {
    if (
      !allowMissing ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    const parent = await realpath(path.dirname(candidate)).catch(() => {
      throw new WorkspaceRequestError(
        "The workspace parent directory is unavailable.",
        404,
      );
    });
    if (!isWithinRoot(root.resolved, parent)) {
      throw new WorkspaceRequestError(
        "Workspace path escapes the selected root.",
        403,
      );
    }
    return candidate;
  }

  if (targetStats.isSymbolicLink()) {
    throw new WorkspaceRequestError(
      "Symbolic links are not editable through the workspace API.",
      403,
    );
  }

  const actual = await realpath(candidate).catch(() => {
    throw new WorkspaceRequestError(
      "The workspace target is unavailable.",
      404,
    );
  });
  if (!isWithinRoot(root.resolved, actual)) {
    throw new WorkspaceRequestError(
      "Workspace path escapes the selected root.",
      403,
    );
  }
  return actual;
}

export function relativeWorkspacePath(root: WorkspaceRoot, absolutePath: string) {
  const relative = path
    .relative(root.resolved, absolutePath)
    .split(path.sep)
    .join("/");
  return relative || ".";
}
