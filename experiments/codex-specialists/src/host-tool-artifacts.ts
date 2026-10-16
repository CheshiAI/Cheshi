import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, type JsonRecord } from './protocol.ts';

export const HOST_IMAGE_BYTES = 4 * 1024 * 1024;
export const HOST_EXCHANGE_BYTES = 6 * 1024 * 1024;
export interface HostImage { name: string; base64: string; sha256: string }
export interface HostToolResult { hostToolProtocol: 1; data: unknown; images: HostImage[] }
const imagesForOutput = new WeakMap<object, string[]>();
export const imageDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Validate bounded, non-interlaced 8-bit PNG evidence, including its compressed pixels. */
export function validateHostPng(bytes: Buffer) {
  if (bytes.length > HOST_IMAGE_BYTES || bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Invalid PNG evidence.');
  let offset = 8, width = 0, height = 0, channels = 0, ended = false;
  const chunks: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated PNG evidence.');
    const type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, end - 4);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, end - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) throw new Error('PNG checksum mismatch.');
    if (offset === 8 && type !== 'IHDR') throw new Error('Missing PNG header.');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error('Invalid PNG header.');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[data[9]!] ?? 0;
      if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000 || !channels
        || data[8] !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('Unsupported PNG dimensions or encoding.');
    } else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') { if (length || end !== bytes.length) throw new Error('Invalid PNG ending.'); ended = true; }
    else if (type[0] === type[0]!.toUpperCase() && type !== 'PLTE') throw new Error('Unsupported PNG chunk.');
    offset = end;
  }
  if (!ended || !chunks.length) throw new Error('Incomplete PNG evidence.');
  const stride = width * channels + 1, expected = stride * height;
  const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  if (pixels.length !== expected) throw new Error('Invalid PNG pixel data.');
  for (let row = 0; row < height; row++) if (pixels[row * stride]! > 4) throw new Error('Invalid PNG filter.');
  return { width, height };
}

export async function receiveHostToolResult(value: unknown, signal: AbortSignal): Promise<JsonRecord> {
  const envelope = record(value);
  if (envelope.hostToolProtocol !== 1 || !Array.isArray(envelope.images) || envelope.images.length > 1
    || JSON.stringify(value).length > HOST_EXCHANGE_BYTES) throw new Error('Invalid host tool result.');
  const validated = envelope.images.map(raw => {
    const image = record(raw);
    if (typeof image.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}\.png$/.test(image.name)
      || typeof image.base64 !== 'string' || image.base64.length > Math.ceil(HOST_IMAGE_BYTES / 3) * 4) throw new Error('Invalid host image.');
    const bytes = Buffer.from(image.base64, 'base64');
    if (bytes.toString('base64') !== image.base64 || imageDigest(bytes) !== image.sha256) throw new Error('Host image hash mismatch.');
    return { name: image.name, bytes, sha256: image.sha256, ...validateHostPng(bytes) };
  });
  signal.throwIfAborted();
  const directory = validated.length ? await mkdtemp(join(tmpdir(), 'homie-evidence-')) : null;
  try {
    const artifacts = [];
    for (const image of validated) {
      const path = join(directory!, image.name);
      await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600 });
      artifacts.push({ path, sha256: image.sha256, width: image.width, height: image.height });
    }
    signal.throwIfAborted();
    const output = { result: envelope.data, artifacts };
    imagesForOutput.set(output, validated.map(image => `data:image/png;base64,${image.bytes.toString('base64')}`));
    return output;
  } catch (error) { if (directory) await rm(directory, { recursive: true, force: true }); throw error; }
}

export function toolResponseContent(output: JsonRecord) {
  return [{ type: 'inputText', text: JSON.stringify(output) },
    ...(imagesForOutput.get(output) ?? []).map(imageUrl => ({ type: 'inputImage', imageUrl }))];
}

/** Read incrementally, so a large HTTP body cannot allocate unbounded memory. */
export async function readHostExchange(request: Request) {
  if (!request.body) throw new Error('Missing tool exchange.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > HOST_EXCHANGE_BYTES) throw new Error('Tool exchange exceeds 6 MiB.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel(); reader.releaseLock(); }
}
