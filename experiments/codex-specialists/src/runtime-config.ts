import { record, textValue } from './protocol.ts';
export interface RuntimeConfiguration {
  decisionProtocol?: 1; verificationProtocol?: 1;
  profileId: string; accountId: string; role: string; token: string; instructions: string;
  model: string | null; reasoningEffort: string | null; serviceTier: string | null;
  permissions: { fileWrite: boolean; commandExecution: boolean };
}
export function parseRuntimeConfiguration(value: unknown): RuntimeConfiguration {
  const data = record(value), permissions = record(data.permissions);
  if (data.verificationProtocol !== undefined && (data.verificationProtocol !== 1 || data.decisionProtocol !== 1)) throw new Error('Invalid verification protocol.');
  if (data.decisionProtocol !== undefined && data.decisionProtocol !== 1) throw new Error('Invalid decision protocol.');
  for (const key of ['fileWrite', 'commandExecution']) {
    if (permissions[key] !== true && permissions[key] !== false) throw new Error('Invalid worker permissions.');
  }
  const token = textValue(data.token, 'worker authorization');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid worker authorization.');
  const nullable = (value: unknown) => value === null ? null : textValue(value, 'model setting');
  return { ...(data.verificationProtocol === 1 ? { verificationProtocol: 1 as const } : {}), ...(data.decisionProtocol === 1 ? { decisionProtocol: 1 as const } : {}), accountId: textValue(data.accountId, 'account'), profileId: textValue(data.profileId, 'profile'), role: textValue(data.role, 'role'), token,
    instructions: textValue(data.instructions, 'instructions'), model: nullable(data.model),
    reasoningEffort: nullable(data.reasoningEffort), serviceTier: nullable(data.serviceTier),
    permissions: { fileWrite: permissions.fileWrite === true, commandExecution: permissions.commandExecution === true } };
}
