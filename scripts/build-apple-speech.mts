import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildAppleSpeech(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = path.join(root, 'desktop', 'runtime', `${process.platform}-${process.arch}`);
  mkdirSync(output, { recursive: true });
  const executable = path.join(output, 'cheshi-speech');
  const built = Bun.spawnSync(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-O', '-parse-as-library',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
    '-module-cache-path', path.join(tmpdir(), 'cheshi-speech-swift-cache'),
    path.join(root, 'desktop', 'native', 'apple-speech', 'SpeechBridge.swift'),
    path.join(root, 'desktop', 'native', 'apple-speech', 'VoiceAudioPreparation.swift'),
    path.join(root, 'desktop', 'native', 'apple-speech', 'VoiceWaveform.swift'),
    '-framework', 'Speech', '-framework', 'AVFoundation', '-o', executable], { stdout: 'inherit', stderr: 'inherit' });
  if (built.exitCode !== 0) throw new Error('Failed to build Apple Speech helper. Install macOS 26+ SDK command line tools.');
  const signed = Bun.spawnSync(['/usr/bin/codesign', '--force', '--sign', '-', executable], { stdout: 'inherit', stderr: 'inherit' });
  if (signed.exitCode !== 0) throw new Error('Failed to sign Apple Speech helper.');
}
if (import.meta.main) await buildAppleSpeech();
