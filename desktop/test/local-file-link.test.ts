import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerLocalFileLinkIpc } from '../lib/local-file-link.mts';
import { localFileLinkPath } from '../shared/local-file-link';
import { loadForgeConfiguration } from './forge-test-helpers';

test('parses absolute and relative Markdown file targets with spaces and source locations', () => {
  expect(localFileLinkPath('/private/tmp/report/REPORT.md')).toBe('/private/tmp/report/REPORT.md');
  expect(localFileLinkPath('/tmp/%ED%95%9C%EA%B8%80%20report.md')).toBe('/tmp/한글 report.md');
  expect(localFileLinkPath('./src/app.ts:12:3')).toBe('./src/app.ts');
  expect(localFileLinkPath('app.ts:12')).toBe('app.ts');
  expect(localFileLinkPath('../notes.md#L24')).toBe('../notes.md');
  expect(localFileLinkPath('/tmp/100%25.md')).toBe('/tmp/100%.md');
});

test('rejects URL schemes, network links, controls and malformed encodings', () => {
  for (const value of [null, {}, '', 'https://example.com', 'mailto:user@example.com',
    'javascript:alert(1)', 'file:///tmp/report.md', '//example.com/report.md', '\\server\\file',
    '%2F%2Fexample.com/file', 'javascript%3Aalert', '/tmp/a%00.md', '/tmp/a\n.md', '%zz', '#section']) {
    expect(localFileLinkPath(value)).toBeNull();
  }
});

test('opens explicit local files through the guarded IPC, including reports outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-local-link-'));
  try {
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot);
    const report = join(root, '한글 report.md');
    const local = join(workspaceRoot, 'README.md');
    await writeFile(report, '# Report');
    await writeFile(local, '# Readme');
    const opened: string[] = [];
    let allowed = true;
    let shellError = '';
    let senderChecks = 0;
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    registerLocalFileLinkIpc({
      workspaceRoot,
      ipcMain: { handle: (name, handler) => { handlers.set(name, handler); } },
      assertSender() { senderChecks++; if (!allowed) throw new Error('Untrusted sender.'); },
      shell: { async openPath(path) { opened.push(path); return shellError; } },
    });
    const handler = handlers.get('cheshi:open-local-file-link');
    assert.ok(handler);
    const event = {} as IpcMainInvokeEvent;
    await handler(event, encodeURI(report));
    await handler(event, './README.md:12');
    expect(opened).toEqual([report, local]);
    expect(senderChecks).toBe(2);
    for (const value of [null, 'https://example.com', 'file:///tmp/file', '//host/file']) {
      await assert.rejects(async () => handler(event, value), /Invalid local file link/);
    }
    await assert.rejects(async () => handler(event, join(root, 'missing.md')), /ENOENT/);
    await assert.rejects(async () => handler(event, workspaceRoot), /does not point to a file/);
    expect(opened).toHaveLength(2);
    allowed = false;
    await assert.rejects(async () => handler(event, report), /Untrusted sender/);
    expect(opened).toHaveLength(2);
    allowed = true;
    shellError = 'No application is available.';
    await assert.rejects(async () => handler(event, report), /No application is available/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packages the local file opening service and its shared parser', async () => {
  const config = await loadForgeConfiguration();
  const ignore = config.packagerConfig.ignore;
  assert.ok(typeof ignore === 'function');
  expect(ignore('/desktop/lib/local-file-link.mts')).toBe(false);
  expect(ignore('/desktop/shared/local-file-link.ts')).toBe(false);
});
