import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebContents } from 'electron';
import { registerSelectionCopy } from '../lib/selection-copy.mts';
import { loadForgeConfiguration } from './forge-test-helpers';

test('auxiliary windows copy exact text from their isolated main frame and reject unrelated messages', () => {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, focused: true, destroyed: false,
    isFocused() { return this.focused; }, isDestroyed() { return this.destroyed; } });
  const copies: string[] = [];
  registerSelectionCopy(contents as unknown as WebContents, { writeText(text) { copies.push(text); } });
  const send = (text: unknown, frame = contents.mainFrame, channel = 'cheshi:copy-drag-selection') =>
    contents.emit('ipc-message', { senderFrame: frame }, channel, text);
  send('  copied\n\ttext  ');
  expect(copies).toEqual(['  copied\n\ttext  ']);
  send(''); send(undefined); send({}); send('wrong frame', {}); send('wrong channel', contents.mainFrame, 'different');
  contents.focused = false; send('background'); contents.focused = true;
  contents.destroyed = true; send('destroyed');
  expect(copies).toHaveLength(1);
  contents.emit('destroyed');
  expect(contents.listenerCount('ipc-message')).toBe(0);
});

test('auxiliary clipboard failure does not propagate into page input handling', () => {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isFocused: () => true, isDestroyed: () => false });
  registerSelectionCopy(contents as unknown as WebContents, { writeText() { throw new Error('Clipboard unavailable'); } });
  expect(() => contents.emit('ipc-message', { senderFrame: contents.mainFrame }, 'cheshi:copy-drag-selection', 'selected')).not.toThrow();
});

test('native terminal gesture state ignores clicks and cancellation and copies once per completed drag', async () => {
  if (process.platform !== 'darwin') return;
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-drag-copy-'));
  try {
    await writeFile(join(directory, 'main.swift'), `import Foundation
var selection = DragSelectionCopy()
let start = CGPoint(x: 10, y: 10)
let end = CGPoint(x: 40, y: 30)
precondition(!selection.finish(at: end))
selection.begin(at: start)
precondition(!selection.finish(at: start))
selection.begin(at: start)
selection.move(to: end)
precondition(selection.finish(at: end))
precondition(!selection.finish(at: end))
selection.begin(at: start)
selection.move(to: end)
selection.cancel()
precondition(!selection.finish(at: end))
selection.begin(at: end)
precondition(selection.finish(at: start))
print("native drag-copy checks passed")
`);
    const executable = join(directory, 'drag-copy-test');
    execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'module-cache'),
      'desktop/native/ghostty-bridge/Sources/CheshiGhosttyBridge/DragSelectionCopy.swift', join(directory, 'main.swift'), '-o', executable],
    { encoding: 'utf8', timeout: 60_000 });
    expect(execFileSync(executable, { encoding: 'utf8' }).trim()).toBe('native drag-copy checks passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test('packaged runtime contains the isolated copy preload and its native process handler', async () => {
  const config = await loadForgeConfiguration();
  const ignore = config.packagerConfig.ignore;
  if (typeof ignore !== 'function') throw new Error('Missing packaging filter');
  expect(ignore('/desktop/lib/selection-copy.mts')).toBe(false);
  const source = await readFile('desktop/runtime/selection-copy-preload.cjs', 'utf8');
  expect(source).toContain('cheshi:copy-drag-selection');
  expect(source).toContain('require("electron")');
  expect(source).not.toContain('exposeInMainWorld');
  expect(source).not.toContain('readWorkspaceFile');
});
