import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export async function buildAppleMail(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = path.join(root, 'desktop', 'runtime', `${process.platform}-${process.arch}`);
  mkdirSync(output, { recursive: true });
  const executable = path.join(output, 'cheshi-mail');
  const result = Bun.spawnSync(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-O', '-parse-as-library',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`,
    '-module-cache-path', path.join(tmpdir(), 'cheshi-mail-swift-cache'),
    path.join(root, 'desktop/native/apple-mail/MailPaste.swift'), '-framework', 'AppKit', '-framework', 'ApplicationServices', '-o', executable],
  { stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error('Failed to build Apple Mail bridge. Install Xcode Command Line Tools.');
  const signed = Bun.spawnSync(['/usr/bin/codesign', '--force', '--sign', '-', executable], { stdout: 'inherit', stderr: 'inherit' });
  if (signed.exitCode !== 0) throw new Error('Failed to sign Apple Mail bridge.');
}
if (import.meta.main) await buildAppleMail();
