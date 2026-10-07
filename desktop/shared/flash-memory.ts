export const FLASH_MEMORY_CHANNEL = 'cheshi:flash-memory';

export interface FlashMemoryStatus {
  state: 'signed_out' | 'preparing' | 'syncing' | 'ready' | 'error';
  processed: number;
  total: number | null;
  waiting: number;
  error: string | null;
}

export interface FlashMemoryApi {
  status(): Promise<FlashMemoryStatus>;
  retry(): Promise<FlashMemoryStatus>;
}
