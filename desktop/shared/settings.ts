import { parseProjectDocMaxBytes } from '../../experiments/codex-specialists/src/project-instructions.ts';

export const SETTINGS_CHANNELS = {
  getProjectDocMaxBytes: 'cheshi:settings:project-doc:get',
  setProjectDocMaxBytes: 'cheshi:settings:project-doc:set',
  projectDocMaxBytesChanged: 'cheshi:settings:project-doc:changed',
} as const;
export { parseProjectDocMaxBytes };

export interface SettingsApi {
  getProjectDocMaxBytes(): Promise<number>;
  setProjectDocMaxBytes(bytes: number): Promise<number>;
  onProjectDocMaxBytesChanged(handler: (bytes: number) => void): () => void;
}
