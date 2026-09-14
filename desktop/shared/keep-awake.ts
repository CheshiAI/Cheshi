export const KEEP_AWAKE_CHANNEL = 'cheshi:keep-awake';

export interface KeepAwakeState {
  supported: boolean;
  enabled: boolean;
  error: string | null;
}

export interface KeepAwakeApi {
  get(): Promise<KeepAwakeState>;
  set(enabled: boolean): Promise<KeepAwakeState>;
  subscribe(listener: (state: KeepAwakeState) => void): () => void;
}

export function parseKeepAwakeState(value: unknown): KeepAwakeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid keep-awake state.');
  }
  const state = value as Record<string, unknown>;
  if (typeof state.supported !== 'boolean' || typeof state.enabled !== 'boolean'
    || (state.error !== null && typeof state.error !== 'string')
    || (!state.supported && state.enabled)
    || Object.keys(state).some(key => !['supported', 'enabled', 'error'].includes(key))) {
    throw new TypeError('Invalid keep-awake state.');
  }
  return { supported: state.supported, enabled: state.enabled, error: state.error };
}
