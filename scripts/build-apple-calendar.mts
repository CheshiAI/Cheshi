import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export async function buildAppleCalendar(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const root = fileURLToPath(new URL('..', import.meta.url));
  const source = path.join(root, 'desktop', 'native', 'apple-calendar');
  const output = path.join(root, 'desktop', 'runtime', `${process.platform}-${process.arch}`);
  mkdirSync(output, { recursive: true });
  const executable = path.join(output, 'cheshi-calendar');
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`;
  const result = Bun.spawnSync(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-O', '-parse-as-library', '-target', target,
    '-module-cache-path', path.join(tmpdir(), 'cheshi-calendar-swift-cache'),
    path.join(source, 'CalendarValues.swift'), path.join(source, 'CalendarBridge.swift'),
    '-framework', 'EventKit', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
    '-Xlinker', path.join(source, 'Info.plist'), '-o', executable], { stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error('Failed to build Apple Calendar bridge. Install Xcode Command Line Tools.');
  const signed = Bun.spawnSync(['/usr/bin/codesign', '--force', '--sign', '-', executable], { stdout: 'inherit', stderr: 'inherit' });
  if (signed.exitCode !== 0) throw new Error('Failed to sign Apple Calendar bridge.');
}

if (import.meta.main) await buildAppleCalendar();
