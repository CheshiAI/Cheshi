import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeBunMachO } from '../../scripts/normalize-bun-macho.mts';

const signatureOffset = 512;
const signatureSize = 128;
const fileEnd = signatureOffset + signatureSize;
const signatureCommand = 32 + 72 * 3;

function executable(tail = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(fileEnd);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x100000c, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(4, 16);
  bytes.writeUInt32LE(72 * 3 + 16, 20);
  for (const [index, name, offset, size] of [
    [0, '__TEXT', 0, 320], [1, '__BUN', 320, 64], [2, '__LINKEDIT', 384, 256],
  ] as const) {
    const start = 32 + index * 72;
    bytes.writeUInt32LE(0x19, start);
    bytes.writeUInt32LE(72, start + 4);
    bytes.write(name, start + 8, 'ascii');
    bytes.writeBigUInt64LE(BigInt(offset), start + 40);
    bytes.writeBigUInt64LE(BigInt(size), start + 48);
  }
  bytes.writeUInt32LE(0x1d, signatureCommand);
  bytes.writeUInt32LE(16, signatureCommand + 4);
  bytes.writeUInt32LE(signatureOffset, signatureCommand + 8);
  bytes.writeUInt32LE(signatureSize, signatureCommand + 12);
  bytes.fill(0x73, 320, 384); // Preserve the embedded Bun payload.
  bytes.writeUInt32BE(0xfade0cc0, signatureOffset);
  bytes.writeUInt32BE(signatureSize, signatureOffset + 4);
  bytes.writeUInt32BE(1, signatureOffset + 8);
  bytes.writeUInt32BE(0, signatureOffset + 12);
  bytes.writeUInt32BE(20, signatureOffset + 16);
  bytes.writeUInt32BE(0xfade0c02, signatureOffset + 20);
  bytes.writeUInt32BE(signatureSize - 20, signatureOffset + 24);
  return Buffer.concat([bytes, tail]);
}

async function withExecutable(bytes: Buffer, operation: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheshi-bun-macho-'));
  try {
    const filePath = path.join(directory, 'runtime');
    await writeFile(filePath, bytes, { mode: 0o755 });
    await operation(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function rejectsUnchanged(bytes: Buffer, message: RegExp): Promise<void> {
  await withExecutable(bytes, async filePath => {
    await assert.rejects(normalizeBunMachO(filePath), message);
    assert.deepEqual(await readFile(filePath), bytes);
  });
}

test('removes nonzero stale signature bytes without altering payload, signature, or executable mode', async () => {
  const bytes = executable(Buffer.from('0bc6057b3c04f76851d50524c057', 'hex'));
  await withExecutable(bytes, async filePath => {
    assert.equal(await normalizeBunMachO(filePath), 14);
    assert.deepEqual(await readFile(filePath), bytes.subarray(0, fileEnd));
    assert.equal((await stat(filePath)).mode & 0o777, 0o755);
    assert.equal(await normalizeBunMachO(filePath), 0);
  });
});

test('leaves a correctly bounded Bun executable unchanged', async () => {
  const bytes = executable();
  await withExecutable(bytes, async filePath => {
    assert.equal(await normalizeBunMachO(filePath), 0);
    assert.deepEqual(await readFile(filePath), bytes);
  });
});

test('rejects non Mach-O files and non-executable Mach-O files', async () => {
  await rejectsUnchanged(Buffer.from('ordinary data'), /thin little-endian/);
  const bytes = executable();
  bytes.writeUInt32LE(6, 12);
  await rejectsUnchanged(bytes, /MH_EXECUTE/);
});

test('rejects binaries without the compiled Bun segment', async () => {
  const bytes = executable(Buffer.from('tail'));
  bytes.fill(0, 32 + 72 + 8, 32 + 72 + 24);
  await rejectsUnchanged(bytes, /missing Bun segment/);
});

test('rejects truncated and malformed load commands', async () => {
  const bytes = executable(Buffer.from('tail'));
  bytes.writeUInt32LE(7, 36);
  await rejectsUnchanged(bytes, /load-command size/);
  await rejectsUnchanged(executable().subarray(0, 80), /load-command bounds/);
});

test('rejects a signature that does not end at the linkedit boundary', async () => {
  const bytes = executable(Buffer.from('tail'));
  bytes.writeBigUInt64LE(257n, 32 + 72 * 2 + 48);
  await rejectsUnchanged(bytes, /final __LINKEDIT/);
});

test('rejects file-backed segments overlapping the signature', async () => {
  const bytes = executable(Buffer.from('tail'));
  bytes.writeBigUInt64LE(321n, 32 + 72 + 48);
  await rejectsUnchanged(bytes, /file-backed data/);
});

test('rejects invalid superblob length and indexed blob bounds', async () => {
  const bytes = executable(Buffer.from('tail'));
  bytes.writeUInt32BE(signatureSize - 1, signatureOffset + 4);
  await rejectsUnchanged(bytes, /superblob/);
  bytes.writeUInt32BE(signatureSize, signatureOffset + 4);
  bytes.writeUInt32BE(signatureSize, signatureOffset + 16);
  await rejectsUnchanged(bytes, /blob offset/);
});

function withExtraCommand(command: number): Buffer {
  const bytes = executable(Buffer.from('tail'));
  bytes.writeUInt32LE(5, 16);
  bytes.writeUInt32LE(72 * 3 + 32, 20);
  const start = signatureCommand + 16;
  bytes.writeUInt32LE(command, start);
  bytes.writeUInt32LE(16, start + 4);
  return bytes;
}

test('rejects unknown load commands before removing any bytes', async () => {
  await rejectsUnchanged(withExtraCommand(0x77777777), /unsupported load command/);
});

test('rejects referenced linkedit payload that extends into the trailing bytes', async () => {
  const bytes = withExtraCommand(0x26);
  bytes.writeUInt32LE(fileEnd, signatureCommand + 16 + 8);
  bytes.writeUInt32LE(4, signatureCommand + 16 + 12);
  await rejectsUnchanged(bytes, /file-backed data/);
});
