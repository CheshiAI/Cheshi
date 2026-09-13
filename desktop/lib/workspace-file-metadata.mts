import { relativeWorkspacePath, WorkspaceRequestError } from "./workspace-file-paths.mts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileKind,
  WorkspaceFileVersion,
  WorkspaceLineEnding,
  WorkspaceRoot,
  WorkspaceStats,
} from "./workspace-file-types.mts";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_EDITABLE_FILE_BYTES = 1_048_576;

export const MAX_IMAGE_PREVIEW_BYTES = 4 * 1_048_576;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function revisionFor(
  stats: Pick<WorkspaceStats, "size" | "modifiedAt" | "mode">,
  identity?: Pick<WorkspaceStats, "dev" | "ino">,
) {
  return [
    identity?.dev ?? "unknown",
    identity?.ino ?? "unknown",
    stats.size,
    stats.modifiedAt,
    stats.mode,
  ].join(":");
}

export async function workspaceStats(target: string): Promise<WorkspaceStats> {
  const current = await stat(target);
  if (!current.isFile()) {
    throw new WorkspaceRequestError(
      "Only regular files can be read or edited.",
      400,
    );
  }
  const stats = {
    size: current.size,
    modifiedAt: current.mtimeMs,
    mode: current.mode & 0o777,
    dev: current.dev,
    ino: current.ino,
  };
  return { ...stats, revision: revisionFor(stats, stats) };
}

/**
 * @param {unknown} value
 * @returns {Buffer}
 */
export function requireWorkspaceBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new WorkspaceRequestError(
      "Workspace file reads must return a Buffer.",
      500,
    );
  }
  return value;
}

export async function readSample(target: string, maximumBytes: number) {
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes);
    const { bytesRead } = await handle.read(buffer, 0, maximumBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function imageMimeType(filePath: string) {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

function hasBinaryBytes(bytes: Uint8Array) {
  const sampleLength = Math.min(bytes.byteLength, 8_192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

export function decodeText(bytes: Uint8Array) {
  try {
    const hasBom =
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text: hasBom ? `\uFEFF${text}` : text, hasBom };
  } catch {
    return null;
  }
}

function detectLineEnding(text: string): WorkspaceLineEnding {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\r")) return "cr";
  return "lf";
}

export function fileKind(
  filePath: string,
  size: number,
  bytes: Buffer,
): WorkspaceFileKind {
  if (size > MAX_EDITABLE_FILE_BYTES) return "too_large";
  if (imageMimeType(filePath)) return "image";
  if (hasBinaryBytes(bytes)) return "binary";
  return decodeText(bytes) ? "text" : "binary";
}

export function entryFromStats(
  root: WorkspaceRoot,
  absolutePath: string,
  stats: Pick<WorkspaceStats, "revision" | "size" | "modifiedAt">,
  kind: "file" | "directory",
  fileKindValue?: WorkspaceFileKind,
): WorkspaceFileEntry {
  const entry: WorkspaceFileEntry = {
    path: relativeWorkspacePath(root, absolutePath),
    name: path.basename(absolutePath),
    kind,
    size: stats.size,
    modifiedAt: stats.modifiedAt,
    revision: stats.revision,
  };
  if (fileKindValue) entry.fileKind = fileKindValue;
  return entry;
}

export async function describeFile(
  root: WorkspaceRoot,
  target: string,
  bytes?: Buffer,
): Promise<WorkspaceFileVersion> {
  const stats = await workspaceStats(target);
  const fullReadLimit = imageMimeType(target)
    ? MAX_IMAGE_PREVIEW_BYTES
    : MAX_EDITABLE_FILE_BYTES;
  const sample = requireWorkspaceBuffer(
    bytes ??
      (stats.size <= fullReadLimit
        ? await readFile(target)
        : await readSample(target, 8_192)),
  );
  const kind = fileKind(target, stats.size, sample);
  const decoded = kind === "text" ? decodeText(sample) : null;
  return {
    ...entryFromStats(root, target, stats, "file", kind),
    kind: "file",
    fileKind: kind,
    hasBom: decoded?.hasBom ?? false,
    lineEnding: decoded ? detectLineEnding(decoded.text) : "lf",
  };
}
