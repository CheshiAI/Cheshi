import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Isolated Electron fixtures never connect to the user's running app.
test('Electron serves ranged audio using the registered scheme and revokes released tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-protocol-'));
  try {
    const bootstrap = await readFile(new URL('../bootstrap.mts', import.meta.url), 'utf8');
    const declaration = bootstrap.match(/protocol\.registerSchemesAsPrivileged\([^\n]+\);/)?.[0];
    assert.ok(declaration);
    assert.ok(bootstrap.indexOf(declaration) < bootstrap.indexOf('app.whenReady()'));
    const audio = join(directory, 'fixture.m4a');
    const main = join(directory, 'main.cjs');
    await writeFile(audio, '0123456789');
    await writeFile(main, `
const { app, protocol, net, session } = require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
${declaration}
app.whenReady().then(async () => {
  app.dock?.hide();
  const { openVoiceAudio, registerVoiceAudioProtocol } = await import(${JSON.stringify(new URL('../lib/voice-audio.mts', import.meta.url).href)});
  registerVoiceAudioProtocol(session.defaultSession.protocol);
  const audio = openVoiceAudio(session.defaultSession.protocol, ${JSON.stringify(audio)});
  const response = await net.fetch(audio.url, { headers: { Range: 'bytes=3-6' } });
  const result = { status: response.status, range: response.headers.get('content-range'), text: await response.text() };
  audio.release();
  result.releasedStatus = (await net.fetch(audio.url)).status;
  process.stdout.write('VOICE_PROTOCOL ' + JSON.stringify(result) + '\\n');
  app.quit();
}).catch(error => { process.stderr.write(String(error.stack)); app.exit(1); });
setTimeout(() => app.exit(2), 10000).unref();
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(createRequire(import.meta.url)('electron') as string, [main], {
      env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    const line = child.stdout.split('\n').find(value => value.startsWith('VOICE_PROTOCOL '));
    assert.ok(line, child.stdout);
    assert.deepEqual(JSON.parse(line.slice('VOICE_PROTOCOL '.length)), {
      status: 206, range: 'bytes 3-6/10', text: '3456', releasedStatus: 404,
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a renderer can play and seek audio opened after navigation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-media-'));
  try {
    const bootstrap = await readFile(new URL('../bootstrap.mts', import.meta.url), 'utf8');
    const declaration = bootstrap.match(/protocol\.registerSchemesAsPrivileged\([^\n]+\);/)?.[0];
    const registration = bootstrap.match(/registerVoiceAudioProtocol\(session\.defaultSession\.protocol\);/)?.[0];
    assert.ok(declaration); assert.ok(registration);
    assert.ok(bootstrap.indexOf(registration) < bootstrap.indexOf('new BrowserWindow'));
    const audio = join(directory, 'silence.wav');
    const samples = 8000 * 3;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    await writeFile(audio, wav);
    const main = join(directory, 'main.cjs');
    await writeFile(main, `
const { app, protocol, session, BrowserWindow, net } = require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
${declaration}
app.whenReady().then(async () => {
  app.dock?.hide();
  const { openVoiceAudio, registerVoiceAudioProtocol } = await import(${JSON.stringify(new URL('../lib/voice-audio.mts', import.meta.url).href)});
  ${registration}
  ${registration}
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html,<audio id="audio" muted></audio>');
  const audio = openVoiceAudio(session.defaultSession.protocol, ${JSON.stringify(audio)});
  const result = await window.webContents.executeJavaScript(\`new Promise(resolve => {
    const audio = document.querySelector('audio');
    audio.muted = true;
    audio.onerror = () => resolve({ error: audio.error?.message, code: audio.error?.code });
    audio.onloadedmetadata = async () => {
      try {
        await audio.play();
        audio.onseeked = () => { audio.pause(); resolve({ duration: audio.duration, time: audio.currentTime }); };
        audio.currentTime = 1.5;
      } catch (error) { resolve({ error: String(error) }); }
    };
    audio.src = \${JSON.stringify(audio.url)};
  })\`);
  audio.release();
  result.releasedStatus = (await net.fetch(audio.url)).status;
  process.stdout.write('VOICE_MEDIA ' + JSON.stringify(result) + '\\n');
  window.destroy(); app.quit();
}).catch(error => { process.stderr.write(String(error.stack)); app.exit(1); });
setTimeout(() => app.exit(2), 10000).unref();
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(createRequire(import.meta.url)('electron') as string, [main], {
      env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    const line = child.stdout.split('\n').find(value => value.startsWith('VOICE_MEDIA '));
    assert.ok(line, child.stdout);
    const result = JSON.parse(line.slice('VOICE_MEDIA '.length));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.duration, 3);
    assert.ok(Math.abs(result.time - 1.5) < 0.2, JSON.stringify(result));
    assert.equal(result.releasedStatus, 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
