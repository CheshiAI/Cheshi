import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { digest } from './storage.mts';
import { AgentVoice, type VoiceOptions } from './service.mts';
import { VOICE_CHANNEL, parseVoiceRequest, type VoiceSnapshot } from '../../shared/agent-voice.ts';

export function createWorkspaceVoice(options: Omit<VoiceOptions, 'directory' | 'origin' | 'chats'> & {
  directory: string; chats?: VoiceOptions['chats'];
  ipc: Pick<IpcMain, 'handle'>; assertSender(event: IpcMainInvokeEvent): void;
}) {
  let voice: AgentVoice | null = null;
  try {
    voice = new AgentVoice({ ...options, deferAccountReady: true,
      directory: path.join(options.directory, 'voice', digest(options.workspace)),
      origin: process.env.CHESHI_CONNECT_URL?.replace(/\/$/, ''),
      chats: options.chats ?? (() => { throw new Error('Chats is unavailable.'); }),
    });
  } catch { /* Preserve corrupt saved data and keep this optional feature closed. */ }
  const unavailable: VoiceSnapshot = { configured: false, connected: false, calling: false,
    error: 'Phone connection data could not be loaded. Restore its saved data before enabling calls.',
    devices: [], link: null, expiresAt: null, pending: null };
  options.ipc.handle(VOICE_CHANNEL, (event, value) => {
    options.assertSender(event);
    const request = parseVoiceRequest(value);
    if (voice) return voice.request(request);
    if (request.action === 'status') return unavailable;
    throw new Error(unavailable.error!);
  });
  return { get busy() { return voice?.busy === true; }, accountsReady: () => voice?.accountsReady(),
    resetAccount: () => voice?.resetAccount(), dispose: async () => { await voice?.dispose(); } };
}
