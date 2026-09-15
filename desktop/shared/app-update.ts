export interface AppReleaseAsset {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export interface AppRelease {
  version: string;
  tag: string;
  url: string;
  notes: string;
  asset: AppReleaseAsset | null;
}

export type AppUpdateProgress =
  | { phase: 'downloading'; receivedBytes: number; totalBytes: number }
  | { phase: 'verifying' | 'installing' | 'restarting' };

export interface AppUpdateState {
  preview?: boolean;
  currentVersion: string;
  release: AppRelease | null;
  phase: 'idle' | 'preparing' | AppUpdateProgress['phase'];
  downloadProgress?: { receivedBytes: number; totalBytes: number };
  error: string | null;
  installUnavailableReason: string | null;
}

export interface AppUpdateApi {
  getAppUpdate(): Promise<AppUpdateState>;
  onAppUpdate(listener: (state: AppUpdateState) => void): () => void;
  installAppUpdate(): Promise<void>;
  openAppRelease(): Promise<void>;
}

export interface AppUpdateResumeApi {
  getUpdateResume(): Promise<unknown | null>;
  saveUpdateResume(snapshot: unknown): Promise<void>;
  clearUpdateResume(): Promise<void>;
  onPrepareAppUpdate(listener: (requestId: string) => void): () => void;
  onAppUpdateCommitted(listener: (requestId: string) => void): () => void;
  acknowledgeAppUpdate(requestId: string, error: string | null): Promise<void>;
  onAppUpdatePreparationCancelled(listener: () => void): () => void;
}

// Use the management namespace so the same read/install UI works in the project picker.
export const APP_UPDATE_CHANNEL = 'cheshi:workspace-management:app-update';
