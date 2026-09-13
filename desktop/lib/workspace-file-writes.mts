import { MAX_EDITABLE_FILE_BYTES, workspaceStats } from "./workspace-file-metadata.mts";
import {
  isRecordValue,
  normalizeRelativePath,
  openWorkspaceRoot,
  resolveWorkspaceTarget,
  WorkspaceRequestError,
} from "./workspace-file-paths.mts";
import { getWorkspaceFileVersion, readWorkspaceFile } from "./workspace-file-reads.mts";
import type {
  WorkspaceFilesWriteRequest,
  WorkspaceFilesWriteResult,
  WorkspaceFileVersion,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
  WorkspaceRoot,
} from "./workspace-file-types.mts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  open,
  rename as renameFileSystemEntry,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

interface PreparedWorkspaceWrite {
  request: WorkspaceFileWriteRequest;
  target: string;
  current: WorkspaceFileVersion;
  serialized: string;
  mode: number;
  tempPath: string;
  backupPath: string;
}

function normalizeWriteContent(
  content: string,
  lineEnding: string,
  hasBom: boolean,
) {
  const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const normalized = withoutBom.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const converted =
    lineEnding === "crlf"
      ? normalized.replaceAll("\n", "\r\n")
      : lineEnding === "cr"
        ? normalized.replaceAll("\n", "\r")
        : normalized;
  return hasBom ? `\uFEFF${converted}` : converted;
}

function validateWriteRequest(
  request: unknown,
): asserts request is WorkspaceFileWriteRequest {
  if (!isRecordValue(request)) {
    throw new WorkspaceRequestError(
      "File write request must be an object.",
      400,
    );
  }
  if (typeof request.path !== "string" || !request.path.trim()) {
    throw new WorkspaceRequestError(
      "File path must be a non-empty string.",
      400,
    );
  }
  if (typeof request.content !== "string") {
    throw new WorkspaceRequestError("File content must be a string.", 400);
  }
  if (
    typeof request.expectedRevision !== "string" ||
    !request.expectedRevision
  ) {
    throw new WorkspaceRequestError(
      "expectedRevision is required for file writes.",
      400,
    );
  }
  if (request.hasBom !== undefined && typeof request.hasBom !== "boolean") {
    throw new WorkspaceRequestError("hasBom must be a boolean.", 400);
  }
  if (
    request.lineEnding !== undefined &&
    request.lineEnding !== "lf" &&
    request.lineEnding !== "crlf" &&
    request.lineEnding !== "cr"
  ) {
    throw new WorkspaceRequestError("lineEnding must be lf, crlf, or cr.", 400);
  }
}

/**
 * @returns {WorkspaceFileWriteRequest[]}
 */
function validateWriteBatchRequest(
  value: unknown,
): WorkspaceFileWriteRequest[] {
  if (!isRecordValue(value) || !Array.isArray(value.files)) {
    throw new WorkspaceRequestError(
      "File write batch request must contain a files array.",
      400,
    );
  }
  if (value.files.length < 1 || value.files.length > 100) {
    throw new WorkspaceRequestError(
      "File write batches must contain between 1 and 100 files.",
      400,
    );
  }
  const seen = new Set<string>();
  const requests: WorkspaceFileWriteRequest[] = [];
  for (const request of value.files) {
    validateWriteRequest(request);
    const key = normalizeRelativePath(request.path);
    if (seen.has(key))
      throw new WorkspaceRequestError(
        "File write batch paths must be unique.",
        400,
      );
    seen.add(key);
    requests.push(request);
  }
  return requests;
}

/**
 * @param {string} projectRoot
 * @param {{ requested: string, resolved: string }} root
 * @param {WorkspaceFileWriteRequest} request
 * @returns {Promise<PreparedWorkspaceWrite>}
 */
