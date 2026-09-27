export const DISCORD_CHANNEL = 'cheshi:discord';
export interface DiscordPreferences { enabled: boolean; guildId: string; ownerId: string; deviceName: string; }
export interface DiscordSettings extends DiscordPreferences {
  hasToken: boolean; status: string; connected: boolean; channels: number; pending: number;
}
export interface DiscordConfirmation {
  id: string; guildId: string; ownerId: string; deviceName: string;
}
export interface DiscordApi {
  get(): Promise<DiscordSettings>;
  save(value: DiscordPreferences & { token?: string }): Promise<DiscordSettings>;
  test(): Promise<DiscordSettings>;
  setup(contextId?: string): Promise<string>;
  getConfirmation(): Promise<DiscordConfirmation | null>;
  onConfirmation(listener: (value: DiscordConfirmation | null) => void): () => void;
  respondConfirmation(id: string, accepted: boolean): Promise<void>;
}
export function discordConfirmation(value: unknown): DiscordConfirmation | null {
  if (value === null) return null;
  const data = discordRecord(value);
  if (typeof data.id !== 'string' || !data.id) throw new TypeError('Invalid Discord confirmation.');
  const { guildId, ownerId, deviceName } = discordPreferences({ ...data, enabled: false });
  return { id: data.id, guildId, ownerId, deviceName };
}
export function discordRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Discord data.');
  return value as Record<string, unknown>;
}
export function discordId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{17,20}$/.test(value)) throw new TypeError('Enter a valid Discord ID.');
  return value;
}
export function discordPreferences(value: unknown): DiscordPreferences {
  const data = discordRecord(value);
  if (data.enabled !== true && data.enabled !== false) throw new TypeError('Invalid Discord switch.');
  if (typeof data.deviceName !== 'string' || !data.deviceName.trim() || data.deviceName.length > 60) throw new TypeError('Enter a device name (up to 60 characters).');
  return { enabled: data.enabled, guildId: discordId(data.guildId), ownerId: discordId(data.ownerId), deviceName: data.deviceName.trim() };
}
export function discordSettings(value: unknown): DiscordSettings {
  const data = discordRecord(value);
  // Empty IDs are permitted only in the initial, unconfigured snapshot.
  const prefs = data.guildId === '' && data.ownerId === '' && data.enabled === false
    ? { enabled: false, guildId: '', ownerId: '', deviceName: String(data.deviceName ?? '') }
    : discordPreferences(data);
  if (typeof data.hasToken !== 'boolean' || typeof data.connected !== 'boolean' || typeof data.status !== 'string'
    || !Number.isSafeInteger(data.channels) || Number(data.channels) < 0 || !Number.isSafeInteger(data.pending) || Number(data.pending) < 0) throw new TypeError('Invalid Discord settings.');
  return { ...prefs, hasToken: data.hasToken, connected: data.connected, status: data.status, channels: Number(data.channels), pending: Number(data.pending) };
}
