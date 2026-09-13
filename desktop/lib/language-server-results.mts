import { recordValue } from "./codex-service-utils.mts";
import { LanguageServerClient } from "./language-server-client.mts";
import { isInsideWorkspace, normalizeRange } from "./language-server-documents.mts";
import type { DocumentRange } from "./language-server-types.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LANGUAGE_SERVER_LOCATIONS = 1_000;

const MAX_LANGUAGE_SERVER_CODE_ACTIONS = 100;

const MAX_LANGUAGE_SERVER_WORKSPACE_FILES = 100;

const MAX_LANGUAGE_SERVER_TEXT_EDITS = 10_000;

const MAX_LANGUAGE_SERVER_EDIT_TEXT_BYTES = 4 * 1_048_576;

function textContent(value: unknown) {
  if (typeof value === "string") return value;
  const content = recordValue(value);
  return typeof content?.value === "string" ? content.value : null;
}

function completionEditRange(value: unknown) {
  const edit = recordValue(value);
  return (
    normalizeRange(edit?.range) ??
    normalizeRange(edit?.replace) ??
    normalizeRange(value)
  );
}

function completionCharacters(value: unknown) {
  return Array.isArray(value)
    ? value.filter((character) => typeof character === "string")
    : [];
}

export function normalizeCompletionResult(value: unknown) {
  const completionList = recordValue(value);
  const rawItems = Array.isArray(value)
    ? value
    : Array.isArray(completionList?.items)
      ? completionList.items
      : [];
  const itemDefaults = recordValue(completionList?.itemDefaults);
  const defaultEditRange = completionEditRange(itemDefaults?.editRange);
  const defaultCommitCharacters = completionCharacters(
    itemDefaults?.commitCharacters,
  );
  const items = [];
  for (const valueItem of rawItems) {
    const item = recordValue(valueItem);
    if (typeof item?.label !== "string" || !item.label) continue;
    const rawTextEdit = recordValue(item.textEdit);
    const insertText =
      typeof rawTextEdit?.newText === "string"
        ? rawTextEdit.newText
        : typeof item.textEditText === "string"
          ? item.textEditText
          : typeof item.insertText === "string"
            ? item.insertText
            : item.label;
    const editRange = completionEditRange(item.textEdit) ?? defaultEditRange;
    items.push({
      label: item.label,
      detail: typeof item.detail === "string" ? item.detail : null,
      documentation: textContent(item.documentation),
      kind: Number.isSafeInteger(item.kind) ? item.kind : null,
      sortText: typeof item.sortText === "string" ? item.sortText : null,
      filterText: typeof item.filterText === "string" ? item.filterText : null,
      insertText,
      textEdit: editRange ? { range: editRange, newText: insertText } : null,
      deprecated:
        item.deprecated === true ||
        (Array.isArray(item.tags) && item.tags.includes(1)),
      commitCharacters: Array.isArray(item.commitCharacters)
        ? completionCharacters(item.commitCharacters)
        : defaultCommitCharacters,
    });
  }
  return {
    isIncomplete: completionList?.isIncomplete === true,
    items,
  };
}

export function normalizeHoverResult(value: unknown) {
  const hover = recordValue(value);
  if (!hover) return { contents: [], range: null };
  const rawContents = Array.isArray(hover.contents)
    ? hover.contents
    : [hover.contents];
  const contents = rawContents
    .map(textContent)
    .filter((content) => typeof content === "string" && content.trim());
  return {
    contents,
    range: normalizeRange(hover.range),
  };
}

function normalizeDefinitionLocation(value: unknown, workspaceRoot: string) {
  const location = recordValue(value);
  const uri =
    typeof location?.uri === "string"
      ? location.uri
      : typeof location?.targetUri === "string"
        ? location.targetUri
        : null;
  const range =
    normalizeRange(location?.range) ??
    normalizeRange(location?.targetSelectionRange) ??
    normalizeRange(location?.targetRange);
  if (!uri || !range) return null;
  let absolutePath;
  try {
    absolutePath = fileURLToPath(uri);
  } catch {
    return null;
  }
  if (!isInsideWorkspace(workspaceRoot, absolutePath)) return null;
  return {
    path: path.relative(workspaceRoot, absolutePath).split(path.sep).join("/"),
    range,
  };
}

