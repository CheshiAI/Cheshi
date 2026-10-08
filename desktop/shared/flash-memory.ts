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

export interface FlashSourceTarget { threadId: string; itemId: string }

const sourceIdPattern = /^[a-zA-Z0-9_-]{1,1024}$/;

/** Internal navigation only; never pass this URL to the operating system. */
export function flashSourceHref(target: FlashSourceTarget): string {
  if (!sourceIdPattern.test(target.threadId) || !sourceIdPattern.test(target.itemId)) {
    throw new Error('Invalid conversation source target');
  }
  const query = new URLSearchParams({ threadId: target.threadId, itemId: target.itemId });
  return `cheshi-source://message?${query}`;
}

export function flashSourceTarget(href: string): FlashSourceTarget | null {
  if (!href.startsWith('cheshi-source://message?')) return null;
  try {
    const url = new URL(href);
    const threadId = url.searchParams.get('threadId') ?? '';
    const itemId = url.searchParams.get('itemId') ?? '';
    const target = { threadId, itemId };
    if (flashSourceHref(target) !== href) return null;
    return target;
  } catch { return null; }
}
