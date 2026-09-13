import {
  decodeText,
  describeFile,
  entryFromStats,
  fileKind,
  imageMimeType,
  MAX_EDITABLE_FILE_BYTES,
  MAX_IMAGE_PREVIEW_BYTES,
  readSample,
  requireWorkspaceBuffer,
  revisionFor,
  workspaceStats,
} from "./workspace-file-metadata.mts";
import {
  isLiteralTrue,
  openWorkspaceRoot,
  relativeWorkspacePath,
  resolveWorkspaceTarget,
  WorkspaceRequestError,
} from "./workspace-file-paths.mts";
import type {
  WorkspaceFileExcerptRequest,
  WorkspaceFileExcerptResult,
} from "./workspace-file-types.mts";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_DIRECTORY_ENTRIES = 2_000;

const DEFAULT_EXCERPT_CONTEXT_LINES = 80;

const MAX_EXCERPT_CONTEXT_LINES = 200;

const MAX_EXCERPT_BYTES = 512 * 1_024;

const MAX_EXCERPT_LINE_BYTES = 256 * 1_024;

const EXCERPT_READ_CHUNK_BYTES = 64 * 1_024;

export async function listWorkspaceDirectory(
  projectRoot: string,
  relativePath = ".",
  includeHidden = false,
) {
  const root = await openWorkspaceRoot(projectRoot);
  const target = await resolveWorkspaceTarget(root, relativePath);
  const targetStats = await lstat(target);
  if (!targetStats.isDirectory()) {
    throw new WorkspaceRequestError(
      "The requested workspace path is not a directory.",
      400,
    );
  }

  const children = await readdir(target, { withFileTypes: true });
  const entries = [];
  for (const child of children.slice(0, MAX_DIRECTORY_ENTRIES)) {
    if (!isLiteralTrue(includeHidden) && child.name.startsWith(".")) continue;
    const childPath = path.join(target, child.name);
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) {
      const childStats = await lstat(childPath);
      entries.push(
        entryFromStats(
          root,
          childPath,
          {
            size: 0,
            modifiedAt: childStats.mtimeMs,
            revision: revisionFor({
              size: 0,
              modifiedAt: childStats.mtimeMs,
              mode: childStats.mode & 0o777,
            }),
          },
          "directory",
        ),
      );
      continue;
    }
    if (!child.isFile()) continue;
    const childStats = await workspaceStats(childPath);
    const sample = requireWorkspaceBuffer(
      childStats.size <= MAX_EDITABLE_FILE_BYTES
        ? await readFile(childPath)
        : Buffer.alloc(0),
    );
    entries.push(
      entryFromStats(
        root,
        childPath,
        childStats,
        "file",
        fileKind(childPath, childStats.size, sample),
      ),
    );
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
  return { path: relativeWorkspacePath(root, target), entries };
}

export async function readWorkspaceFile(
  projectRoot: string,
  relativePath: string,
) {
  const root = await openWorkspaceRoot(projectRoot);
  const target = await resolveWorkspaceTarget(root, relativePath);
  const current = await workspaceStats(target);
  const fullReadLimit = imageMimeType(target)
    ? MAX_IMAGE_PREVIEW_BYTES
    : MAX_EDITABLE_FILE_BYTES;
  const bytes = requireWorkspaceBuffer(
    current.size <= fullReadLimit
      ? await readFile(target)
      : await readSample(target, 8_192),
  );
  const file = await describeFile(root, target, bytes);
  if (file.fileKind === "text") {
    if (current.size > MAX_EDITABLE_FILE_BYTES)
      return { file, content: null, dataUrl: null };
    const decoded = decodeText(bytes);
    const content = decoded?.text ?? null;
    return {
      file,
      content: content?.startsWith("\uFEFF") ? content.slice(1) : content,
      dataUrl: null,
    };
  }
  const mime = imageMimeType(target);
  if (
    file.fileKind === "image" &&
    current.size <= MAX_IMAGE_PREVIEW_BYTES &&
    mime
  ) {
    return {
      file,
      content: null,
      dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    };
  }
  return { file, content: null, dataUrl: null };
}