export function normalizeDefinitionResult(value: unknown, workspaceRoot: string) {
  const rawLocations = Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value];
  const locations = [];
  const seen = new Set();
  for (const rawLocation of rawLocations) {
    if (locations.length >= MAX_LANGUAGE_SERVER_LOCATIONS) break;
    const location = normalizeDefinitionLocation(rawLocation, workspaceRoot);
    if (!location) continue;
    const key = [
      location.path,
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(location);
  }
  return { locations };
}

export function normalizeSignatureHelpResult(value: unknown) {
  const help = recordValue(value);
  if (!help || !Array.isArray(help.signatures)) {
    return { signatures: [], activeSignature: null, activeParameter: null };
  }
  const signatures = [];
  for (const rawSignature of help.signatures.slice(0, 50)) {
    const signature = recordValue(rawSignature);
    if (!signature || typeof signature.label !== "string" || !signature.label)
      continue;
    const parameters = [];
    if (Array.isArray(signature.parameters)) {
      for (const rawParameter of signature.parameters.slice(0, 100)) {
        const parameter = recordValue(rawParameter);
        if (!parameter) continue;
        let label = null;
        if (typeof parameter.label === "string") {
          label = parameter.label;
        } else if (
          Array.isArray(parameter.label) &&
          parameter.label.length === 2 &&
          parameter.label.every((offset) => Number.isSafeInteger(offset)) &&
          parameter.label[0] >= 0 &&
          parameter.label[1] >= parameter.label[0] &&
          parameter.label[1] <= signature.label.length
        ) {
          label = signature.label.slice(parameter.label[0], parameter.label[1]);
        }
        if (label === null) continue;
        parameters.push({
          label,
          documentation: textContent(parameter.documentation),
        });
      }
    }
    signatures.push({
      label: signature.label,
      documentation: textContent(signature.documentation),
      parameters,
      activeParameter: Number.isSafeInteger(signature.activeParameter)
        ? signature.activeParameter
        : null,
    });
  }
  const activeSignature =
    typeof help.activeSignature === "number" &&
    Number.isSafeInteger(help.activeSignature) &&
    help.activeSignature >= 0 &&
    help.activeSignature < signatures.length
      ? help.activeSignature
      : signatures.length > 0
        ? 0
        : null;
  const activeParameter =
    typeof help.activeParameter === "number" &&
    Number.isSafeInteger(help.activeParameter) &&
    help.activeParameter >= 0
      ? help.activeParameter
      : activeSignature === null
        ? null
        : (signatures[activeSignature]?.activeParameter ?? null);
  return { signatures, activeSignature, activeParameter };
}

export function normalizePrepareRenameResult(value: unknown) {
  if (value === null || value === undefined) {
    return { available: false, range: null, placeholder: null };
  }
  const result = recordValue(value);
  const range = normalizeRange(result?.range) ?? normalizeRange(value);
  const available = range !== null || result?.defaultBehavior === true;
  if (!available) return { available: false, range: null, placeholder: null };
  return {
    available: true,
    range,
    placeholder:
      typeof result?.placeholder === "string" ? result.placeholder : null,
  };
}

function workspacePathFromUri(uri: unknown, workspaceRoot: string) {
  if (typeof uri !== "string") return null;
  let absolutePath;
  try {
    absolutePath = fileURLToPath(uri);
  } catch {
    return null;
  }
  if (!isInsideWorkspace(workspaceRoot, absolutePath)) return null;
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}

function normalizeTextEdit(value: unknown) {
  const edit = recordValue(value);
  const range = normalizeRange(edit?.range);
  return range && typeof edit?.newText === "string"
    ? { range, newText: edit.newText }
    : null;
}

