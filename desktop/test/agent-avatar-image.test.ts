import { expect, test } from 'bun:test';
import { AVATAR_IMAGE_MAX_BYTES, parseAvatarImage, readAvatarImage } from '../shared/agent-avatar-image';
import { parseAgentAvatar } from '../shared/agent-avatar';
import { avatarFile, avatarGif, avatarPng } from './agent-avatar-image-fixtures';

async function rejected(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(String(failure)).toContain(message);
}

test('PNG and GIF bytes survive file import and persistent avatar parsing unchanged', async () => {
  for (const [source, name] of [[avatarPng, 'icon.PNG'], [avatarGif, 'icon.gif']] as const) {
    expect(await readAvatarImage(avatarFile(source, name))).toBe(source);
    expect(parseAvatarImage(source)).toBe(source);
    expect(parseAgentAvatar({ character: 'sprout', color: 'mint', image: source }).image).toBe(source);
  }
});
test('JPG and WebP envelopes require their own signatures and lengths', () => {
  const jpg = `data:image/jpeg;base64,${btoa(String.fromCharCode(255, 216, 255, 224, 0, 2, 255, 217))}`;
  expect(parseAvatarImage(jpg)).toBe(jpg);
  const bytes = new Uint8Array(24);
  bytes.set(new TextEncoder().encode('RIFF'), 0); new DataView(bytes.buffer).setUint32(4, 16, true);
  bytes.set(new TextEncoder().encode('WEBPVP8 '), 8);
  const webp = `data:image/webp;base64,${btoa(String.fromCharCode(...bytes))}`;
  expect(parseAvatarImage(webp)).toBe(webp);
  bytes[4] = 15;
  expect(() => parseAvatarImage(`data:image/webp;base64,${btoa(String.fromCharCode(...bytes))}`)).toThrow('image');
});
test('unsupported extensions, renamed SVG, MIME mismatches and oversized files are rejected', async () => {
  for (const name of ['icon.svg', 'icon.jpeg', 'icon.bmp', 'icon.png.svg']) await rejected(readAvatarImage(avatarFile(avatarPng, name)), 'Choose');
  await rejected(readAvatarImage(new File(['<svg/>'], 'icon.png', { type: 'image/png' })), 'image');
  await rejected(readAvatarImage(avatarFile(avatarGif, 'icon.png')), 'extension');
  await rejected(readAvatarImage(new File([new Uint8Array(AVATAR_IMAGE_MAX_BYTES + 1)], 'icon.png', { type: 'image/png' })), '2 MiB');
  await rejected(readAvatarImage(new File([], 'icon.png', { type: 'image/png' })), '2 MiB');
});
test('IPC/persisted image validation rejects external URLs, unsupported MIME and malformed data', () => {
  for (const value of [null, 'https://example.test/icon.png', 'file:///tmp/icon.png',
    'data:image/svg+xml;base64,PHN2Zy8+', avatarPng.replace('image/png', 'image/jpeg'),
    avatarPng + '\n', avatarPng.slice(0, -8), 'data:image/png;base64,invalid',
    'data:image/png;base64,' + 'A'.repeat(AVATAR_IMAGE_MAX_BYTES * 2)]) {
    expect(() => parseAvatarImage(value)).toThrow();
    expect(() => parseAgentAvatar({ character: 'sprout', color: 'mint', image: value })).toThrow();
  }
});