async function prepareWorkspaceWrite(
  projectRoot: string,
  root: WorkspaceRoot,
  request: WorkspaceFileWriteRequest,
): Promise<PreparedWorkspaceWrite> {
  const target = await resolveWorkspaceTarget(root, request.path);
  const current = await readWorkspaceFile(projectRoot, request.path);
  if (current.file.fileKind !== "text") {
    throw new WorkspaceRequestError(
      "Only UTF-8 text files can be edited.",
      415,
    );
  }

  const lineEnding = request.lineEnding ?? current.file.lineEnding;
  const hasBom =
    request.hasBom === true ||
    (request.hasBom === undefined && current.file.hasBom);
  const serialized = normalizeWriteContent(request.content, lineEnding, hasBom);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_EDITABLE_FILE_BYTES) {
    throw new WorkspaceRequestError(
      `Editable files must be ${MAX_EDITABLE_FILE_BYTES} bytes or smaller.`,
      413,
    );
  }

  const originalStats = await stat(target);
  const tempPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.cheshi-${process.pid}-${randomUUID()}.tmp`,
  );
  const backupPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.cheshi-${process.pid}-${randomUUID()}.bak`,
  );
  return {
    request,
    target,
    current: current.file,
    serialized,
    mode: originalStats.mode & 0o777,
    tempPath,
    backupPath,
  };
}

/**
 * @param {PreparedWorkspaceWrite} prepared
 */
async function stageWorkspaceWrite(prepared: PreparedWorkspaceWrite) {
  let handle;
  try {
    handle = await open(
      prepared.tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      prepared.mode,
    );
    await handle.writeFile(Buffer.from(prepared.serialized, "utf8"));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(prepared.tempPath, prepared.mode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeWorkspaceFiles(
  projectRoot: string,
  value: WorkspaceFilesWriteRequest,
): Promise<WorkspaceFilesWriteResult> {
  const requests = validateWriteBatchRequest(value);
  const root = await openWorkspaceRoot(projectRoot);
  const prepared = await Promise.all(
    requests.map((request) =>
      prepareWorkspaceWrite(projectRoot, root, request),
    ),
  );
  if (new Set(prepared.map((entry) => entry.target)).size !== prepared.length) {
    throw new WorkspaceRequestError(
      "File write batch paths must resolve to unique files.",
      400,
    );
  }
  const initialConflicts = prepared.filter(
    (entry) => entry.current.revision !== entry.request.expectedRevision,
  );
  if (initialConflicts.length > 0) {
    return {
      status: "conflict",
      files: initialConflicts.map((entry) => entry.current),
    };
  }

  /** @type {PreparedWorkspaceWrite[]} */
  const committed: PreparedWorkspaceWrite[] = [];
  /** @type {Set<string>} */
  const backups: Set<string> = new Set();
  /** @type {Set<string>} */
  const preservedBackups: Set<string> = new Set();
  try {
    for (const entry of prepared) await stageWorkspaceWrite(entry);
    /** @type {WorkspaceFileVersion[]} */
    const changed: WorkspaceFileVersion[] = [];
    for (const entry of prepared) {
      const latest = await workspaceStats(entry.target);
      if (latest.revision !== entry.request.expectedRevision) {
        changed.push(
          await getWorkspaceFileVersion(projectRoot, entry.request.path),
        );
      }
    }
    if (changed.length > 0) return { status: "conflict", files: changed };

    for (const entry of prepared) {
      await copyFile(entry.target, entry.backupPath, constants.COPYFILE_EXCL);
      backups.add(entry.backupPath);
    }
    for (const entry of prepared) {
      await renameFileSystemEntry(entry.tempPath, entry.target);
      committed.push(entry);
    }
    return {
      status: "written",
      files: await Promise.all(
        prepared.map((entry) =>
          getWorkspaceFileVersion(projectRoot, entry.request.path),
        ),
      ),
    };
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of committed.reverse()) {
      try {
        await renameFileSystemEntry(entry.backupPath, entry.target);
        backups.delete(entry.backupPath);
      } catch (rollbackError) {
        preservedBackups.add(entry.backupPath);
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new WorkspaceRequestError(
        "The batch write failed and one or more recovery copies were preserved beside their files.",
        500,
      );
    }
    throw error;
  } finally {
    await Promise.allSettled(prepared.map((entry) => unlink(entry.tempPath)));
    await Promise.allSettled(
      [...backups]
        .filter((backupPath) => !preservedBackups.has(backupPath))
        .map((backupPath) => unlink(backupPath)),
    );
  }
}

export async function writeWorkspaceFile(
  projectRoot: string,
  request: WorkspaceFileWriteRequest,
): Promise<WorkspaceFileWriteResult> {
  validateWriteRequest(request);
  const result = await writeWorkspaceFiles(projectRoot, { files: [request] });
  const file = result.files[0];
  if (!file)
    throw new WorkspaceRequestError(
      "File write did not return its result.",
      500,
    );
  return { status: result.status, file };
}