function normalizeWorkspaceEdit(value: unknown, workspaceRoot: string) {
  const workspaceEdit = recordValue(value);
  if (!workspaceEdit) return null;
  const files = new Map<
    string,
    Array<{ range: DocumentRange; newText: string }>
  >();
  let editCount = 0;
  let editBytes = 0;

  const addEdits = (uri: unknown, values: unknown) => {
    const relativePath = workspacePathFromUri(uri, workspaceRoot);
    if (!relativePath || !Array.isArray(values)) return false;
    const target = files.get(relativePath) ?? [];
    for (const valueEdit of values) {
      const edit = normalizeTextEdit(valueEdit);
      if (!edit) return false;
      editCount += 1;
      editBytes += Buffer.byteLength(edit.newText, "utf8");
      if (
        editCount > MAX_LANGUAGE_SERVER_TEXT_EDITS ||
        editBytes > MAX_LANGUAGE_SERVER_EDIT_TEXT_BYTES
      ) {
        return false;
      }
      target.push(edit);
    }
    files.set(relativePath, target);
    return files.size <= MAX_LANGUAGE_SERVER_WORKSPACE_FILES;
  };

  if (workspaceEdit.changes !== undefined) {
    const changes = recordValue(workspaceEdit.changes);
    if (!changes) return null;
    for (const [uri, edits] of Object.entries(changes)) {
      if (!addEdits(uri, edits)) return null;
    }
  }
  if (workspaceEdit.documentChanges !== undefined) {
    if (!Array.isArray(workspaceEdit.documentChanges)) return null;
    for (const rawDocumentChange of workspaceEdit.documentChanges) {
      const documentChange = recordValue(rawDocumentChange);
      const textDocument = recordValue(documentChange?.textDocument);
      if (
        !documentChange ||
        !textDocument ||
        !addEdits(textDocument.uri, documentChange.edits)
      )
        return null;
    }
  }
  if (
    files.size === 0 ||
    [...files.values()].some((edits) => edits.length === 0)
  )
    return null;
  return {
    files: [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, edits]) => ({ path: relativePath, edits })),
  };
}

function isRedundantTypeScriptCodeActionCommand(value: unknown) {
  const command = recordValue(value);
  if (
    command?.command !== "_typescript.applyCodeActionCommand" ||
    !Array.isArray(command.arguments) ||
    command.arguments.length !== 1
  )
    return false;
  const argument = recordValue(command.arguments[0]);
  const action = recordValue(argument?.action);
  if (!action) return false;
  // typescript-language-server uses this wrapper only to forward optional tsserver commands.
  // With no nested commands, the WorkspaceEdit is the complete fix and the wrapper is a no-op.
  return (
    action.commands === undefined ||
    (Array.isArray(action.commands) && action.commands.length === 0)
  );
}

export async function normalizeCodeActionResult(
  value: unknown,
  workspaceRoot: string,
  client: Pick<LanguageServerClient, "resolveCodeAction">,
) {
  if (!Array.isArray(value)) return { actions: [] };
  const actions = [];
  for (const rawAction of value.slice(0, MAX_LANGUAGE_SERVER_CODE_ACTIONS)) {
    let action = recordValue(rawAction);
    if (!action || typeof action.title !== "string" || !action.title) continue;
    const initiallyDisabled =
      typeof recordValue(action.disabled)?.reason === "string";
    if (
      !initiallyDisabled &&
      action.edit === undefined &&
      action.data !== undefined
    ) {
      try {
        action = recordValue(await client.resolveCodeAction(action)) ?? action;
      } catch {
        // An unresolved action remains visible but disabled below.
      }
    }
    const disabled = recordValue(action.disabled);
    const rawEditPresent = action.edit !== undefined;
    const edit = rawEditPresent
      ? normalizeWorkspaceEdit(action.edit, workspaceRoot)
      : null;
    const commandPresent =
      action.command !== undefined &&
      !isRedundantTypeScriptCodeActionCommand(action.command);
    const disabledReason =
      typeof disabled?.reason === "string"
        ? disabled.reason
        : rawEditPresent && !edit
          ? "This action contains edits outside the Workspace or unsupported file operations."
          : commandPresent
            ? "This action requires an unsupported language-server command."
            : !edit
              ? "This action did not provide an editable change."
              : null;
    actions.push({
      title: action.title,
      kind: typeof action.kind === "string" ? action.kind : null,
      preferred: action.isPreferred === true,
      disabledReason,
      edit,
    });
  }
  return { actions };
}

export function normalizeRenameResult(value: unknown, workspaceRoot: string) {
  if (value === null || value === undefined) {
    return {
      edit: null,
      failureReason: "The language server did not return rename edits.",
    };
  }
  const edit = normalizeWorkspaceEdit(value, workspaceRoot);
  return edit
    ? { edit, failureReason: null }
    : {
        edit: null,
        failureReason:
          "Rename contains edits outside the Workspace or unsupported file operations.",
      };
}
