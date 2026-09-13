import { recordValue } from "./codex-service-utils.mts";
import { requireLanguage } from "./language-server-settings.mts";
import type {
  DocumentFeature,
  DocumentPosition,
  DocumentRange,
  DocumentUpdate,
  LanguageServerDefinition,
} from "./language-server-types.mts";
import { existsSync } from "node:fs";
import path from "node:path";

export function requireRelativePath(value: unknown) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw new TypeError(
      "Language server document path must be workspace-relative.",
    );
  }
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new TypeError(
      "Language server document path cannot escape the Workspace.",
    );
  }
  return normalized;
}

export function resolveDocumentPath(workspaceRoot: string, relativePath: string) {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const relation = path.relative(workspaceRoot, absolutePath);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new TypeError(
      "Language server document must be a file inside the Workspace.",
    );
  }
  return absolutePath;
}

export function projectRootFor(
  workspaceRoot: string,
  documentPath: string,
  markers: string[],
) {
  let directory = path.dirname(documentPath);
  while (true) {
    if (
      markers.some((marker: string) => existsSync(path.join(directory, marker)))
    )
      return directory;
    if (directory === workspaceRoot) return workspaceRoot;
    const parent = path.dirname(directory);
    const relation = path.relative(workspaceRoot, parent);
    if (
      parent === directory ||
      relation.startsWith("..") ||
      path.isAbsolute(relation)
    ) {
      return workspaceRoot;
    }
    directory = parent;
  }
}

export function isInsideWorkspace(workspaceRoot: string, absolutePath: string) {
  const relation = path.relative(workspaceRoot, absolutePath);
  return (
    relation !== "" && !relation.startsWith("..") && !path.isAbsolute(relation)
  );
}

function normalizePosition(value: unknown): DocumentPosition | null {
  const position = recordValue(value);
  if (
    typeof position?.line !== "number" ||
    !Number.isSafeInteger(position.line) ||
    position.line < 0 ||
    typeof position.character !== "number" ||
    !Number.isSafeInteger(position.character) ||
    position.character < 0
  )
    return null;
  return { line: position.line, character: position.character };
}

function requirePosition(value: unknown) {
  const position = normalizePosition(value);
  if (!position)
    throw new TypeError("Language server document position is invalid.");
  return position;
}

export function normalizeRange(value: unknown): DocumentRange | null {
  const range = recordValue(value);
  const start = normalizePosition(range?.start);
  const end = normalizePosition(range?.end);
  return start && end ? { start, end } : null;
}

export function requireDocumentUpdate(
  value: unknown,
  definitions: Record<string, LanguageServerDefinition>,
): DocumentUpdate {
  const request = recordValue(value);
  if (!request)
    throw new TypeError("Language server document update must be an object.");
  const language = requireLanguage(request.language, definitions);
  const relativePath = requireRelativePath(request.path);
  if (typeof request.content !== "string")
    throw new TypeError("Language server document content must be a string.");
  if (
    typeof request.version !== "number" ||
    !Number.isSafeInteger(request.version) ||
    request.version < 1
  ) {
    throw new TypeError(
      "Language server document version must be a positive integer.",
    );
  }
  return {
    language,
    relativePath,
    content: request.content,
    version: request.version,
  };
}

export function requireDocumentFeature(
  value: unknown,
  definitions: Record<string, LanguageServerDefinition>,
): DocumentFeature {
  const request = recordValue(value);
  const document = requireDocumentUpdate(value, definitions);
  return { ...document, position: requirePosition(request?.position) };
}

export function requireRenameFeature(
  value: unknown,
  definitions: Record<
    string,
    {
      displayName: string;
      serverName: string;
      command: string;
      args: string[];
      rootMarkers: string[];
      languageId: (filePath: string) => string;
    }
  >,
) {
  const request = recordValue(value);
  const feature = requireDocumentFeature(value, definitions);
  if (
    typeof request?.newName !== "string" ||
    !request.newName ||
    request.newName.length > 256 ||
    request.newName.includes("\0") ||
    request.newName.includes("\n") ||
    request.newName.includes("\r")
  ) {
    throw new TypeError("Language server rename name is invalid.");
  }
  return { ...feature, newName: request.newName };
}

function normalizeRequestDiagnostic(value: unknown) {
  const diagnostic = recordValue(value);
  const range = normalizeRange(diagnostic?.range);
  if (!diagnostic || !range || typeof diagnostic.message !== "string")
    return null;
  const severity = Number.isSafeInteger(diagnostic.severity)
    ? diagnostic.severity
    : undefined;
  const code =
    typeof diagnostic.code === "string" || typeof diagnostic.code === "number"
      ? diagnostic.code
      : undefined;
  const tags = Array.isArray(diagnostic.tags)
    ? diagnostic.tags.filter((tag) => tag === 1 || tag === 2)
    : undefined;
  return {
    range,
    message: diagnostic.message,
    ...(severity === undefined ? {} : { severity }),
    ...(code === undefined ? {} : { code }),
    ...(typeof diagnostic.source === "string"
      ? { source: diagnostic.source }
      : {}),
    ...(tags === undefined ? {} : { tags }),
  };
}

export function requireCodeActionFeature(
  value: unknown,
  definitions: Record<
    string,
    {
      displayName: string;
      serverName: string;
      command: string;
      args: string[];
      rootMarkers: string[];
      languageId: (filePath: string) => string;
    }
  >,
) {
  const request = recordValue(value);
  const document = requireDocumentUpdate(value, definitions);
  const range = normalizeRange(request?.range);
  if (!range)
    throw new TypeError("Language server code action range is invalid.");
  if (
    !Array.isArray(request?.diagnostics) ||
    request.diagnostics.length > 200
  ) {
    throw new TypeError("Language server code action diagnostics are invalid.");
  }
  const diagnostics = request.diagnostics.map(normalizeRequestDiagnostic);
  if (!diagnostics.every((diagnostic) => diagnostic !== null)) {
    throw new TypeError("Language server code action diagnostics are invalid.");
  }
  return { ...document, range, diagnostics };
}
