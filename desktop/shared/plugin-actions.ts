export interface MarketplaceAddRequest {
  source: string;
  refName?: string;
  sparsePaths?: string[];
}

export interface MarketplaceAddResult {
  marketplaceName: string;
  installedRoot: string;
  alreadyAdded: boolean;
}

export interface PluginWorkflowRequest {
  kind: 'plugin' | 'skill';
  description: string;
  recordingId?: string;
}

export interface SkillRecordingFrame {
  seconds: number;
  image: string;
}

export interface SkillRecordingUpload {
  video: Uint8Array;
  frames: SkillRecordingFrame[];
  durationSeconds: number;
}

export interface SavedSkillRecording {
  id: string;
  durationSeconds: number;
  frameCount: number;
}

export const MAX_RECORDING_SECONDS = 120;
export const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDING_FRAMES = 18;

export function pluginActionText(value: unknown, label: string, limit = 16_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new TypeError(`${label} must contain between 1 and ${limit} characters.`);
  }
  return value.trim();
}

function actionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid plugin action request.');
  return value as Record<string, unknown>;
}

function marketplaceSparsePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError('Repository folders must be a list of at most 128 paths.');
  }
  return [...new Set(value.map((entry: unknown) => {
    const folder = pluginActionText(entry, 'Repository folder', 4096);
    if (/^(?:[/\\]|[a-z]:)/i.test(folder) || folder.split(/[/\\]/).includes('..')) {
      throw new TypeError('Repository folders must be relative paths inside the repository.');
    }
    return folder;
  }))];
}

export function marketplaceAddRequest(value: unknown): MarketplaceAddRequest {
  const request = actionRecord(value);
  const source = pluginActionText(request.source, 'Marketplace source', 4096);
  const refName = request.refName === undefined ? undefined : pluginActionText(request.refName, 'Git ref', 256);
  const sparsePaths = marketplaceSparsePaths(request.sparsePaths);
  return { source, ...(refName ? { refName } : {}), ...(sparsePaths.length ? { sparsePaths } : {}) };
}

export function pluginWorkflowRequest(value: unknown): PluginWorkflowRequest {
  const request = actionRecord(value);
  if (request.kind !== 'plugin' && request.kind !== 'skill') throw new TypeError('Invalid plugin workflow.');
  const description = pluginActionText(request.description, 'Description');
  const recordingId = request.recordingId === undefined ? undefined : pluginActionText(request.recordingId, 'Recording id', 36);
  if (request.kind === 'skill' && !recordingId) throw new TypeError('Record a workflow before creating a skill.');
  if (request.kind === 'plugin' && recordingId) throw new TypeError('Plugin creation does not accept a recording.');
  return { kind: request.kind, description, ...(recordingId ? { recordingId } : {}) };
}
