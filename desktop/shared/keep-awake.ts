export const KEEP_AWAKE_CHANNEL = 'cheshi:keep-awake';

export interface KeepAwakeState {
  supported: boolean;
  enabled: boolean;
  busy: boolean;
  error: string | null;
  revision: number;
}

export interface KeepAwakeApi {
  getKeepAwake(): Promise<KeepAwakeState>;
  setKeepAwake(enabled: boolean): Promise<KeepAwakeState>;
  onKeepAwakeChanged(listener: (state: KeepAwakeState) => void): () => void;
}
