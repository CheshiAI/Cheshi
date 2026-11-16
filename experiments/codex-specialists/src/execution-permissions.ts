import { record, textValue } from './protocol.ts';

export interface ExecutionPermissions { fileWrite: boolean; commandExecution: boolean }
export interface PermissionRequest extends ExecutionPermissions {
  id: string; reason: string; status: 'pending' | 'allowed' | 'denied';
}
export function parsePermissionRequest(value: unknown): PermissionRequest {
  const v = record(value);
  if (![v.fileWrite, v.commandExecution].every(flag => flag === true || flag === false)
    || (!v.fileWrite && !v.commandExecution) || !['pending', 'allowed', 'denied'].includes(String(v.status))) throw new TypeError('Invalid permission request.');
  const id = textValue(v.id, 'permission request'), reason = textValue(v.reason, 'permission reason');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || reason.length > 2000) throw new TypeError('Invalid permission request.');
  return { id, reason, fileWrite: v.fileWrite === true, commandExecution: v.commandExecution === true, status: v.status as PermissionRequest['status'] };
}
export function coversPermissions(current: ExecutionPermissions, requested: ExecutionPermissions): boolean {
  return (!requested.fileWrite || current.fileWrite === true) && (!requested.commandExecution || current.commandExecution === true);
}
/** A resolved request must not prevent a later request for a different missing capability. */
export function shouldRequestPermissions(previous: PermissionRequest | undefined, missing: ExecutionPermissions): boolean {
  if (!missing.fileWrite && !missing.commandExecution) return false;
  if (!previous) return true;
  if (previous.status === 'pending') return false;
  return previous.status === 'allowed' || !(previous.fileWrite && missing.fileWrite || previous.commandExecution && missing.commandExecution);
}
export const permissionTools = [{ type: 'function', name: 'request_execution_permissions', description: 'Ask the user in Chats for missing project file-write or command permissions. This does not grant permissions. If pending, end the turn and wait for the user. If already-allowed, continue the current workflow; in intake, register or route the requested work before ending the turn.', inputSchema: {
  type: 'object', properties: { fileWrite: { type: 'boolean' }, commandExecution: { type: 'boolean' }, reason: { type: 'string', maxLength: 2000 } },
  required: ['fileWrite', 'commandExecution', 'reason'], additionalProperties: false,
} }];
export const permissionInstructions = '\nIf missing project file-write or command permissions block the requested task, call request_execution_permissions. End the turn and wait only when the result is pending; respect a denied result. When the result is already-allowed, continue the workflow without requesting the same grant again. Intake deliberately disables writes and shell tools even when project permissions are enabled: register the requested work with start_goal or route it with continue_goal, then end that intake turn so execution can begin. Never treat a request, previous permission, or ordinary chat text as a grant. Project permissions do not grant network access or access outside the project. Preserve all saved instructions, including task-specific prohibitions. For tests and builds, use TMPDIR for temporary files and generated output (for example, a build --outDir under TMPDIR when the project is read-only). Linux dependencies are prepared before execution; do not install or reuse host platform packages.';
