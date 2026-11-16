export const FLASH_MEMORY_CHANNEL = 'cheshi:flash-memory';

export interface FlashMemoryStatus {
  state: 'disabled' | 'signed_out' | 'preparing' | 'syncing' | 'ready' | 'error';
  processed: number;
  total: number | null;
  waiting: number;
  error: string | null;
}

export interface FlashMemoryApi {
  status(): Promise<FlashMemoryStatus>;
  retry(): Promise<FlashMemoryStatus>;
  original?(target: FlashSourceTarget): Promise<string>;
}

export interface FlashSourceTarget { owner?: string; threadId: string; itemId: string }

const sourceIdPattern = /^[a-zA-Z0-9_-]{1,1024}$/;

/** Internal navigation only; never pass this URL to the operating system. */
export function flashSourceHref(target: FlashSourceTarget): string {
  if (typeof target.threadId !== 'string' || typeof target.itemId !== 'string' || !sourceIdPattern.test(target.threadId) || !sourceIdPattern.test(target.itemId)) {
    throw new Error('Invalid conversation source target');
  }
  if (target.owner !== undefined && !/^[a-f0-9]{64}$/.test(target.owner)) throw new Error('Invalid Docker memory owner');
  const query = new URLSearchParams({ threadId: target.threadId, itemId: target.itemId, ...(target.owner ? { owner: target.owner } : {}) });
  return `cheshi-source://message?${query}`;
}

export function flashSourceTarget(href: string): FlashSourceTarget | null {
  if (!href.startsWith('cheshi-source://message?')) return null;
  try {
    const url = new URL(href);
    const threadId = url.searchParams.get('threadId') ?? '';
    const itemId = url.searchParams.get('itemId') ?? '';
    const owner = url.searchParams.get('owner');
    const target = { threadId, itemId, ...(owner !== null ? { owner } : {}) };
    if (flashSourceHref(target) !== href) return null;
    return target;
  } catch { return null; }
}
