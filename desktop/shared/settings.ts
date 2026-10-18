import { parseProjectDocMaxBytes } from '../../experiments/codex-specialists/src/project-instructions.ts';

export const SETTINGS_CHANNELS = {
  getFlashEnabled: 'cheshi:settings:flash:get',
  setFlashEnabled: 'cheshi:settings:flash:set',
  flashEnabledChanged: 'cheshi:settings:flash:changed',
  getProjectDocMaxBytes: 'cheshi:settings:project-doc:get',
  setProjectDocMaxBytes: 'cheshi:settings:project-doc:set',
  projectDocMaxBytesChanged: 'cheshi:settings:project-doc:changed',
} as const;
export { parseProjectDocMaxBytes };

export function parseFlashEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Flash usage must be a boolean.');
  return value === true;
}

export interface SettingsApi {
  getFlashEnabled(): Promise<boolean>;
  setFlashEnabled(enabled: boolean): Promise<boolean>;
  onFlashEnabledChanged(handler: (enabled: boolean) => void): () => void;
  getProjectDocMaxBytes(): Promise<number>;
  setProjectDocMaxBytes(bytes: number): Promise<number>;
  onProjectDocMaxBytesChanged(handler: (bytes: number) => void): () => void;
}
