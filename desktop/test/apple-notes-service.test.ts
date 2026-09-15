import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import { AppleNotesService } from '../lib/apple-notes-service.mts';
import { AppleNotesProcessError } from '../lib/apple-notes-process.mts';
import { appleNoteCreateInput, APPLE_NOTES_MAX_BODY_LENGTH } from '../shared/apple-notes.ts';

function note(id: string, title = '메모', locked: unknown = false) {
  let reads = 0;
  return { id: () => id, name: () => title, modificationDate: () => new Date('2026-09-16T00:00:00Z'),
    passwordProtected: () => locked, exists: () => true, plaintext: () => { reads += 1; return '메모\n  content <script> & 😀'; },
    get reads() { return reads; } };
}

function fixture() {
  const first = note('first');
  const locked = note('locked', '비공개', true);
  const notes = [first, locked];
  const child = { id: () => 'child', name: () => 'Nested', folders: () => [], notes: () => notes, exists: () => true };
  const root = { id: () => 'root', name: () => 'Notes', folders: () => [child], notes: () => notes, exists: () => true };
  const folders = [root, child];
  const account = { name: () => 'iCloud', folders: () => folders, defaultFolder: () => root };
  const creations: { new: string; at: typeof root | typeof child; withProperties: { body: string } }[] = [];
  const app = {
    accounts: () => [account], defaultAccount: () => account,
    folders: Object.assign(() => folders, { byId: (id: string) => folders.find(folder => folder.id() === id)
      ?? { ...root, exists: () => false } }),
    notes: Object.assign(() => notes, { byId: (id: string) => notes.find(item => item.id() === id)
      ?? { ...first, exists: () => false } }),
    make: (input: (typeof creations)[number]) => { creations.push(input); return note('created', 'Saved'); },
  };
  const service = new AppleNotesService({ platform: 'darwin', execute: async source => {
    return vm.runInNewContext(source, { Application: (id: string) => {
      expect(id).toBe('com.apple.Notes');
      return app;
    } }) as string;
  } });
  return { service, app, first, locked, notes, creations, child };
}

describe('Apple Notes automation contract', () => {
  test('lists nested folders once and reads only metadata until a note is chosen', async () => {
    const { service, first, locked } = fixture();
    expect(await service.folders()).toEqual({ ok: true, value: [
      { id: 'root', name: 'Notes', account: 'iCloud', path: 'Notes', isDefault: true },
      { id: 'child', name: 'Nested', account: 'iCloud', path: 'Notes / Nested', isDefault: false },
    ] });
    const list = await service.list('child');
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error(list.error.message);
    expect(list.value.notes.map(item => item.id)).toEqual(['first', 'locked']);
    expect(list.value.notes[1]?.locked).toBe(true);
    expect(first.reads + locked.reads).toBe(0);
    const read = await service.read('first');
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.plaintext).toBe('메모\n  content <script> & 😀');
    expect(first.reads).toBe(1);
  });

  test('does not read locked bodies and rejects malformed lock flags', async () => {
    const { service, locked, notes } = fixture();
    expect(await service.read('locked')).toMatchObject({ ok: false, error: { code: 'locked' } });
    expect(locked.reads).toBe(0);
    const invalid = note('invalid', 'Invalid', 'false');
    notes.push(invalid);
    expect(await service.read('invalid')).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(invalid.reads).toBe(0);
    expect(await service.list('root')).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  test('paginates note metadata and reports deleted targets', async () => {
    const { service, notes } = fixture();
    notes.push(...Array.from({ length: 103 }, (_, index) => note(`extra-${index}`)));
    const first = await service.list('root');
    const second = await service.list('root', 100);
    if (!first.ok || !second.ok) throw new Error('Expected pages.');
    expect(first.value.notes).toHaveLength(100);
    expect(first.value.nextOffset).toBe(100);
    expect(second.value.notes).toHaveLength(5);
    expect(second.value.nextOffset).toBeNull();
    expect(await service.read('deleted')).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await service.list('deleted')).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  test('creates a new note in the selected folder and treats script and HTML syntax as data', async () => {
    const { service, creations, first, child } = fixture();
    const title = '제목 " & <title>';
    const body = 'line\n</pre><script>throw Error("injected")</script>\u2028😀\n$(echo injected)';
    expect(await service.create({ folderId: 'child', title, body })).toEqual({ ok: true, value: { id: 'created', title: 'Saved' } });
    expect(creations).toHaveLength(1);
    expect(creations[0]?.new).toBe('note');
    expect(creations[0]?.at).toBe(child);
    expect(creations[0]?.withProperties.body).toContain('&lt;/pre&gt;&lt;script&gt;throw Error(&quot;injected&quot;)');
    expect(creations[0]?.withProperties.body).toContain('<h1>제목 &quot; &amp; &lt;title&gt;</h1>');
    expect(first.reads).toBe(0);
  });

  test('returns an empty folder list without accessing a missing default account', async () => {
    const { service, app } = fixture();
    app.accounts = () => [];
    app.defaultAccount = () => { throw new Error('No account'); };
    expect(await service.folders()).toEqual({ ok: true, value: [] });
  });

  test('maps permission errors without exposing native diagnostics', async () => {
    const { service, app } = fixture();
    app.accounts = () => { throw Object.assign(new Error('private note contents'), { errorNumber: -1743 }); };
    const result = await service.folders();
    expect(result).toMatchObject({ ok: false, error: { code: 'permission' } });
    expect(JSON.stringify(result)).not.toContain('private note contents');
    app.make = () => { throw Object.assign(new Error('private'), { errorNumber: -1743 }); };
    expect(await service.create({ folderId: 'child', title: 'title', body: 'body' })).toMatchObject({ ok: false, error: { code: 'permission' } });
  });

  test('a failed create acknowledgement is uncertain and is never automatically retried', async () => {
    let calls = 0;
    const service = new AppleNotesService({ platform: 'darwin', execute: async () => {
      calls += 1;
      throw new AppleNotesProcessError('timeout');
    } });
    expect(await service.create({ folderId: 'root', title: 'title', body: 'body' })).toMatchObject({ ok: false, error: { code: 'save-unknown' } });
    expect(calls).toBe(1);
    expect(await service.folders()).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  test('validates requests before running automation and rejects unsupported platforms', async () => {
    let calls = 0;
    const execute = async () => { calls += 1; return '{}'; };
    const service = new AppleNotesService({ platform: 'darwin', execute });
    for (const body of ['', 'x'.repeat(APPLE_NOTES_MAX_BODY_LENGTH + 1), 'bad\0body']) {
      expect(await service.create({ folderId: 'root', title: 'title', body })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    }
    expect(await service.list('root', -1)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await service.read('')).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await new AppleNotesService({ platform: 'linux', execute }).folders()).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(calls).toBe(0);
    expect(appleNoteCreateInput({ folderId: 'root', title: ' title ', body: '  spaces\n' }).body).toBe('  spaces\n');
  });
});
