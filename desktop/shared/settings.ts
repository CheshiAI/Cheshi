import { parseProjectDocMaxBytes } from '../../experiments/codex-specialists/src/project-instructions.ts';
import type { HomieSetupStatus } from './homie-setup.ts';

export const SETTINGS_CHANNELS = {
  getHomieSetup: 'cheshi:settings:homies:status',
  installHomieTools: 'cheshi:settings:homies:install',
  startHomieEngine: 'cheshi:settings:homies:start',
  getFlashEnabled: 'cheshi:settings:flash:get',
  setFlashEnabled: 'cheshi:settings:flash:set',
  flashEnabledChanged: 'cheshi:settings:flash:changed',
  getFlashReadiness: 'cheshi:settings:flash:readiness',
  installFlash: 'cheshi:settings:flash:install',
  checkFlashUpdates: 'cheshi:settings:flash:updates',
  uninstallFlash: 'cheshi:settings:flash:uninstall',
  getProjectDocMaxBytes: 'cheshi:settings:project-doc:get',
  setProjectDocMaxBytes: 'cheshi:settings:project-doc:set',
  projectDocMaxBytesChanged: 'cheshi:settings:project-doc:changed',
} as const;
export { parseProjectDocMaxBytes };

export function parseFlashEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Flash usage must be a boolean.');
  return value === true;
}

export interface FlashInstallProgress {
  startedAt: number;
  downloadedBytes?: number;
  totalBytes?: number;
  phase?: 'package' | 'model';
}
export interface FlashReadiness {
  ready: boolean;
  detail: string;
  installing?: boolean;
  progress?: FlashInstallProgress;
  installedVersion?: string;
  availableVersion?: string;
}
export function parseFlashInstallProgress(value: unknown): FlashInstallProgress {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Flash progress.');
  const progress = value as Record<string, unknown>;
  const validNumber = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  if (!validNumber(progress.startedAt)) throw new TypeError('Invalid Flash progress.');
  if (progress.phase !== undefined && progress.phase !== 'package' && progress.phase !== 'model') throw new TypeError('Invalid Flash progress.');
  const phase: Pick<FlashInstallProgress, 'phase'> = progress.phase === undefined ? {} : { phase: progress.phase };
  if (progress.downloadedBytes === undefined && progress.totalBytes === undefined) return { startedAt: progress.startedAt, ...phase };
  if (!validNumber(progress.downloadedBytes) || !validNumber(progress.totalBytes)
    || progress.totalBytes === 0 || progress.downloadedBytes > progress.totalBytes) throw new TypeError('Invalid Flash progress.');
  return { startedAt: progress.startedAt, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes, ...phase };
}
export function parseFlashReadiness(value: unknown): FlashReadiness {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Flash readiness.');
  const result = value as Record<string, unknown>;
  if (typeof result.ready !== 'boolean' || typeof result.detail !== 'string'
    || (result.installing !== undefined && typeof result.installing !== 'boolean')) throw new TypeError('Invalid Flash readiness.');
  const versions: Pick<FlashReadiness, 'installedVersion' | 'availableVersion'> = {};
  for (const key of ['installedVersion', 'availableVersion'] as const) {
    const version = result[key];
    if (version === undefined) continue;
    if (typeof version !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)) throw new TypeError('Invalid Flash plugin version.');
    versions[key] = version;
  }
  return { ready: result.ready === true, detail: result.detail, installing: result.installing === true, ...versions,
    ...(result.progress === undefined ? {} : { progress: parseFlashInstallProgress(result.progress) }) };
}

export interface SettingsApi {
  getHomieSetup(): Promise<HomieSetupStatus>;
  installHomieTools(): Promise<HomieSetupStatus>;
  startHomieEngine(): Promise<HomieSetupStatus>;
  getFlashReadiness(): Promise<FlashReadiness>;
  installFlash(): Promise<FlashReadiness>;
  checkFlashUpdates(): Promise<FlashReadiness>;
  uninstallFlash(): Promise<FlashReadiness>;
  getFlashEnabled(): Promise<boolean>;
  setFlashEnabled(enabled: boolean): Promise<boolean>;
  onFlashEnabledChanged(handler: (enabled: boolean) => void): () => void;
  getProjectDocMaxBytes(): Promise<number>;
  setProjectDocMaxBytes(bytes: number): Promise<number>;
  onProjectDocMaxBytesChanged(handler: (bytes: number) => void): () => void;
}
