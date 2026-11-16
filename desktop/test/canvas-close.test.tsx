import { expect, test } from 'bun:test';
import { confirmDocumentClose, type ClosableDocument, type CloseResult } from '../../vendor/open-pencil/src/app/document/close/controller';
import { load } from './workspace-shell-test-harness';

type Close = (document: ClosableDocument, name: string) => Promise<CloseResult>;

function createClose(choose: (method: string, payload: { documentName: string }, timeout: number | null) => Promise<unknown>) {
  return load<Close>('../open-pencil/editor/close-prompt.ts', 'requestDocumentClose', {
    '../../../../vendor/open-pencil/src/app/document/close/controller': { confirmDocumentClose },
    './host': { requestHost: choose },
  });
}

function createDocument() {
  const state = { dirty: true, saves: 0, fail: false, cancelSave: false };
  const document: ClosableDocument = {
    hasUnsavedChanges: () => state.dirty,
    async saveFigFile() {
      state.saves++;
      if (state.fail) throw new Error('Disk write failed');
      if (state.cancelSave) return false;
      state.dirty = false;
      return true;
    },
  };
  return { state, document };
}

test('Canvas close validates choices and only closes after a successful save or explicit discard', async () => {
  let choice: unknown = 'cancel';
  const close = createClose(async (method, payload, timeout) => {
    expect(method).toBe('confirm-close');
    expect(payload).toEqual({ documentName: 'Design' });
    expect(timeout).toBeNull();
    return choice;
  });
  const { document, state } = createDocument();
  for (choice of ['cancel', true, null, {}, 'invalid']) {
    expect(await close(document, 'Design')).toBe('cancel');
    expect(state.saves).toBe(0);
    expect(state.dirty).toBe(true);
  }
  choice = 'save'; state.fail = true;
  expect(await close(document, 'Design')).toBe('cancel');
  expect(state.dirty).toBe(true);
  state.fail = false; state.cancelSave = true;
  expect(await close(document, 'Design')).toBe('cancel');
  expect(state.dirty).toBe(true);
  state.cancelSave = false;
  expect(await close(document, 'Design')).toBe('saved');
  expect(state.dirty).toBe(false);
  state.dirty = true; choice = 'discard';
  expect(await close(document, 'Design')).toBe('discard');
  expect(state.saves).toBe(3);
});

test('Canvas close skips clean documents and safely cancels a disconnected host', async () => {
  const { document, state } = createDocument();
  let requests = 0;
  const close = createClose(async () => { requests++; throw new Error('Host disconnected'); });
  state.dirty = false;
  expect(await close(document, 'Design')).toBe('saved');
  expect(requests).toBe(0);
  state.dirty = true;
  expect(await close(document, 'Design')).toBe('cancel');
  expect(requests).toBe(1);
  expect(state.saves).toBe(0);
  expect(state.dirty).toBe(true);
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('Canvas close serializes confirmations instead of replacing a pending document', async () => {
  const firstChoice = createDeferred<unknown>();
  const names: string[] = [];
  const close = createClose(async (_method, payload) => {
    names.push(payload.documentName);
    return names.length === 1 ? firstChoice.promise : 'discard';
  });
  const first = close(createDocument().document, 'First');
  const second = close(createDocument().document, 'Second');
  await Promise.resolve();
  expect(names).toEqual(['First']);
  firstChoice.resolve('cancel');
  expect(await first).toBe('cancel');
  expect(await second).toBe('discard');
  expect(names).toEqual(['First', 'Second']);
});
