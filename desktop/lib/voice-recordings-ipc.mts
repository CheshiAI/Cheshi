import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { VOICE_RECORDINGS_CHANNEL, VOICE_RECORDINGS_SETTINGS_CHANNEL, type VoiceRecordingsApi } from '../shared/voice-recordings.ts';

// Apple's EndpointSecurity/ESClient.h documents this System Settings URL for macOS 13+.
const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles';

export function registerVoiceRecordingsIpc(options: {
  ipcMain: Pick<IpcMain, 'handle'>;
  assertSender: (event: IpcMainInvokeEvent) => void;
  service: VoiceRecordingsApi;
  openExternal: (url: string) => Promise<void>;
  platform?: string;
}): void {
  options.ipcMain.handle(VOICE_RECORDINGS_CHANNEL, event => {
    options.assertSender(event);
    return options.service.list();
  });
  options.ipcMain.handle(VOICE_RECORDINGS_SETTINGS_CHANNEL, async event => {
    options.assertSender(event);
    if ((options.platform ?? process.platform) !== 'darwin') return false;
    try {
      await options.openExternal(FULL_DISK_ACCESS_URL);
      return true;
    } catch { return false; }
  });
}
