import { expect, test } from 'bun:test';
import { addChatDroppedItems } from '../frontend/src/features/chat/chatImportDraft';
import { importChatTransferFiles } from '../frontend/src/features/chat/attachmentTransferModel';
import { localPathMarkdown } from '../shared/local-file-link';
import type { CodexChatAttachment } from '../frontend/src/cheshiDesktop';
import type { ChatDirectoryReference, ChatTransferItem } from '../shared/chat-attachment-import';

const folder: ChatDirectoryReference = { kind: 'directory', name: 'folder', path: '/tmp/한글 folder #1' };
const image: CodexChatAttachment = { kind: 'image', name: 'image.png', path: '/saved/image.png' };

test('a folder drop replaces the selection with a path link without an import number', () => {
  const result = addChatDroppedItems({ draft: '앞 선택 뒤', attachments: [] }, [], [folder, folder], { start: 2, end: 4 });
  expect(result.draft).toBe(`앞 ${localPathMarkdown(folder.path)} 뒤`);
  expect(result.attachments).toEqual([]);
  expect(result.draft).not.toContain('[import');
  expect(result.caret).toBe(result.draft.length - 2);
});

test('mixed drops add image imports and folder links in one draft update', async () => {
  let result = { draft: '여기에', attachments: [] as CodexChatAttachment[] };
  let updates = 0;
  await importChatTransferFiles([folder.path, image.path], {
    isCurrent: () => true, importFiles: async () => [folder, image],
    accept: (attachments, directories) => { updates++; result = addChatDroppedItems(result, attachments, directories); },
  });
  expect(updates).toBe(1);
  expect(result.draft).toBe(`여기에 [import 1] ${localPathMarkdown(folder.path)}`);
  expect(result.attachments).toEqual([{ ...image, importNumber: 1 }]);
});

test('late folder results cannot insert into a different session', async () => {
  let current = true, acceptCount = 0;
  const imported: ChatTransferItem<CodexChatAttachment>[] = [folder];
  const result = await importChatTransferFiles([folder.path], {
    isCurrent: () => current, importFiles: async () => { current = false; return imported; },
    accept: () => { acceptCount++; },
  });
  expect(result).toBe(false);
  expect(acceptCount).toBe(0);
});
