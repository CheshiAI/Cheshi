import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { assertChatImportNumbers, chatImportNumber, displayMessageWithChatImports, messageWithChatImports, parseChatImports,
  type ChatImportAttachment } from '../shared/chat-imports.ts';
import { temporaryChatDraft } from '../shared/temporary-chat.ts';
import { chatAttachments } from '../lib/codex-chat-values.mts';
import { addChatImports, insertChatImportText, removeChatImport } from '../frontend/src/features/chat/chatImportDraft';
import { createChatDraftRecovery, type ChatDraftSnapshot, type ChatSendResult } from '../frontend/src/features/chat/chatDraftRecovery';
import { createChatMessageQueue } from '../frontend/src/features/chat/chatMessageQueueStore';
import { createChatInputHistory } from '../frontend/src/features/chat/chatInputHistory';

const image: ChatImportAttachment = { kind: 'image', name: '화면.png', path: '/stored/image.png' };
const file: ChatImportAttachment = { kind: 'file', name: 'notes.txt', path: '/stored/notes.txt' };

describe('attachment references in drafts', () => {
  test('inserts references at the selection with Korean text and keeps the following text', () => {
    const draft = '이것을 여기에 적용';
    const result = addChatImports({ draft, attachments: [] }, [image, file], { start: 4, end: 7 });
    expect(result.draft).toBe('이것을 [import 1] [import 2] 적용');
    expect(result.draft.slice(result.caret!)).toBe(' 적용');
    expect(result.attachments.map(item => item.importNumber)).toEqual([1, 2]);
    expect(insertChatImportText('앞\n뒤', ['[import 3]'], { start: 2, end: 2 }).draft).toBe('앞\n[import 3] 뒤');
  });

  test('deduplicates stored paths and keeps remaining numbers after deletion and later imports', () => {
    const first = addChatImports({ draft: '', attachments: [] }, [image, file, image]);
    expect(first.draft).toBe('[import 1] [import 2]');
    expect(addChatImports(first, [image])).toMatchObject({ draft: first.draft, attachments: first.attachments, caret: null });
    const removed = removeChatImport({ ...first, draft: '[import 1]을 [import 2]처럼. [import 1] [import 10]' }, image.path);
    expect(removed.draft).toBe('을 [import 2]처럼.  [import 10]');
    expect(removed.attachments).toEqual([{ ...file, importNumber: 2 }]);
    const later = addChatImports(removed, [{ ...image, importNumber: 2 }]);
    expect(later.attachments.map(item => item.importNumber)).toEqual([2, 11]);
    expect(later.draft).toEndWith('[import 11]');
  });

  test('does not mutate the draft on cancellation or a failed capacity check', () => {
    const draft = { draft: 'keep', attachments: Array.from({ length: 20 }, (_, i) => ({ ...file, path: `/stored/${i}`, importNumber: i + 1 })) };
    expect(addChatImports(draft, [])).toMatchObject(draft);
    expect(() => addChatImports(draft, [image])).toThrow('20 attachments');
    expect(draft.draft).toBe('keep');
    expect(draft.attachments).toHaveLength(20);
  });
});

describe('durable import mapping', () => {
  const attachments = [{ ...file, importNumber: 1 }, { ...image, importNumber: 3 }];
  test('keeps file and image numbering independent from the model image order', () => {
    const text = '[import 3]을 [import 1]에 맞춰줘';
    const prompt = messageWithChatImports(text, attachments);
    expect(prompt).toContain('"label":"[import 3]"');
    expect(prompt).toContain('"imageNumber":1');
    expect(parseChatImports(displayMessageWithChatImports(text, attachments))).toEqual({ text, imports: attachments });
    expect(parseChatImports(prompt)?.imports[0]?.path).toBe(file.path);
    expect(parseChatImports(displayMessageWithChatImports(text, [...attachments, { ...image, path: '/stored/legacy.png' }]))?.text)
      .toBe(`${text}\n\n[Image: /stored/legacy.png]`);
  });

  test('leaves legacy messages unchanged and refuses malformed or unsafe metadata', () => {
    expect(messageWithChatImports('Read', [file, image])).toBe('Read\n\nAttached files:\n- "/stored/notes.txt"');
    expect(parseChatImports('ordinary [import 1]')).toBeNull();
    const valid = messageWithChatImports('Read', attachments);
    expect(parseChatImports(valid.replace('"importNumber":3', '"importNumber":1'))).toBeNull();
    expect(parseChatImports(valid.replace(image.path, 'javascript:alert(1)'))).toBeNull();
    expect(parseChatImports(valid.replace('</cheshi-imports-v1>', 'broken'))).toBeNull();
    expect(parseChatImports(`${valid}\nkeep this visible`)).toBeNull();
    for (const value of [0, -1, 1.5, '1', true, null, Infinity, 1_000_001]) {
      expect(() => chatImportNumber(value)).toThrow();
    }
    expect(() => assertChatImportNumbers([{ ...file, importNumber: 1 }, { ...image, importNumber: 1 }])).toThrow('unique');
  });

  test('retains references in service and temporary-chat boundaries', () => {
    expect(chatAttachments(attachments)).toEqual(attachments);
    expect(temporaryChatDraft({ text: '[import 3]', attachments })).toEqual({ text: '[import 3]', attachments });
    expect(() => chatAttachments([{ ...image, importNumber: '1' }])).toThrow();
    expect(() => temporaryChatDraft({ text: 'Read', attachments: [...attachments, attachments[0]] })).toThrow('unique');
  });

  test('restores visible input and its attachments together from history', () => {
    const history = createChatInputHistory();
    history.open('thread', [{ id: 'message', kind: 'user', createdAt: 1,
      text: displayMessageWithChatImports('[import 3]을 [import 1]처럼', attachments) }]);
    expect(history.getSnapshot().entries[0]?.text).toBe('[import 3]을 [import 1]처럼');
    expect(history.takeEntry('thread')).toEqual({ id: 'message', text: '[import 3]을 [import 1]처럼', attachments });
    expect(history.takeEntry('thread')).toBeNull();
  });
});

