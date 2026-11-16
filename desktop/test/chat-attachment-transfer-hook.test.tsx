import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { ClipboardEvent, DragEvent } from 'react';
import * as attachmentModel from '../frontend/src/features/chat/attachmentTransferModel';
import * as errorModel from '../frontend/src/shared/errorMessage';
import { WORKSPACE_FILE_TRANSFER_TYPE } from '../frontend/src/shared/workspaceFileTransfer';
import type { useChatAttachmentTransfer } from '../frontend/src/features/chat/useChatAttachmentTransfer';
import type { CodexChatAttachment } from '../frontend/src/cheshiDesktop';

type Options = Parameters<typeof useChatAttachmentTransfer>[0];
type Transfer = ReturnType<typeof useChatAttachmentTransfer>;
const attachment: CodexChatAttachment = { kind: 'image', name: 'image.png', path: '/saved/image.png' };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function createHarness(importFiles: Options['importFiles'] = async () => [attachment]) {
  const slots: unknown[] = [];
  let cursor = 0;
  const accepted: CodexChatAttachment[][] = [];
  const imports: (File | string)[][] = [];
  const options: Options = {
    scopeKey: 'first', disabled: false, attachments: [], captureTask: () => () => true,
    importFiles: (files) => { imports.push(files); return importFiles(files); },
    addAttachments: (files) => { accepted.push(files); },
  };
  const modules: Record<string, unknown> = {
    react: {
      useRef(current: unknown) { return slots[cursor++] ??= { current }; },
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value: unknown) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        }];
      },
      useEffect() {},
      useCallback(callback: unknown) { return callback; },
    },
    './attachmentTransferModel': attachmentModel,
    '../../shared/errorMessage': errorModel,
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/useChatAttachmentTransfer.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected hook dependency: ${name}`);
    return modules[name];
  } });
  const hook = exports.useChatAttachmentTransfer;
  if (typeof hook !== 'function') throw new Error('Attachment transfer hook is unavailable.');
  return {
    accepted, imports,
    render(patch: Partial<Options> = {}): Transfer {
      Object.assign(options, patch);
      cursor = 0;
      return hook({ ...options }) as Transfer;
    },
  };
}

function drag(types: string[], payload = '', files: File[] = []) {
  const state = { prevented: false, stopped: false };
  const dataTransfer = { types, files, items: [], dropEffect: 'none', getData: (_type: string) => payload };
  const event = { dataTransfer,
    preventDefault() { state.prevented = true; }, stopPropagation() { state.stopped = true; },
  } as unknown as DragEvent<HTMLElement>;
  return { event, state, dataTransfer };
}

const flushTransfers = () => new Promise<void>((resolve) => { setImmediate(resolve); });

describe('chat attachment drop callbacks', () => {
  test('drops select a visible inactive pane without enabling its paste handler', async () => {
    const harness = createHarness();
    let selections = 0;
    const transfer = harness.render({ inactive: true, visible: true, onFileDrop: () => { selections++; } });
    const file = new File(['image'], 'external.png', { type: 'image/png' });
    transfer.onPaste({ clipboardData: { files: [file], items: [] }, preventDefault() {} } as unknown as ClipboardEvent<HTMLElement>);
    expect(harness.imports).toEqual([]);
    const incoming = drag(['Files'], '', [file]);
    transfer.onDragOver(incoming.event);
    expect(incoming.dataTransfer.dropEffect).toBe('copy');
    transfer.onDrop(incoming.event);
    await flushTransfers();
    expect(selections).toBe(1);
    expect(harness.imports).toEqual([[file]]);
    expect(harness.accepted).toEqual([[attachment]]);
  });

  test('a pending drop stays with its pane after selection changes and imports only once', async () => {
    const pending = createDeferred<CodexChatAttachment[]>();
    const first = createHarness();
    const second = createHarness(async () => pending.promise);
    let selected = 'first';
    let focused = 0;
    first.render({ inactive: false, visible: true });
    const transfer = second.render({ inactive: true, visible: true,
      onFileDrop: () => { selected = 'second'; }, onComplete: () => { focused++; } });
    const incoming = drag([WORKSPACE_FILE_TRANSFER_TYPE], JSON.stringify(['/workspace/image.png']));
    transfer.onDrop(incoming.event);
    expect(selected).toBe('second');
    second.render({ inactive: false });
    transfer.onDrop(incoming.event);
    selected = 'first';
    second.render({ inactive: true });
    pending.resolve([attachment]);
    await flushTransfers();
    expect(first.imports).toEqual([]);
    expect(first.accepted).toEqual([]);
    expect(second.imports).toHaveLength(1);
    expect(second.accepted).toEqual([[attachment]]);
    expect(selected).toBe('first');
    expect(focused).toBe(0);
  });

  test('hidden, locked, text and empty drops do not select a pane', async () => {
    const harness = createHarness();
    let selections = 0;
    const onFileDrop = () => { selections++; };
    for (const options of [{ visible: false, disabled: false }, { visible: true, disabled: true }]) {
      const transfer = harness.render({ ...options, onFileDrop });
      const incoming = drag([WORKSPACE_FILE_TRANSFER_TYPE], JSON.stringify(['/workspace/image.png']));
      transfer.onDragOver(incoming.event);
      expect(incoming.dataTransfer.dropEffect).toBe('none');
      transfer.onDrop(incoming.event);
    }
    const transfer = harness.render({ visible: true, disabled: false });
    transfer.onDrop(drag(['text/plain'], 'text').event);
    transfer.onDrop(drag(['Files']).event);
    await flushTransfers();
    expect(selections).toBe(0);
    expect(harness.imports).toEqual([]);
  });

  test('accepts workspace paths and prevents text insertion and propagation', async () => {
    const harness = createHarness();
    const transfer = harness.render();
    const incoming = drag([WORKSPACE_FILE_TRANSFER_TYPE], JSON.stringify(['/workspace/image.png']));
    transfer.onDragOver(incoming.event);
    expect(incoming.state.prevented).toBe(true);
    expect(incoming.dataTransfer.dropEffect).toBe('copy');
    incoming.state.prevented = false;
    transfer.onDrop(incoming.event);
    expect(incoming.state).toEqual({ prevented: true, stopped: true });
    await flushTransfers();
    expect(harness.imports).toEqual([['/workspace/image.png']]);
    expect(harness.accepted).toEqual([[attachment]]);
  });

  test('continues importing external files and leaves ordinary text drops alone', async () => {
    const harness = createHarness();
    const transfer = harness.render();
    const text = drag(['text/plain'], '/workspace/image.png');
    transfer.onDragOver(text.event);
    transfer.onDrop(text.event);
    expect(text.state).toEqual({ prevented: false, stopped: false });
    expect(harness.imports).toEqual([]);
    const file = new File(['image'], 'external.png', { type: 'image/png' });
    const incoming = drag(['Files'], '', [file]);
    transfer.onDragOver(incoming.event);
    expect(incoming.dataTransfer.dropEffect).toBe('copy');
    transfer.onDrop(incoming.event);
    await flushTransfers();
    expect(harness.imports).toEqual([[file]]);
    expect(harness.accepted).toEqual([[attachment]]);
  });

  test('refuses disabled drops and concurrent imports while a batch is pending', async () => {
    const pending = createDeferred<CodexChatAttachment[]>();
    const harness = createHarness(async () => pending.promise);
    let transfer = harness.render({ disabled: true });
    const incoming = drag([WORKSPACE_FILE_TRANSFER_TYPE], JSON.stringify(['/workspace/image.png']));
    transfer.onDragOver(incoming.event);
    expect(incoming.dataTransfer.dropEffect).toBe('none');
    transfer.onDrop(incoming.event);
    expect(harness.imports).toEqual([]);
    transfer = harness.render({ disabled: false });
    transfer.onDrop(incoming.event);
    expect(transfer.isTransferring()).toBe(true);
    transfer.onDragOver(incoming.event);
    expect(incoming.dataTransfer.dropEffect).toBe('none');
    transfer.onDrop(incoming.event);
    expect(harness.imports).toHaveLength(1);
    pending.resolve([attachment]);
    await flushTransfers();
    expect(harness.accepted).toEqual([[attachment]]);
    expect(transfer.isTransferring()).toBe(false);
  });

  test('discards an import that finishes after switching sessions', async () => {
    const pending = createDeferred<CodexChatAttachment[]>();
    const harness = createHarness(async () => pending.promise);
    const transfer = harness.render();
    transfer.onDrop(drag([WORKSPACE_FILE_TRANSFER_TYPE], JSON.stringify(['/workspace/image.png'])).event);
    harness.render({ scopeKey: 'second' });
    pending.resolve([attachment]);
    await flushTransfers();
    expect(harness.accepted).toEqual([]);
    expect(harness.render().loading).toBe(false);
  });
});

describe('attachments from another workspace page', () => {
  test('accepts an explicit attachment into a hidden draft while refusing hidden DOM transfers', async () => {
    const harness = createHarness();
    let focused = 0;
    let attachments: CodexChatAttachment[] = [{ kind: 'file', path: '/saved/existing.txt', name: 'existing.txt' }];
    const transfer = harness.render({ inactive: true, attachments,
      addAttachments: incoming => { attachments = attachmentModel.mergeChatAttachments(attachments, incoming); },
      onComplete: () => { focused += 1; } });
    const files = ['/workspace/note.txt'];
    expect(await transfer.transferFiles(files)).toBe(false);
    const incoming = drag([WORKSPACE_FILE_TRANSFER_TYPE], JSON.stringify(files));
    transfer.onDragOver(incoming.event);
    transfer.onDrop(incoming.event);
    expect(incoming.dataTransfer.dropEffect).toBe('none');
    expect(harness.imports).toEqual([]);
    expect(await transfer.attachFilesToDraft(files)).toBe(true);
    expect(attachments.map(value => value.path)).toEqual(['/saved/existing.txt', attachment.path]);
    expect(focused).toBe(0);
  });

  test('hidden draft attachments retain the capacity and disabled guards', async () => {
    const harness = createHarness();
    let transfer = harness.render({ inactive: true, disabled: true });
    expect(await transfer.attachFilesToDraft(['/note.txt'])).toBe(false);
    expect(harness.imports).toEqual([]);
    transfer = harness.render({ disabled: false, attachments: Array.from({ length: 20 }, (_, index) => ({
      kind: 'file', path: `/saved/${index}.txt`, name: `${index}.txt`,
    })) });
    expect(await transfer.attachFilesToDraft(['/note.txt'])).toBe(false);
    expect(harness.accepted).toEqual([]);
    expect(harness.render().error).toContain('20 attachments');
  });

  test('hidden imports reject duplicates and cannot attach after the session changes or becomes locked', async () => {
    for (const change of [{ scopeKey: 'next-session' }, { disabled: true }]) {
      const pending = createDeferred<CodexChatAttachment[]>();
      const harness = createHarness(async () => pending.promise);
      const transfer = harness.render({ inactive: true });
      const attaching = transfer.attachFilesToDraft(['/note.txt']);
      expect(await transfer.attachFilesToDraft(['/duplicate.txt'])).toBe(false);
      harness.render(change);
      pending.resolve([attachment]);
      expect(await attaching).toBe(false);
      expect(harness.accepted).toEqual([]);
      expect(harness.imports).toHaveLength(1);
    }
  });
});
