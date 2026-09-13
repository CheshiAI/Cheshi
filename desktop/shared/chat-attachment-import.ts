export const MAX_IMPORTED_CHAT_ATTACHMENTS = 20;
export const MAX_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_BATCH_BYTES = 100 * 1024 * 1024;

export type ChatAttachmentTransfer = { path: string } | { name: string; mimeType: string; bytes: Uint8Array };

export interface ChatAttachmentFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export async function prepareChatAttachmentTransfers(
  files: readonly (ChatAttachmentFile | string)[],
  getPathForFile: (file: ChatAttachmentFile) => string,
): Promise<ChatAttachmentTransfer[]> {
  if (!Array.isArray(files) || files.length > MAX_IMPORTED_CHAT_ATTACHMENTS) {
    throw new TypeError(`Chat messages support up to ${MAX_IMPORTED_CHAT_ATTACHMENTS} attachments.`);
  }
  let memoryBytes = 0;
  const sources = files.map((file) => {
    if (typeof file === 'string') {
      if (!file.trim() || file.includes('\0')) throw new TypeError('Invalid attachment path.');
      return { path: file };
    }
    if (!file || typeof file.name !== 'string' || typeof file.type !== 'string'
      || !Number.isSafeInteger(file.size) || file.size < 0) throw new TypeError('Invalid attachment file.');
    const sourcePath = getPathForFile(file);
    if (sourcePath) return { path: sourcePath };
    if (typeof file.arrayBuffer !== 'function') throw new TypeError('This attachment cannot be read.');
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) throw new TypeError('Pasted attachments must be at most 50 MiB each.');
    memoryBytes += file.size;
    if (memoryBytes > MAX_CHAT_ATTACHMENT_BATCH_BYTES) throw new TypeError('Pasted attachments must total at most 100 MiB.');
    return { file };
  });
  const transfers: ChatAttachmentTransfer[] = [];
  for (const source of sources) {
    if (source.path !== undefined) {
      transfers.push({ path: source.path });
      continue;
    }
    const { file } = source;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new TypeError('Attachment size changed while reading.');
    transfers.push({ name: file.name, mimeType: file.type, bytes });
  }
  return transfers;
}
