/** Opt-in real provider check. Synthetic microphone; isolated browser and Chats fixture. */
import { chromium } from 'playwright-core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startConnectionServer } from '../server/src/server.ts';
import { AgentVoice } from '../../desktop/lib/agent-voice/service.mts';
import { CodexAppServerClient } from '../../desktop/lib/codex-app-server-client.mts';
import type { ChatsSnapshot, ChatsRequest } from '../../desktop/shared/agent-chats.ts';

if (process.env.CHESHI_TEST_REAL_VOICE !== '1') throw new Error('Set CHESHI_TEST_REAL_VOICE=1 only for an authorized live voice check.');
const root = path.resolve(import.meta.dirname, '../..');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'cheshi-live-voice-'));
const port = Number(process.env.CHESHI_VOICE_TEST_PORT || '48771'), origin = `http://127.0.0.1:${port}`;
const server = startConnectionServer({ origin, port, assets: path.join(root, 'connect/client/dist') });
const snapshot: ChatsSnapshot = { rooms: [{ id: 'voice_test', workspace: temporary, name: 'Isolated voice test', engineId: 'docker:local', defaultAgentId: 'fixture',
  members: [{ id: 'fixture', accountId: 'fixture', name: 'Test fixture' }], createdAt: new Date().toISOString() }], messages: [] };
