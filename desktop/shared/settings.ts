import { parseProjectDocMaxBytes } from '../../experiments/codex-specialists/src/project-instructions.ts';

export const SETTINGS_CHANNELS = {
  getFlashEnabled: 'cheshi:settings:flash:get',
  setFlashEnabled: 'cheshi:settings:flash:set',
  flashEnabledChanged: 'cheshi:settings:flash:changed',
  getFlashReadiness: 'cheshi:settings:flash:readiness',
  installFlash: 'cheshi:settings:flash:install',
  getProjectDocMaxBytes: 'cheshi:settings:project-doc:get',
  setProjectDocMaxBytes: 'cheshi:settings:project-doc:set',
  projectDocMaxBytesChanged: 'cheshi:settings:project-doc:changed',
} as const;
export { parseProjectDocMaxBytes };

export function parseFlashEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Flash usage must be a boolean.');
  return value === true;
}

export interface FlashReadiness { ready: boolean; detail: string; installing?: boolean }
export function parseFlashReadiness(value: unknown): FlashReadiness {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Flash readiness.');
  const result = value as Record<string, unknown>;
  if (typeof result.ready !== 'boolean' || typeof result.detail !== 'string'
    || (result.installing !== undefined && typeof result.installing !== 'boolean')) throw new TypeError('Invalid Flash readiness.');
  return { ready: result.ready === true, detail: result.detail, installing: result.installing === true };
}

export interface SettingsApi {
  getFlashReadiness(): Promise<FlashReadiness>;
  installFlash(): Promise<FlashReadiness>;
  getFlashEnabled(): Promise<boolean>;
  setFlashEnabled(enabled: boolean): Promise<boolean>;
  onFlashEnabledChanged(handler: (enabled: boolean) => void): () => void;
  getProjectDocMaxBytes(): Promise<number>;
  setProjectDocMaxBytes(bytes: number): Promise<number>;
  onProjectDocMaxBytesChanged(handler: (bytes: number) => void): () => void;
}
