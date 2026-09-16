import type { AppleNotesReply } from '../shared/apple-notes.ts';

interface CacheEntry {
  value: AppleNotesReply<unknown>;
  expiresAt: number;
  bytes: number;
}

export interface AppleNotesCacheOptions {
  now?: () => number;
  ttlMs?: number;
  maxBytes?: number;
  maxEntries?: number;
}

// Keys include the action and all validated arguments, so each key has one
// result type. Values are copied at the boundary to keep callers isolated.
export class AppleNotesCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<AppleNotesReply<unknown>>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private bytes = 0;

  constructor(options: AppleNotesCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 128;
  }

  invalidate(matches: (key: string) => boolean = () => true): void {
    for (const key of this.entries.keys()) {
      if (matches(key)) this.remove(key);
    }
    for (const key of this.pending.keys()) {
      if (matches(key)) this.pending.delete(key);
    }
  }

  async read<T>(key: string, load: () => Promise<AppleNotesReply<T>>): Promise<AppleNotesReply<T>> {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(entryKey);
    }
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return structuredClone(cached.value) as AppleNotesReply<T>;
    }
    let request = this.pending.get(key);
    if (!request) {
      request = Promise.resolve().then(load).then(value => {
        if (value.ok === true && this.pending.get(key) === request) this.remember(key, value);
        return value;
      });
      this.pending.set(key, request);
    }
    try {
      return structuredClone(await request) as AppleNotesReply<T>;
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  private remember(key: string, value: AppleNotesReply<unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8') + Buffer.byteLength(key, 'utf8');
    if (bytes > this.maxBytes || this.maxEntries <= 0 || this.ttlMs <= 0) return;
    this.remove(key);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(key, { value: structuredClone(value), bytes, expiresAt: this.now() + this.ttlMs });
    this.bytes += bytes;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
