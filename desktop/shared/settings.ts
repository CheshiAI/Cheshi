export const SETTINGS_CHANNELS = {
  get: 'cheshi:settings:typesafe:get', save: 'cheshi:settings:typesafe:save',
  remove: 'cheshi:settings:typesafe:remove', check: 'cheshi:settings:typesafe:check',
  changed: 'cheshi:settings:typesafe:changed',
  setHistoryRecallEnabled: 'cheshi:settings:history-recall:set',
} as const;
export interface TypeSafeSettings {
  source: 'saved' | 'environment' | 'none';
  maskedKey: string | null;
  canSave: boolean;
  error: string | null;
  historyRecallEnabled: boolean;
}
export interface SettingsApi {
  getTypeSafe(): Promise<TypeSafeSettings>;
  saveTypeSafe(key: string): Promise<TypeSafeSettings>;
  removeTypeSafe(): Promise<TypeSafeSettings>;
  checkTypeSafe(): Promise<boolean>;
  setHistoryRecallEnabled(visible: boolean): Promise<TypeSafeSettings>;
  onTypeSafeChanged(handler: (state: TypeSafeSettings) => void): () => void;
}
export function parseTypeSafeKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[^\x21-\x7e]/.test(value.trim())) {
    throw new TypeError('Enter a valid TypeSafe API key without spaces.');
  }
  return value.trim();
}
export function parseHistoryRecallEnabled(value: unknown): boolean {
  if (value !== true && value !== false) throw new TypeError('Invalid history recall setting.');
  return value;
}
export function parseTypeSafeSettings(value: unknown): TypeSafeSettings {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid TypeSafe settings.');
  const state = value as Record<string, unknown>;
  if (!['saved', 'environment', 'none'].includes(String(state.source))
    || (state.canSave !== true && state.canSave !== false)
    || (state.maskedKey !== null && (typeof state.maskedKey !== 'string' || !/^••••(?:[\x21-\x7e]{4})?$/.test(state.maskedKey)))
    || (state.error !== null && (typeof state.error !== 'string' || state.error.length > 500))) {
    throw new TypeError('Invalid TypeSafe settings.');
  }
  return { source: state.source as TypeSafeSettings['source'], maskedKey: state.maskedKey as string | null,
    canSave: state.canSave, error: state.error as string | null,
    historyRecallEnabled: parseHistoryRecallEnabled(state.historyRecallEnabled) };
}
