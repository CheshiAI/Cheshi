export type JsonRecord = Record<string, unknown>;
export type Notification = { method: string; params: JsonRecord };

export function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected an object.');
  }
  return value as JsonRecord;
}

export function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Missing ${label}.`);
  return value;
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function deniedServerRequest(method: string): JsonRecord | null {
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
    return { decision: 'decline' };
  }
  if (['execCommandApproval', 'applyPatchApproval'].includes(method)) return { decision: 'denied' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  return null;
}
