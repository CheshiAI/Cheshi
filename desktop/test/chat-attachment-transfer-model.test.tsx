import { describe, expect, test } from 'bun:test';
import { chatDroppedFiles, chatTransferFiles, hasChatTransferFiles, importChatTransferFiles, mergeChatAttachments } from '../frontend/src/features/chat/attachmentTransferModel';
import type { CodexChatAttachment } from '../frontend/src/cheshiDesktop';
import { readWorkspaceFileTransfer, WORKSPACE_FILE_TRANSFER_TYPE, writeWorkspaceFileTransfer } from '../frontend/src/shared/workspaceFileTransfer';

const attachment: CodexChatAttachment = { kind: 'image', name: 'image.png', path: '/saved/image.png' };

function dataTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: 'uninitialized' as DataTransfer['effectAllowed'],
    get types() { return [...values.keys()]; },
    setData(type: string, value: string) { values.set(type, value); },
    getData(type: string) { return values.get(type) ?? ''; },
  };
}

describe('chat pasted and dropped files', () => {
  test('explorer drag preserves the full image path and offers a copy attachment', async () => {
    const data = dataTransfer();
    const path = '/workspace/resources/스크린 샷 #1.png';
    writeWorkspaceFileTransfer(data, path);
    expect(data.effectAllowed).toBe('copy');
    expect(hasChatTransferFiles(data)).toBe(true);
    expect(readWorkspaceFileTransfer(data)).toEqual([path]);
    const imported: (File | string)[][] = [];
    const accepted: CodexChatAttachment[][] = [];
    expect(await importChatTransferFiles(readWorkspaceFileTransfer(data), {
      isCurrent: () => true,
      importFiles: async (files) => { imported.push(files); return [attachment]; },
      accept: (attachments) => accepted.push(attachments),
    })).toBe(true);
    expect(imported).toEqual([[path]]);
    expect(accepted).toEqual([[attachment]]);
  });

  test('ordinary dragged text is not treated as a workspace attachment', () => {
    const data = dataTransfer();
    data.setData('text/plain', '/workspace/resources/image.png');
    expect(hasChatTransferFiles(data)).toBe(false);
    expect(readWorkspaceFileTransfer(data)).toEqual([]);
  });

  test('malformed internal transfers are ignored', () => {
    const data = dataTransfer();
    for (const payload of ['{', '{}', 'null', '[42]', '[""]', '[" "]', JSON.stringify(['/workspace/invalid\0.png'])]) {
      data.setData(WORKSPACE_FILE_TRANSFER_TYPE, payload);
      expect(readWorkspaceFileTransfer(data)).toEqual([]);
    }
  });

  test('clipboard image selection preserves ordinary text and filters non-image files', () => {
    const image = new File(['x'], 'shot.png', { type: 'image/png' });
    const text = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const transfer = (files: File[]) => ({ files, items: [] }) as unknown as Pick<DataTransfer, 'files' | 'items'>;
    expect(chatTransferFiles(transfer([]), true)).toEqual([]);
    expect(chatTransferFiles(transfer([image, text]), true)).toEqual([image]);
    expect(chatTransferFiles(transfer([image, text]))).toEqual([image, text]);
    const externalDrop = { ...transfer([image, text]), types: ['Files'], getData: (_type: string) => '' };
    expect(hasChatTransferFiles(externalDrop)).toBe(true);
    expect(chatDroppedFiles(externalDrop)).toEqual([image, text]);
    const internalData = dataTransfer();
    writeWorkspaceFileTransfer(internalData, '/workspace/image.png');
    expect(chatDroppedFiles({ ...transfer([]), ...internalData })).toEqual(['/workspace/image.png']);
  });

  test('deduplicates content paths before checking capacity and rejects overflow without discarding', () => {
    const existing = Array.from({ length: 20 }, (_, index) => ({ ...attachment, path: `/saved/${index}.png` }));
    expect(mergeChatAttachments(existing, [existing[0]!, existing[0]!])).toEqual(existing);
    expect(() => mergeChatAttachments(existing, [attachment])).toThrow('20 attachments');
    expect(existing).toHaveLength(20);
  });

  test('does not add late results after the session changes', async () => {
    let resolve!: (attachments: CodexChatAttachment[]) => void;
    const gate = new Promise<CodexChatAttachment[]>((complete) => { resolve = complete; });
    let current = true;
    const accepted: CodexChatAttachment[][] = [];
    const operation = importChatTransferFiles([new File(['x'], 'shot.png')], {
      isCurrent: () => current, importFiles: async () => gate, accept: (attachments) => accepted.push(attachments),
    });
    current = false;
    resolve([attachment]);
    expect(await operation).toBe(false);
    expect(accepted).toEqual([]);
  });

  test('imports and accepts the complete current batch', async () => {
    const accepted: CodexChatAttachment[][] = [];
    expect(await importChatTransferFiles([new File(['x'], 'shot.png')], {
      isCurrent: () => true, importFiles: async () => [attachment], accept: (attachments) => accepted.push(attachments),
    })).toBe(true);
    expect(accepted).toEqual([[attachment]]);
  });
});
