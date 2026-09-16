import { describe, expect, test } from 'bun:test';
import type { ChatModel } from '../frontend/src/features/chat/model';
import { TemporaryChatSession, type TemporaryChatApi, type TemporaryChatState } from '../frontend/src/features/chat/temporaryChatSession';

const models: ChatModel[] = [{ id: 'model-a', model: 'model-a', displayName: 'Model A', description: '',
  isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium', description: '' }],
  serviceTiers: [], defaultServiceTier: null }];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<TemporaryChatApi> = {}) {
  const calls: string[] = [];
  const changes: TemporaryChatState[] = [];
  const api: TemporaryChatApi = {
    async models(id) { calls.push(`models:${id}`); return models; },
    async send(id, request) { calls.push(`send:${id}:${request.text}`); return { text: `Reply to ${request.text}`, model: request.model }; },
    async selectAttachments() { return []; },
    async importAttachments() { return []; },
    async close(id) { calls.push(`close:${id}`); },
    ...overrides,
  };
  const session = new TemporaryChatSession(api, 'session', state => changes.push(state));
  return { session, calls, changes, latest: () => changes.at(-1)! };
}

describe('temporary chat panel session', () => {
  test('merges dropped files with picker attachments and sends their original paths', async () => {
    const file = { kind: 'file' as const, name: 'notes.txt', path: '/workspace/notes.txt' };
    const other = { kind: 'image' as const, name: 'image.png', path: '/workspace/image.png' };
    const imports: unknown[] = [];
    let sent: unknown;
    const f = fixture({ selectAttachments: async () => [file],
      importAttachments: async (id, files) => { imports.push({ id, files }); return [file, other]; },
      send: async (_id, request) => { sent = request.attachments; return { model: request.model, text: 'Read' }; } });
    await f.session.start();
    await f.session.selectAttachments();
    await f.session.importAttachments([file.path, other.path]);
    expect(f.latest().attachments).toEqual([file, other]);
    expect(imports).toEqual([{ id: 'session', files: [file.path, other.path] }]);
    await f.session.send();
    expect(sent).toEqual([file, other]);
    await f.session.close();
  });

  test('does not exceed 20 total attachments or discard existing selections after a failed drop', async () => {
    const selected = Array.from({ length: 20 }, (_, index) => ({ kind: 'file' as const, name: `${index}.txt`, path: `/workspace/${index}.txt` }));
    let calls = 0;
    const f = fixture({ selectAttachments: async () => selected, importAttachments: async () => {
      if (++calls === 1) return [{ kind: 'file', name: 'extra.txt', path: '/workspace/extra.txt' }];
      throw new Error('Not a regular file');
    } });
    await f.session.start();
    await f.session.selectAttachments();
    await f.session.importAttachments(['/workspace/extra.txt']);
    expect(f.latest().attachments).toEqual(selected);
    expect(f.latest().error).toContain('20 files');
    await f.session.importAttachments(['/workspace/folder']);
    expect(f.latest().attachments).toEqual(selected);
    expect(f.latest().error).toContain('Not a regular file');
    expect(f.latest().picking).toBe(false);
    await f.session.close();
  });

  test('blocks overlapping drop, picker and send operations and ignores a drop result after close', async () => {
    const pending = createDeferred<Awaited<ReturnType<TemporaryChatApi['importAttachments']>>>();
    let imports = 0;
    let picks = 0;
    const f = fixture({ importAttachments: () => { imports++; return pending.promise; },
      selectAttachments: async () => { picks++; return []; } });
    await f.session.importAttachments(['/workspace/early.txt']);
    expect(imports).toBe(0);
    await f.session.start();
    f.session.setDraft('Read this');
    const dropping = f.session.importAttachments(['/workspace/notes.txt']);
    await f.session.importAttachments(['/workspace/again.txt']);
    await f.session.selectAttachments();
    await f.session.send();
    expect(imports).toBe(1);
    expect(picks).toBe(0);
    expect(f.calls.some(call => call.startsWith('send:'))).toBe(false);
    await f.session.close();
    const count = f.changes.length;
    pending.resolve([{ kind: 'file', name: 'notes.txt', path: '/workspace/notes.txt' }]);
    await dropping;
    expect(f.changes).toHaveLength(count);
  });

  test('keeps multiple turns in one session and clears the lifetime on close', async () => {
    const { session, calls, latest } = fixture();
    await session.start();
    session.setDraft('First');
    await session.send();
    session.setDraft('Follow up');
    await session.send();
    expect(latest().messages.map(message => message.text)).toEqual(['First', 'Reply to First', 'Follow up', 'Reply to Follow up']);
    expect(latest().draft).toBe('');
    expect(calls).toEqual(['models:session', 'send:session:First', 'send:session:Follow up']);
    await session.close();
    session.setDraft('Too late');
    await session.send();
    await session.close();
    expect(calls.filter(call => call === 'close:session')).toHaveLength(1);
    expect(calls.filter(call => call.startsWith('send:'))).toHaveLength(2);
  });

  test('suppresses a model result arriving after close', async () => {
    const pending = createDeferred<ChatModel[]>();
    const { session, changes, calls } = fixture({ models: () => pending.promise });
    const loading = session.start();
    await session.close();
    pending.resolve(models);
    await loading;
    expect(changes).toHaveLength(0);
    expect(calls).toEqual(['close:session']);
  });

  test('blocks duplicate sends and ignores a completion arriving after close', async () => {
    const pending = createDeferred<{ text: string; model: string }>();
    let sends = 0;
    const { session, changes } = fixture({ send: () => { sends++; return pending.promise; } });
    await session.start();
    session.setDraft('Once');
    const running = session.send();
    session.setDraft('Duplicate');
    await session.send();
    expect(sends).toBe(1);
    await session.close();
    const countAtClose = changes.length;
    pending.resolve({ text: 'Late reply', model: 'model-a' });
    await running;
    expect(changes).toHaveLength(countAtClose);
  });

  test('retains failed input and requires a fresh session after a terminal send failure', async () => {
    let sends = 0;
    const { session, latest } = fixture({ async send() { sends++; throw new Error('Turn timed out.'); } });
    await session.start();
    session.setDraft('Do not lose this');
    await session.send();
    expect(latest().draft).toBe('Do not lose this');
    expect(latest().messages).toHaveLength(0);
    expect(latest().failed).toBe(true);
    expect(latest().error).toContain('Close and reopen');
    await session.send();
    expect(sends).toBe(1);
    await session.close();
  });

  test('ignores a file picker result after close and never sends attachments late', async () => {
    const pending = createDeferred<Awaited<ReturnType<TemporaryChatApi['selectAttachments']>>>();
    const { session, changes, calls } = fixture({ selectAttachments: () => pending.promise });
    await session.start();
    const picking = session.selectAttachments();
    await session.close();
    const countAtClose = changes.length;
    pending.resolve([{ kind: 'file', name: 'notes.txt', path: '/original/notes.txt' }]);
    await picking;
    await session.send();
    expect(changes).toHaveLength(countAtClose);
    expect(calls).toEqual(['models:session', 'close:session']);
  });

  test('deduplicates attachments and passes the selected original paths to the same session', async () => {
    const file = { kind: 'file' as const, name: 'notes.txt', path: '/original/notes.txt' };
    let received: unknown;
    const { session, latest } = fixture({ async selectAttachments() { return [file, file]; },
      async send(id, request) { received = { id, attachments: request.attachments }; return { text: 'Read', model: request.model }; } });
    await session.start();
    await session.selectAttachments();
    await session.selectAttachments();
    expect(latest().attachments).toEqual([file]);
    await session.send();
    expect(received).toEqual({ id: 'session', attachments: [file] });
    await session.close();
  });
});