const deliveries: Extract<ChatsRequest, { action: 'send' }>[] = [];
const diagnostics: unknown[] = [];
const voice = new AgentVoice({ directory: temporary, workspace: temporary, origin, account: () => 'live-test', ready: async () => {},
  chats: request => {
    if (request.action === 'send') {
      deliveries.push(request);
      if (!snapshot.messages.some(m => m.id === request.id)) {
        snapshot.messages.push({ id: request.id, roomId: request.roomId, threadId: request.threadId, sender: 'user', recipient: 'fixture', kind: 'message', text: request.text, createdAt: new Date().toISOString(), status: 'completed' });
        snapshot.messages.push({ id: `reply_${deliveries.length}`, roomId: request.roomId, threadId: request.id, sender: 'fixture', recipient: null, kind: 'reply', text: '테스트 방에서 요청을 받았습니다. 실제 파일은 변경하지 않았습니다.', createdAt: new Date().toISOString() });
      }
    }
    return snapshot;
  },
  createClient: () => { const client = new CodexAppServerClient({ cwd: temporary,
    command: { executable: process.env.CHESHI_CODEX || '/opt/homebrew/bin/codex', args: ['app-server', '--listen', 'stdio://'], environment: { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined } },
    capabilities: { experimentalApi: true, explicitGatewayOauth: true }, clientInfo: { name: 'cheshi_voice_check', title: 'Cheshi isolated voice check', version: '0.1.0' },
  });
    client.onNotification(event => {
      const p = event.params as Record<string, unknown> | undefined;
      if (String(event.method).includes('realtime') && !String(event.method).includes('sdp') && diagnostics.length < 150) diagnostics.push({ method: event.method, role: p?.role, text: p?.text ?? p?.delta, error: p?.message });
    });
    return client;
  },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let diagnose = async (): Promise<unknown> => null;
async function until(predicate: () => boolean, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Expected live voice event was not observed.'); await Bun.sleep(50); }
}
try {
  const aiff = path.join(temporary, 'input.aiff'), wav = path.join(temporary, 'input.wav');
  for (const [command, args] of [['/usr/bin/say', ['-v', 'Yuna', '-o', aiff, '음성 연결 확인입니다. 잘 들린다고 짧게 대답해 주세요.']], ['/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', '-r', '24000', aiff, wav]]] as const) {
    const result = spawnSync(command, [...args], { encoding: 'utf8' }); assert.equal(result.status, 0, `${command} failed`);
  }
  const audio = readFileSync(wav).toString('base64');
  browser = await chromium.launch({ executablePath: process.env.CHESHI_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  diagnose = () => page.evaluate(() => ({ state: document.getElementById('state')?.textContent,
    probe: (window as unknown as { __voiceProbe: unknown }).__voiceProbe, transcript: document.getElementById('transcript')?.textContent }));
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(({ audio }) => {
    const probe = { connected: false, peak: 0, play: () => {}, events: [] as string[], speech: '' };
    Object.assign(window, { __voiceProbe: probe });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', event => {
          const f = JSON.parse(String(event.data));
          if (f.payload?.type === 'error') probe.events.push(String(f.payload.message));
          if (f.payload?.type === 'transcript' && f.payload.role === 'assistant') probe.speech += String(f.payload.text);
        });
      }
    };
    let ctx: AudioContext;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      ctx = new AudioContext(); await ctx.resume(); const destination = ctx.createMediaStreamDestination();
      // A real microphone remains clocked while the caller is silent. Keep the
      // synthetic input alive too; an ended Web Audio source stalls the provider timeline.
      const clock = ctx.createOscillator(), silence = ctx.createGain(); silence.gain.value = 0.00001;
      clock.connect(silence); silence.connect(destination); clock.start();
      const bytes = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      probe.play = () => { const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(destination); source.start(); };
      return destination.stream;
    } });
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        this.addEventListener('connectionstatechange', () => { probe.connected = this.connectionState === 'connected'; });
        this.addEventListener('track', event => {
          const source = ctx.createMediaStreamSource(new MediaStream([event.track])), analyser = ctx.createAnalyser(), gain = ctx.createGain();
          gain.gain.value = 0; source.connect(analyser); analyser.connect(gain); gain.connect(ctx.destination);
          const samples = new Float32Array(analyser.fftSize);
          setInterval(() => { analyser.getFloatTimeDomainData(samples); for (const value of samples) probe.peak = Math.max(probe.peak, Math.abs(value)); }, 25);
        });
      }
    };
    document.addEventListener('DOMContentLoaded', () => { (document.getElementById('audio') as HTMLAudioElement).muted = true; });
  }, { audio });
  const pairing = await voice.request({ action: 'pair', roomId: 'voice_test' });
  await until(() => voice.snapshot().connected);
  await page.goto(pairing.link!); await page.getByRole('button', { name: 'Mac에 연결', exact: true }).click();
  await until(() => !!voice.snapshot().pending);
  await page.waitForFunction(code => document.getElementById('code')?.textContent?.includes(code), voice.snapshot().pending!.code);
  assert.ok((await page.locator('#code').textContent())?.includes(voice.snapshot().pending!.code));
  await voice.request({ action: 'approve', id: voice.snapshot().pending!.id });
  console.log('Live voice: device approved');
  await page.getByRole('button', { name: '통화 시작', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { __voiceProbe: { connected: boolean } }).__voiceProbe.connected, undefined, { timeout: 60000 });
  console.log('Live voice: media connected');
  await page.evaluate(() => (window as unknown as { __voiceProbe: { play(): void } }).__voiceProbe.play());
  await until(() => deliveries.length > 0, 60000);
  console.log('Live voice: transcript delivered');
  await page.waitForFunction(() => (window as unknown as { __voiceProbe: { peak: number } }).__voiceProbe.peak > 0.001, undefined, { timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('테스트 방에서 요청을 받았습니다.'), undefined, { timeout: 30000 });
  await page.waitForFunction(() => (window as unknown as { __voiceProbe: { speech: string } }).__voiceProbe.speech.replace(/\s/g, '').includes('실제파일은변경하지않았습니다'), undefined, { timeout: 60000 });
  console.log('Live voice: room reply spoken');
  const result = await page.evaluate(() => {
    const probe = (window as unknown as { __voiceProbe: { peak: number; events: string[]; speech: string } }).__voiceProbe;
    return { peak: probe.peak, errors: probe.events, speech: probe.speech, transcript: document.getElementById('transcript')?.textContent };
  });
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0]?.automatic, true); assert.deepEqual(result.errors, []); assert.deepEqual(pageErrors, []);
  await page.getByRole('button', { name: '통화 종료', exact: true }).click(); await until(() => !voice.busy);
  assert.equal(snapshot.messages.length, 2);
  await page.reload(); await page.getByRole('button', { name: 'Mac에 연결', exact: true }).click();
  await page.waitForFunction(() => !(document.getElementById('call') as HTMLButtonElement).disabled);
  assert.equal(voice.snapshot().pending, null);
  await voice.request({ action: 'revoke', id: voice.snapshot().devices[0]!.id });
  await page.waitForFunction(() => (document.getElementById('call') as HTMLButtonElement).disabled);
  console.log(JSON.stringify({ passed: true, deliveries: deliveries.length, userTranscript: deliveries[0]?.text, ...result, workRetainedAfterHangup: true }));
} catch (error) { console.error(JSON.stringify({ diagnostics, browser: await diagnose().catch(() => null) })); throw error; }
finally { await browser?.close(); await voice.dispose(); server.stop(); rmSync(temporary, { recursive: true, force: true }); }