test('the actual workspace IPC validator preserves numbers and rejects duplicates before storage', () => {
  const source = ts.createSourceFile('workspace-runtime.mts', readFileSync(new URL('../workspace-runtime.mts', import.meta.url), 'utf8'), ts.ScriptTarget.ESNext, true);
  const functions: string[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && ['assertRecord', 'chatMessageRequest'].includes(node.name?.text ?? '')) functions.push(node.getText(source));
    else ts.forEachChild(node, collect);
  };
  collect(source);
  expect(functions).toHaveLength(2);
  const compiled = ts.transpileModule(functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  const validate = vm.runInNewContext(`${compiled}\nchatMessageRequest`, { path, MAX_CHAT_ATTACHMENTS: 20,
    assertChatImportNumbers, chatImportNumber }) as (value: unknown) => { attachments: ChatImportAttachment[] };
  const request = { text: '[import 2]', clientMessageId: 'client', attachments: [{ ...image, importNumber: 2 }] };
  expect(validate(request).attachments).toEqual(request.attachments);
  expect(() => validate({ ...request, attachments: [request.attachments[0], { ...file, importNumber: 2 }] })).toThrow('unique');
  expect(() => validate({ ...request, attachments: [{ ...image, path: 'relative.png', importNumber: 2 }] })).toThrow('absolute');
});

test('failed sends and queue handoffs keep reference identity without overwriting newer edits', async () => {
  let resolve!: (result: ChatSendResult) => void;
  const completion = new Promise<ChatSendResult>(done => { resolve = done; });
  const store = createChatDraftRecovery(() => completion);
  const original = { ...addChatImports({ draft: 'Compare', attachments: [] }, [image, file]), selectedSkill: null };
  store.editInput(() => original);
  const sending = store.submit();
  store.editInput(input => ({ ...input, ...addChatImports(input, [{ ...file, path: '/stored/new.txt' }]) }));
  resolve({ status: 'failed' });
  await sending;
  expect(store.getSnapshot().attachments[0]?.path).toBe('/stored/new.txt');
  expect(store.getSnapshot().recovery?.input.attachments).toEqual(original.attachments);
  store.editInput(() => ({ draft: '', attachments: [], selectedSkill: null }));
  expect(store.restore()).toBe(true);

  const delivered: ChatDraftSnapshot[] = [];
  const queue = createChatMessageQueue(async input => { delivered.push(input); return { status: 'accepted' }; });
  queue.setContext({ threadId: 'thread', responding: true, blocked: false });
  expect(store.transfer(queue.enqueue)).toBe(true);
  expect(store.getSnapshot().attachments).toEqual([]);
  const queued = queue.getSnapshot().entries[0]!;
  expect(queued.input).toMatchObject({ draft: original.draft, attachments: original.attachments });
  expect(await queue.steer(queued.id)).toBe(true);
  expect(delivered[0]).toMatchObject({ draft: original.draft, attachments: original.attachments });
});

test('the new shared dependency loads under native Node strip-only execution', () => {
  const root = new URL('../../', import.meta.url);
  const result = spawnSync('node', ['--input-type=module', '-e',
    "await import('./desktop/lib/codex-chat-values.mts'); await import('./desktop/lib/chat-attachment-store.mts'); await import('./desktop/shared/temporary-chat.ts')"],
  { cwd: root, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
