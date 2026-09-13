export interface CodeExplanationRequest {
  requestId: string;
  path: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
}

export type { EphemeralSessionResult as CodeExplanationResult } from './ephemeral-session';

export const CODE_EXPLANATION_SELECTION_LIMIT = 32_000;
export const CODE_EXPLANATION_CONTEXT_LIMIT = 8_000;

function boundedString(value: unknown, name: string, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.trim())) {
    throw new TypeError(`${name} must be ${allowEmpty ? 'at most' : 'between 1 and'} ${limit} characters.`);
  }
  return value;
}

export function codeExplanationRequestId(value: unknown): string {
  return boundedString(value, 'Explanation request id', 128);
}

export function codeExplanationRequest(value: unknown): CodeExplanationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Code explanation request must be an object.');
  }
  const request = value as Record<string, unknown>;
  const path = boundedString(request.path, 'File path', 4096);
  if (path.includes('\0')) throw new TypeError('File path is invalid.');
  if (
    typeof request.startLine !== 'number' || !Number.isSafeInteger(request.startLine)
    || typeof request.endLine !== 'number' || !Number.isSafeInteger(request.endLine)
    || request.startLine < 1 || request.endLine < request.startLine
  ) throw new TypeError('Selected line range is invalid.');
  return {
    requestId: codeExplanationRequestId(request.requestId), path,
    startLine: request.startLine, endLine: request.endLine,
    selectedText: boundedString(request.selectedText, 'Selected code', CODE_EXPLANATION_SELECTION_LIMIT),
    contextBefore: boundedString(request.contextBefore, 'Preceding context', CODE_EXPLANATION_CONTEXT_LIMIT, true),
    contextAfter: boundedString(request.contextAfter, 'Following context', CODE_EXPLANATION_CONTEXT_LIMIT, true),
  };
}
