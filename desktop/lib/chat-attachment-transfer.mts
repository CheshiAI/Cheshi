import path from 'node:path';
import { MAX_CHAT_ATTACHMENT_BATCH_BYTES, MAX_CHAT_ATTACHMENT_BYTES, MAX_IMPORTED_CHAT_ATTACHMENTS,
  type ChatAttachmentTransfer } from '../shared/chat-attachment-import.ts';

export function validatedChatAttachmentTransfers(value: unknown): ChatAttachmentTransfer[] {
  if (!Array.isArray(value) || value.length > MAX_IMPORTED_CHAT_ATTACHMENTS) {
    throw new TypeError(`Chat messages support up to ${MAX_IMPORTED_CHAT_ATTACHMENTS} attachments.`);
  }
  let totalBytes = 0;
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Invalid attachment transfer.');
    if ('path' in item) {
      if (typeof item.path !== 'string' || !path.isAbsolute(item.path) || item.path.includes('\0')) {
        throw new TypeError('Chat attachment path must be absolute.');
      }
      if ('bytes' in item) throw new TypeError('Attachment transfer cannot contain both a path and bytes.');
      return { path: item.path };
    }
    if (!('name' in item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255
      || /[\\/\0]/.test(item.name) || item.name === '.' || item.name === '..') throw new TypeError('Invalid attachment filename.');
    if (!('mimeType' in item) || typeof item.mimeType !== 'string' || item.mimeType.length > 255) {
      throw new TypeError('Invalid attachment content type.');
    }
    if (!('bytes' in item) || !(item.bytes instanceof Uint8Array)) throw new TypeError('Attachment bytes must be a byte array.');
    if (item.bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES) throw new TypeError('Pasted attachments must be at most 50 MiB each.');
    totalBytes += item.bytes.byteLength;
    if (totalBytes > MAX_CHAT_ATTACHMENT_BATCH_BYTES) throw new TypeError('Pasted attachments must total at most 100 MiB.');
    const extension = imageExtension(item.bytes);
    const mimeType = item.mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
    const expected = imageMimeExtensions[mimeType];
    if (mimeType.startsWith('image/') && (!extension || expected !== extension)) {
      throw new TypeError('Attachment image content does not match its content type.');
    }
    const sourceExtension = path.extname(item.name).toLowerCase();
    if (!extension && imageFileExtensions.has(sourceExtension)) throw new TypeError('Attachment image content is invalid.');
    const name = extension ? `${path.basename(item.name, path.extname(item.name)) || 'pasted-image'}${extension}` : item.name;
    return { name, mimeType, bytes: item.bytes };
  });
}

const imageMimeExtensions: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/x-ms-bmp': '.bmp', 'image/tiff': '.tiff',
};
const imageFileExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

function imageExtension(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) => prefix.every((value, index) => bytes[index] === value);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return '.png';
  if (starts(255, 216, 255)) return '.jpg';
  if (starts(71, 73, 70, 56) && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97) return '.gif';
  if (starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return '.webp';
  if (starts(66, 77)) return '.bmp';
  if (starts(73, 73, 42, 0) || starts(77, 77, 0, 42)) return '.tiff';
  return null;
}
