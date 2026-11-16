export interface IMessageCommandTarget { id: string; label: string; }
export interface IMessageCommandSettings {
  enabled: boolean;
  targetId: string | null;
  targets: IMessageCommandTarget[];
  status: string;
}
export interface IMessageCommandApi {
  get(): Promise<IMessageCommandSettings>;
  configure(value: { enabled: boolean; targetId: string | null }): Promise<IMessageCommandSettings>;
}
export function parseIMessageCommandSettings(value: unknown): IMessageCommandSettings {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid message command settings.');
  const state = value as Record<string, unknown>;
  if (typeof state.enabled !== 'boolean' || (state.targetId !== null && typeof state.targetId !== 'string')
    || typeof state.status !== 'string' || !Array.isArray(state.targets) || state.targets.length > 256) {
    throw new TypeError('Invalid message command settings.');
  }
  const targets = state.targets.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid message command target.');
    const target = value as Record<string, unknown>;
    if (typeof target.id !== 'string' || typeof target.label !== 'string') throw new TypeError('Invalid message command target.');
    return { id: target.id, label: target.label };
  });
  return { enabled: state.enabled, targetId: state.targetId as string | null, status: state.status, targets };
}
