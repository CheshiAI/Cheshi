export const AVATAR_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_IMAGE_ACCEPT = '.png,.jpg,.gif,.webp';
const formats = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;
type ImageMime = typeof formats[keyof typeof formats];

function imageMime(bytes: Uint8Array): ImageMime {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 45 && starts(137, 80, 78, 71, 13, 10, 26, 10)
    && text(12, 4) === 'IHDR' && text(bytes.length - 8, 4) === 'IEND') return 'image/png';
  if (bytes.length >= 4 && starts(255, 216, 255) && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(text(0, 6)) && bytes.at(-1) === 59) return 'image/gif';
  if (bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(text(12, 4))
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length) return 'image/webp';
  throw new TypeError('Invalid icon image. Choose a PNG, JPG, GIF or WebP image.');
}

/** Validate persisted/IPC data too; file extensions and MIME strings alone are not evidence. */
export function parseAvatarImage(value: unknown): string {
  if (typeof value !== 'string' || value.length > Math.ceil(AVATAR_IMAGE_MAX_BYTES / 3) * 4 + 40) {
    throw new TypeError('Icon images must be at most 2 MiB.');
  }
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0) throw new TypeError('Invalid icon image data.');
  const binary = atob(match[2]!);
  if (!binary.length || binary.length > AVATAR_IMAGE_MAX_BYTES || btoa(binary) !== match[2]) throw new TypeError('Invalid icon image data.');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (imageMime(bytes) !== match[1]) throw new TypeError('Icon image content does not match its format.');
  return value;
}

export async function readAvatarImage(file: Pick<File, 'name' | 'type' | 'size' | 'arrayBuffer'>): Promise<string> {
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (!extension || !Object.hasOwn(formats, extension)) throw new TypeError('Choose a PNG, JPG, GIF or WebP image.');
  const expected = formats[extension as keyof typeof formats];
  if (file.type && file.type !== expected) throw new TypeError('Icon image type does not match its extension.');
  if (!file.size || file.size > AVATAR_IMAGE_MAX_BYTES) throw new TypeError('Icon images must be at most 2 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return parseAvatarImage(`data:${expected};base64,${btoa(binary)}`);
}
