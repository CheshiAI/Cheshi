import { record, textValue } from './protocol.ts';
export interface RuntimeConfiguration {
  profileId: string; accountId: string; role: string; token: string; instructions: string;
  model: string | null; reasoningEffort: string | null; serviceTier: string | null;
  permissions: { fileWrite: boolean; commandExecution: boolean };
}
export function parseRuntimeConfiguration(value: unknown): RuntimeConfiguration {
  const data = record(value), permissions = record(data.permissions);
  for (const key of ['fileWrite', 'commandExecution']) {
    if (permissions[key] !== true && permissions[key] !== false) throw new Error('Invalid worker permissions.');
  }
  const token = textValue(data.token, 'worker authorization');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid worker authorization.');
  const nullable = (value: unknown) => value === null ? null : textValue(value, 'model setting');
  return { accountId: textValue(data.accountId, 'account'), profileId: textValue(data.profileId, 'profile'), role: textValue(data.role, 'role'), token,
    instructions: textValue(data.instructions, 'instructions'), model: nullable(data.model),
    reasoningEffort: nullable(data.reasoningEffort), serviceTier: nullable(data.serviceTier),
    permissions: { fileWrite: permissions.fileWrite === true, commandExecution: permissions.commandExecution === true } };
}
