/** An expected lifecycle cancellation, distinct from a failed workspace operation. */
export class WorkspaceClosedError extends Error {
  constructor() {
    super('The workspace has closed.');
    this.name = 'AbortError';
  }
}

const closedResponse = { __cheshiWorkspaceIpc: 'closed' } as const;

/** Electron logs rejected invoke handlers, so carry only this cancellation as data. */
export async function workspaceIpcResponse(operation: () => unknown): Promise<unknown> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof WorkspaceClosedError) return closedResponse;
    throw error;
  }
}

/** Restore rejection before feature APIs can interpret a cancellation as success. */
export function unwrapWorkspaceIpcResponse(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, '__cheshiWorkspaceIpc')
    && Reflect.get(value, '__cheshiWorkspaceIpc') === 'closed') {
    throw new WorkspaceClosedError();
  }
  return value;
}
