import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent, nativeImage } from 'electron';
import { chatAttachmentKind } from './chat-attachment-store.mts';

export function createChatAttachmentImageReader(images: Pick<typeof nativeImage, 'createFromPath'>) {
  return (attachmentPath: unknown, thumbnail = false): string | null => {
    if (typeof attachmentPath !== 'string' || !attachmentPath.trim()
      || attachmentPath.includes('\0') || !path.isAbsolute(attachmentPath)) {
      throw new TypeError('Chat attachment path must be a valid absolute path.');
    }
    if (chatAttachmentKind(attachmentPath) !== 'image') return null;
    const source = images.createFromPath(attachmentPath);
    if (source.isEmpty()) return null;
    const { width, height } = source.getSize();
    if (width <= 0 || height <= 0) return null;
    const image = thumbnail && Math.max(width, height) > 160
      ? source.resize({ ...(width >= height ? { width: 160 } : { height: 160 }), quality: 'good' })
      : source;
    return image.toDataURL();
  };
}

export function registerChatAttachmentImageIpc(options: {
  ipc: Pick<IpcMain, 'handle'>;
  assertSender(event: IpcMainInvokeEvent): void;
  readImage: ReturnType<typeof createChatAttachmentImageReader>;
}) {
  for (const [channel, thumbnail] of [
    ['cheshi:get-codex-chat-attachment-preview', true],
    ['cheshi:get-codex-chat-attachment-image', false],
  ] as const) {
    options.ipc.handle(channel, (event, attachmentPath: unknown) => {
      options.assertSender(event);
      return options.readImage(attachmentPath, thumbnail);
    });
  }
}