function requireWorkspaceFileExcerptRequest(
  value: WorkspaceFileExcerptRequest,
): Required<WorkspaceFileExcerptRequest> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceRequestError(
      "Workspace file excerpt request must be an object.",
      400,
    );
  }
  if (typeof value.path !== "string" || !value.path.trim()) {
    throw new WorkspaceRequestError(
      "Workspace file excerpt path must be a non-empty string.",
      400,
    );
  }
  if (!Number.isSafeInteger(value.line) || value.line < 1) {
    throw new WorkspaceRequestError(
      "Workspace file excerpt line must be a positive integer.",
      400,
    );
  }
  const contextLines =
    value.contextLines === undefined
      ? DEFAULT_EXCERPT_CONTEXT_LINES
      : value.contextLines;
  if (
    !Number.isSafeInteger(contextLines) ||
    contextLines < 0 ||
    contextLines > MAX_EXCERPT_CONTEXT_LINES
  ) {
    throw new WorkspaceRequestError(
      `Workspace file excerpt context must be between 0 and ${MAX_EXCERPT_CONTEXT_LINES} lines.`,
      400,
    );
  }
  return { path: value.path, line: value.line, contextLines };
}

/**
 * @param {string} line
 */
function assertExcerptLineSize(line: string) {
  if (Buffer.byteLength(line, "utf8") > MAX_EXCERPT_LINE_BYTES) {
    throw new WorkspaceRequestError(
      "The requested source line is too large to display.",
      413,
    );
  }
}

async function readUtf8LineExcerpt(
  target: string,
  targetLine: number,
  contextLines: number,
) {
  const handle = await open(target, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.alloc(EXCERPT_READ_CHUNK_BYTES);
  const precedingLines: string[] = [];
  const selectedLines: string[] = [];
  let selectedBytes = 0;
  let startLine = targetLine;
  let lineNumber = 1;
  let position = 0;
  let pending = "";
  let targetFound = false;
  let hasMoreAfter = false;

  const addSelectedLine = (line: string) => {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (
      lineBytes > MAX_EXCERPT_LINE_BYTES ||
      selectedBytes + lineBytes + 1 > MAX_EXCERPT_BYTES
    ) {
      throw new WorkspaceRequestError(
        "The requested source excerpt is too large to display.",
        413,
      );
    }
    selectedLines.push(line);
    selectedBytes += lineBytes + 1;
  };

  const processLine = (rawLine: string) => {
    let line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (lineNumber === 1 && line.startsWith("\uFEFF")) line = line.slice(1);
    if (line.includes("\0")) {
      throw new WorkspaceRequestError(
        "Only UTF-8 text files can be previewed.",
        415,
      );
    }
    assertExcerptLineSize(line);
    if (lineNumber < targetLine) {
      precedingLines.push(line);
      if (precedingLines.length > contextLines) precedingLines.shift();
    } else if (lineNumber === targetLine) {
      targetFound = true;
      startLine = targetLine - precedingLines.length;
      for (const precedingLine of precedingLines)
        addSelectedLine(precedingLine);
      addSelectedLine(line);
    } else if (lineNumber <= targetLine + contextLines) {
      addSelectedLine(line);
    } else {
      hasMoreAfter = true;
      return false;
    }
    lineNumber += 1;
    return true;
  };

  try {
    readLoop: while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) {
        pending += decoder.decode();
        processLine(pending);
        break;
      }
      position += bytesRead;
      pending += decoder.decode(buffer.subarray(0, bytesRead), {
        stream: true,
      });
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        if (!processLine(line)) break readLoop;
        newlineIndex = pending.indexOf("\n");
      }
      assertExcerptLineSize(pending);
    }
  } catch (error) {
    if (error instanceof WorkspaceRequestError) throw error;
    if (error instanceof TypeError) {
      throw new WorkspaceRequestError(
        "Only UTF-8 text files can be previewed.",
        415,
      );
    }
    throw error;
  } finally {
    await handle.close();
  }

  if (!targetFound) {
    throw new WorkspaceRequestError(
      "Workspace file excerpt line is outside the file.",
      416,
    );
  }
  return {
    content: selectedLines.join("\n"),
    startLine,
    endLine: startLine + selectedLines.length - 1,
    targetLine,
    hasMoreBefore: startLine > 1,
    hasMoreAfter,
  };
}

export async function readWorkspaceFileExcerpt(
  projectRoot: string,
  value: WorkspaceFileExcerptRequest,
): Promise<WorkspaceFileExcerptResult> {
  const request = requireWorkspaceFileExcerptRequest(value);
  const root = await openWorkspaceRoot(projectRoot);
  const target = await resolveWorkspaceTarget(root, request.path);
  const file = await describeFile(root, target);
  const excerpt = await readUtf8LineExcerpt(
    target,
    request.line,
    request.contextLines,
  );
  return { file, ...excerpt };
}

export async function getWorkspaceFileVersion(
  projectRoot: string,
  relativePath: string,
) {
  const root = await openWorkspaceRoot(projectRoot);
  const target = await resolveWorkspaceTarget(root, relativePath);
  return describeFile(root, target);
}
