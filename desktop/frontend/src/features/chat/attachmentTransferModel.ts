import { MAX_IMPORTED_CHAT_ATTACHMENTS } from '../../../../shared/chat-attachment-import';
import type { CodexChatAttachment } from '../../cheshiDesktop';
import { readWorkspaceFileTransfer, WORKSPACE_FILE_TRANSFER_TYPE } from '../../shared/workspaceFileTransfer';

export function hasChatTransferFiles(data: Pick<DataTransfer, 'types'>): boolean {
  return data.types.includes('Files') || data.types.includes(WORKSPACE_FILE_TRANSFER_TYPE);
}

export function chatDroppedFiles(data: Pick<DataTransfer, 'types' | 'getData' | 'files' | 'items'>): (File | string)[] {
  return data.types.includes(WORKSPACE_FILE_TRANSFER_TYPE)
    ? readWorkspaceFileTransfer(data)
    : chatTransferFiles(data);
}

export function chatTransferFiles(data: Pick<DataTransfer, 'files' | 'items'>, imagesOnly = false): File[] {
  const files = Array.from(data.files);
  if (files.length === 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return imagesOnly ? files.filter((file) => file.type.startsWith('image/')) : files;
}

export function mergeChatAttachments(
  current: readonly CodexChatAttachment[],
  incoming: readonly CodexChatAttachment[],
): CodexChatAttachment[] {
  const merged = new Map(current.map((attachment) => [attachment.path, attachment]));
  for (const attachment of incoming) if (!merged.has(attachment.path)) merged.set(attachment.path, attachment);
  if (merged.size > MAX_IMPORTED_CHAT_ATTACHMENTS) {
    throw new TypeError(`Chat messages support up to ${MAX_IMPORTED_CHAT_ATTACHMENTS} attachments. Remove an attachment and try again.`);
  }
  return [...merged.values()];
}

export async function importChatTransferFiles(
  files: (File | string)[],
  options: {
    isCurrent: () => boolean;
    importFiles: (files: (File | string)[]) => Promise<CodexChatAttachment[]>;
    accept: (attachments: CodexChatAttachment[]) => void;
  },
): Promise<boolean> {
  if (!options.isCurrent() || files.length === 0) return false;
  if (files.length > MAX_IMPORTED_CHAT_ATTACHMENTS) {
    throw new TypeError(`Chat messages support up to ${MAX_IMPORTED_CHAT_ATTACHMENTS} attachments.`);
  }
  const attachments = await options.importFiles(files);
  if (!options.isCurrent()) return false;
  options.accept(attachments);
  return true;
}
