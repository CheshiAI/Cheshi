import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  LOCAL_HISTORY_MAX_BYTES,
  LOCAL_HISTORY_RETENTION_DAYS,
} from '../shared/local-history.ts';
import type {
  LocalHistoryEntry,
  LocalHistoryReason,
  LocalHistorySnapshot,
} from '../shared/local-history.ts';
import { isGitMetadataPath, isRecordValue, normalizeRelativePath, WorkspaceRequestError } from './workspace-file-paths.mts';

interface StoredEntry extends LocalHistoryEntry {
  hash: string;
  hasBom: boolean;
  lineEnding: LocalHistorySnapshot['lineEnding'];
}

export interface LocalHistoryStoreOptions {
  directory: string;
  now?: () => number;
  retentionMs?: number;
  maxBytes?: number;
  maxEntries?: number;
}

export interface LocalHistoryCapture {
  path: string;
  content: string;
  hasBom: boolean;
  lineEnding: LocalHistorySnapshot['lineEnding'];
  reason: LocalHistoryReason;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REASONS = new Set<LocalHistoryReason>(['opened', 'saved', 'external', 'before-restore', 'restored']);

export function localHistoryPath(value: string): string {
  const normalized = normalizeRelativePath(value);
  if (!normalized || isGitMetadataPath(normalized)) {
    throw new WorkspaceRequestError('Local history requires a file outside Git metadata.', 400);
  }
  return normalized;
}

function publicEntry(entry: StoredEntry): LocalHistoryEntry {
  return { id: entry.id, path: entry.path, createdAt: entry.createdAt, reason: entry.reason, size: entry.size };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function assertManifest(value: unknown): asserts value is { version: 1; entries: StoredEntry[] } {
  const valid = isRecordValue(value) && value.version === 1 && Array.isArray(value.entries)
    && value.entries.every((entry: unknown) => isRecordValue(entry)
      && typeof entry.id === 'string' && ID_PATTERN.test(entry.id)
      && typeof entry.path === 'string' && localHistoryPath(entry.path) === entry.path
      && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
      && typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0
      && typeof entry.hash === 'string' && HASH_PATTERN.test(entry.hash)
      && typeof entry.hasBom === 'boolean'
      && (entry.lineEnding === 'lf' || entry.lineEnding === 'crlf' || entry.lineEnding === 'cr')
      && REASONS.has(entry.reason as LocalHistoryReason));
  if (!valid) throw new Error('Local history metadata is invalid; existing records were preserved.');
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

/** A single service owns each store; its operation queue serializes all mutations. */
export class LocalHistoryStore {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private entries: StoredEntry[] = [];
  private loaded = false;

  constructor(options: LocalHistoryStoreOptions) {
    this.directory = options.directory;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? LOCAL_HISTORY_RETENTION_DAYS * 86_400_000;
    this.maxBytes = options.maxBytes ?? LOCAL_HISTORY_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? 10_000;
    if (!path.isAbsolute(this.directory) || !Number.isFinite(this.retentionMs) || this.retentionMs < 0
      || !Number.isFinite(this.maxBytes) || this.maxBytes < 1
      || !Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('Local history storage options are invalid.');
    }
  }

  private manifestPath(): string { return path.join(this.directory, 'history.json'); }
  private blobPath(hash: string): string { return path.join(this.directory, `${hash}.txt`); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(this.manifestPath(), 'utf8'));
    } catch (error) {
      if (!isMissing(error)) throw error;
      manifest = { version: 1, entries: [] };
    }
    assertManifest(manifest);
    this.entries = manifest.entries;
    // Only committed manifest entries retain blobs. An interrupted capture may leave an orphan.
    await this.removeUnusedBlobs();
    this.loaded = true;
  }

  private retained(entries: StoredEntry[]): StoredEntry[] {
    const cutoff = this.now() - this.retentionMs;
    const retained = entries.filter((entry) => entry.createdAt >= cutoff);
    const references = new Map<string, number>();
    let bytes = 0;
    for (const entry of retained) {
      if (!references.has(entry.hash)) bytes += entry.size;
      references.set(entry.hash, (references.get(entry.hash) ?? 0) + 1);
    }
    // Include manifest overhead, including empty-file records, in the storage budget.
    let metadataBytes = Buffer.byteLength(JSON.stringify({ version: 1, entries: retained }), 'utf8');
    let start = 0;
    while (start < retained.length && (bytes + metadataBytes > this.maxBytes || retained.length - start > this.maxEntries)) {
      const entry = retained[start++]!;
      metadataBytes -= Buffer.byteLength(JSON.stringify(entry), 'utf8') + (retained.length - start > 0 ? 1 : 0);
      const count = references.get(entry.hash)! - 1;
      references.set(entry.hash, count);
      if (count === 0) bytes -= entry.size;
    }
    return retained.slice(start);
  }

  private async persist(entries: StoredEntry[]): Promise<void> {
    await atomicWrite(this.manifestPath(), JSON.stringify({ version: 1, entries }));
    this.entries = entries;
    await this.removeUnusedBlobs();
  }

  private async removeUnusedBlobs(): Promise<void> {
    const retainedHashes = new Set(this.entries.map((entry) => entry.hash));
    for (const name of await readdir(this.directory)) {
      const hash = name.endsWith('.txt') ? name.slice(0, -4) : '';
      if (HASH_PATTERN.test(hash) && !retainedHashes.has(hash)) {
        await unlink(path.join(this.directory, name));
      }
      if (/^(?:history\.json|[a-f0-9]{64}\.txt)\.[a-f0-9-]{36}\.tmp$/.test(name)) {
        await unlink(path.join(this.directory, name));
      }
    }
  }

  private async prune(): Promise<void> {
    const retained = this.retained(this.entries);
    if (retained.length !== this.entries.length) await this.persist(retained);
  }

  private newEntry(value: LocalHistoryCapture): StoredEntry {
    const bytes = value.hasBom ? `\uFEFF${value.content}` : value.content;
    return {
      id: randomUUID(), path: localHistoryPath(value.path), createdAt: this.now(), reason: value.reason,
      size: Buffer.byteLength(bytes, 'utf8'), hash: createHash('sha256').update(bytes, 'utf8').digest('hex'),
      hasBom: value.hasBom, lineEnding: value.lineEnding,
    };
  }

  private assertRetained(entries: StoredEntry[], ids: readonly string[]): void {
    if (ids.some((id) => !entries.some((entry) => entry.id === id))) {
      throw new Error('The file and its recovery version exceed the available local history storage budget.');
    }
  }

  async ensureCaptureFits(value: LocalHistoryCapture, protectedIds: readonly string[]): Promise<void> {
    await this.load();
    const entry = this.newEntry(value);
    this.assertRetained(this.retained([...this.entries, entry]), [...protectedIds, entry.id]);
  }

  async capture(value: LocalHistoryCapture, protectedIds: readonly string[] = []): Promise<LocalHistoryEntry> {
    const relativePath = localHistoryPath(value.path);
    await this.load();
    const bytes = value.hasBom ? `\uFEFF${value.content}` : value.content;
    const hash = createHash('sha256').update(bytes, 'utf8').digest('hex');
    const previous = [...this.entries].reverse().find((entry) => entry.path === relativePath);
    if (previous?.hash === hash && previous.lineEnding === value.lineEnding
      && previous.createdAt >= this.now() - this.retentionMs) {
      // A duplicate must still be durable before it can protect a subsequent restore.
      let existing: string | null = null;
      try { existing = await readFile(this.blobPath(hash), 'utf8'); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (existing !== bytes) await atomicWrite(this.blobPath(hash), bytes);
      if (value.reason === 'before-restore') {
        // Renew the same entry rather than duplicating identical content. It must survive
        // age and oldest-first quota pruning when the restored version is recorded next.
        const renewed = { ...previous, createdAt: this.now(), reason: value.reason };
        const retained = this.retained([...this.entries.filter((entry) => entry.id !== previous.id), renewed]);
        this.assertRetained(retained, [...protectedIds, renewed.id]);
        await this.persist(retained);
        return publicEntry(renewed);
      }
      await this.prune();
      this.assertRetained(this.entries, [...protectedIds, previous.id]);
      return publicEntry(previous);
    }
    const entry = this.newEntry(value);
    const retained = this.retained([...this.entries, entry]);
    this.assertRetained(retained, [...protectedIds, entry.id]);
    // Atomic replacement also repairs a damaged existing blob with the same content hash.
    await atomicWrite(this.blobPath(hash), bytes);
    await this.persist(retained);
    return publicEntry(entry);
  }

  async list(filePath: string): Promise<LocalHistoryEntry[]> {
    const normalized = localHistoryPath(filePath);
    await this.load();
    await this.prune();
    return this.entries.filter((entry) => entry.path === normalized).reverse().map(publicEntry);
  }

  async trackedPaths(): Promise<string[]> {
    await this.load();
    await this.prune();
    return [...new Set(this.entries.map((entry) => entry.path))];
  }

  async read(filePath: string, id: string): Promise<LocalHistorySnapshot> {
    const normalized = localHistoryPath(filePath);
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new WorkspaceRequestError('Local history entry ID is invalid.', 400);
    }
    await this.load();
    await this.prune();
    const entry = this.entries.find((candidate) => candidate.path === normalized && candidate.id === id);
    if (!entry) throw new WorkspaceRequestError('The local history entry is no longer available.', 404);
    const bytes = await readFile(this.blobPath(entry.hash), 'utf8');
    if (createHash('sha256').update(bytes, 'utf8').digest('hex') !== entry.hash) {
      throw new Error('Local history content is damaged; the current file was not changed.');
    }
    return {
      entry: publicEntry(entry), content: entry.hasBom ? bytes.slice(1) : bytes,
      hasBom: entry.hasBom, lineEnding: entry.lineEnding,
    };
  }
}
