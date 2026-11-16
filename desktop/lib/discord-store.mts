import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { discordNotificationSwitch, discordPreferences, type DiscordPreferences } from '../shared/discord.ts';
import type { NotificationKind } from '../shared/notification-events.ts';

export interface DiscordBinding {
  workspace: string; thread: string; title: string; channel: string; cursor: string;
  statusMessage?: string; disabled?: boolean;
}
export interface DiscordDelivery {
  id: string; binding: string; text: string; alert: boolean; attempted?: boolean;
  kind?: NotificationKind; retainWhenMuted?: boolean; muted?: boolean; test?: boolean;
}
export interface DiscordData {
  version: 1; deviceId: string; preferences: DiscordPreferences; encryptedToken: string;
  notificationsEnabled: boolean;
  bindings: Record<string, DiscordBinding>; outbox: DiscordDelivery[];
}
export interface DiscordEncryption {
  isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string;
}
export function createDiscordStore(directory: string, encryption: DiscordEncryption) {
  const filename = path.join(directory, 'discord.json');
  let data: DiscordData;
  let error: string | null = null;
  try {
    data = JSON.parse(readFileSync(filename, 'utf8')) as DiscordData;
    if (data.version !== 1 || !/^[a-f0-9-]{36}$/.test(data.deviceId) || !data.bindings || !Array.isArray(data.outbox)
      || typeof data.encryptedToken !== 'string') throw new Error('Invalid Discord storage.');
    discordPreferences(data.preferences);
    data.notificationsEnabled = data.notificationsEnabled === undefined ? true : discordNotificationSwitch(data.notificationsEnabled);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') error = 'Could not read Discord settings. Existing data was preserved.';
    data = { version: 1, deviceId: randomUUID(), preferences: { enabled: false, guildId: '', ownerId: '', deviceName: hostname().slice(0, 60) },
      notificationsEnabled: true, encryptedToken: '', bindings: {}, outbox: [] };
  }
  const write = () => {
    if (error) throw new Error(error);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); renameSync(temporary, filename); }
    finally { rmSync(temporary, { force: true }); }
  };
  return {
    data, write, error,
    setNotificationsEnabled(value: unknown) {
      const next = discordNotificationSwitch(value), previous = data.notificationsEnabled;
      data.notificationsEnabled = next;
      try { write(); } catch (error) { data.notificationsEnabled = previous; throw error; }
    },
    token() {
      if (!data.encryptedToken) return '';
      if (!encryption.isEncryptionAvailable()) throw new Error('Unlock secure storage to connect Discord.');
      return encryption.decryptString(Buffer.from(data.encryptedToken, 'base64'));
    },
    save(preferences: DiscordPreferences, token?: string) {
      let encrypted = data.encryptedToken;
      if (token !== undefined && token !== '') {
        if (!encryption.isEncryptionAvailable()) throw new Error('Secure storage is unavailable. Token was not saved.');
        if (token.length < 20 || token.length > 512 || /\s/.test(token)) throw new TypeError('Enter a valid bot token.');
        encrypted = encryption.encryptString(token).toString('base64');
      }
      if (preferences.enabled && !encrypted) throw new Error('Save a personal bot token first.');
      if (data.preferences.guildId && (preferences.guildId !== data.preferences.guildId || preferences.ownerId !== data.preferences.ownerId)) {
        throw new Error('This connection is bound to its personal server and owner. Existing session channels cannot be moved to another server.');
      }
      const previous = { preferences: data.preferences, encryptedToken: data.encryptedToken };
      data.preferences = preferences; data.encryptedToken = encrypted;
      try { write(); } catch (error) { Object.assign(data, previous); throw error; }
    },
  };
}
