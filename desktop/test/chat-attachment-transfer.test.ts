import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatAttachmentStore } from '../lib/chat-attachment-store.mts';
import { validatedChatAttachmentTransfers } from '../lib/chat-attachment-transfer.mts';
import { MAX_CHAT_ATTACHMENT_BYTES, prepareChatAttachmentTransfers, type ChatAttachmentFile } from '../shared/chat-attachment-import';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'chat-transfer-'));
  roots.push(root);
  return { root, store: new ChatAttachmentStore({ directory: path.join(root, 'attachments') }) };
}

async function expectFailure(operation: () => Promise<unknown>, message?: string) {
  let error: unknown;
  try { await operation(); } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error);
  if (message !== undefined) expect((error as Error).message).toContain(message);
}

describe('clipboard and drop attachment storage', () => {
  test('stores pasted images durably with sniffed extensions and content deduplication', async () => {
    const { store } = await setup();
    const first = await store.importTransferredFiles([{ name: 'Screenshot', mimeType: 'image/png', bytes: png }]);
    const second = await store.importTransferredFiles([{ name: 'Other.png', mimeType: 'image/png', bytes: png }]);
    expect(first[0]?.kind).toBe('image');
    expect(first[0]?.name).toBe('Screenshot.png');
    expect(first[0]?.path).toBe(second[0]?.path);
    expect(first[0]?.path).toMatch(/[a-f0-9]{64}\.png$/);
    expect(new Uint8Array(await readFile(first[0]!.path))).toEqual(png);
    expect(await readdir(store.objectsDirectory)).toHaveLength(1);
  });

  test('imports dropped paths and pasted bytes together and rejects malformed batches before writes', async () => {
    const { root, store } = await setup();
    const source = path.join(root, 'notes.txt');
    await writeFile(source, 'notes');
    await expectFailure(() => store.importTransferredFiles([
      { path: source }, { name: '../bad.png', mimeType: 'image/png', bytes: png },
    ]), 'filename');
    expect(await readdir(root)).toEqual(['notes.txt']);
    const result = await store.importTransferredFiles([{ path: source }, { name: 'image.png', mimeType: 'image/png', bytes: png }]);
    expect(result.map((item) => item.kind)).toEqual(['file', 'image']);
    await rm(source);
    expect(await readFile(result[0]!.path, 'utf8')).toBe('notes');
  });

  test('rejects forged image types, invalid paths, invalid bytes and too many inputs', () => {
    expect(() => validatedChatAttachmentTransfers([{ name: 'x.jpg', mimeType: 'image/jpeg', bytes: png }])).toThrow('content type');
    expect(() => validatedChatAttachmentTransfers([{ name: 'x.png', mimeType: '', bytes: new Uint8Array([1]) }])).toThrow('image content');
    expect(() => validatedChatAttachmentTransfers([{ path: 'relative.txt' }])).toThrow('absolute');
    expect(() => validatedChatAttachmentTransfers([{ name: 'x', mimeType: '', bytes: [1, 2] }])).toThrow('byte array');
    expect(() => validatedChatAttachmentTransfers(Array.from({ length: 21 }, () => ({ path: '/tmp/x' })))).toThrow('20');
  });

  test('rejects oversized byte inputs at the main process boundary', () => {
    const oversized = new Uint8Array(MAX_CHAT_ATTACHMENT_BYTES + 1);
    expect(() => validatedChatAttachmentTransfers([{ name: 'data', mimeType: '', bytes: oversized }])).toThrow('50 MiB');
  });
});

describe('attachment transfer preparation', () => {
  test('prepares workspace paths mixed with native files without reading paths as File objects', async () => {
    const nativeFile: ChatAttachmentFile = { name: 'native.png', type: 'image/png', size: png.length,
      arrayBuffer: async () => { throw new Error('Native files must use their path.'); } };
    const resolvedFiles: ChatAttachmentFile[] = [];
    const sources = ['/workspace/resources/작업 image.png', nativeFile, '/workspace/notes.txt'] as const;
    expect(await prepareChatAttachmentTransfers(sources, (file) => {
      resolvedFiles.push(file);
      return '/external/native.png';
    })).toEqual([
      { path: '/workspace/resources/작업 image.png' },
      { path: '/external/native.png' },
      { path: '/workspace/notes.txt' },
    ]);
    expect(resolvedFiles).toEqual([nativeFile]);
  });

  test('rejects empty or NUL-containing workspace paths without calling the native file resolver', async () => {
    let pathLookups = 0;
    const getPathForFile = (_file: ChatAttachmentFile) => { pathLookups += 1; return '/native.png'; };
    for (const source of ['', '/workspace/bad\0image.png']) {
      await expectFailure(() => prepareChatAttachmentTransfers([source], getPathForFile));
    }
    expect(pathLookups).toBe(0);
  });

  test('applies the attachment count limit to mixed workspace paths and native files', async () => {
    const nativeFile: ChatAttachmentFile = { name: 'native.png', type: 'image/png', size: png.length,
      arrayBuffer: async () => { throw new Error('Native files must use their path.'); } };
    const workspacePaths = Array.from({ length: 19 }, (_, index) => `/workspace/${index}.txt`);
    let pathLookups = 0;
    const getPathForFile = (_file: ChatAttachmentFile) => { pathLookups += 1; return '/native.png'; };
    expect(await prepareChatAttachmentTransfers([...workspacePaths, nativeFile], getPathForFile)).toHaveLength(20);
    expect(pathLookups).toBe(1);
    await expectFailure(
      () => prepareChatAttachmentTransfers([...workspacePaths, nativeFile, '/workspace/overflow.txt'], getPathForFile),
      '20 attachments',
    );
    expect(pathLookups).toBe(1);
  });

  test('uses native file paths without reading bytes and serializes pathless clipboard files', async () => {
    let reads = 0;
    const file: ChatAttachmentFile = { name: 'image.png', type: 'image/png', size: png.length,
      arrayBuffer: async () => { reads += 1; return png.slice().buffer; } };
    expect(await prepareChatAttachmentTransfers([file], () => '/tmp/image.png')).toEqual([{ path: '/tmp/image.png' }]);
    expect(reads).toBe(0);
    expect(await prepareChatAttachmentTransfers([file], () => '')).toEqual([{ name: 'image.png', mimeType: 'image/png', bytes: png }]);
    expect(reads).toBe(1);
  });

  test('checks every memory file and total size before allocating any array buffers', async () => {
    let reads = 0;
    const file: ChatAttachmentFile = { name: 'large', type: '', size: MAX_CHAT_ATTACHMENT_BYTES,
      arrayBuffer: async () => { reads += 1; return new ArrayBuffer(0); } };
    await expectFailure(() => prepareChatAttachmentTransfers([file, { ...file, size: MAX_CHAT_ATTACHMENT_BYTES + 1 }], () => ''), '50 MiB');
    await expectFailure(() => prepareChatAttachmentTransfers([file, file, file], () => ''), '100 MiB');
    expect(reads).toBe(0);
  });

  test('rejects unsupported files and inconsistent byte lengths', async () => {
    const file: ChatAttachmentFile = { name: 'x', type: '', size: 1, arrayBuffer: async () => new ArrayBuffer(0) };
    await expectFailure(() => prepareChatAttachmentTransfers([file], () => ''), 'size changed');
    const malformed = { ...file, arrayBuffer: undefined } as unknown as ChatAttachmentFile;
    await expectFailure(() => prepareChatAttachmentTransfers([malformed], () => ''), 'cannot be read');
  });
});
