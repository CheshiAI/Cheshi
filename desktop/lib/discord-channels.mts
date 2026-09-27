import type { DiscordRest } from './discord-rest.mts';
import path from 'node:path';
import type { DiscordBinding, DiscordData } from './discord-store.mts';
import { discordRecord, discordId } from '../shared/discord.ts';

export function discordChannelName(title: string, key: string) {
  return `${title.toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 75) || 'new-chat'}-${key.slice(0, 8)}`;
}
export function discordOverwrites(data: DiscordData, bot: string) {
  const { guildId, ownerId } = data.preferences;
  return [{ id: guildId, type: 0, allow: '0', deny: '1024' },
    ...[ownerId, bot].map(id => ({ id, type: 1, allow: '68608', deny: '0' }))];
}
export function assertDiscordPrivateChannel(value: unknown, data: DiscordData, bot: string) {
  const channel = discordRecord(value), expected = discordOverwrites(data, bot);
  if (!Array.isArray(channel.permission_overwrites) || channel.permission_overwrites.length !== expected.length) {
    throw new Error('Restore this channel’s private permissions before continuing.');
  }
  const entries = channel.permission_overwrites.map(discordRecord);
  if (!expected.every(wanted => entries.some(entry => entry.id === wanted.id && entry.type === wanted.type
    && entry.allow === wanted.allow && entry.deny === wanted.deny))) throw new Error('Restore this channel’s private permissions before continuing.');
}
export async function ensureDiscordChannel(rest: DiscordRest, data: DiscordData, bot: string, key: string, binding: DiscordBinding) {
  const guild = data.preferences.guildId;
  const marker = `[cheshi:${data.deviceId}:${key}]`;
  const topic = `${data.preferences.deviceName} · ${path.basename(binding.workspace)} · ${binding.title.slice(0, 120)}\n${marker}`;
  const name = discordChannelName(binding.title, key);
  const permissions = discordOverwrites(data, bot);
  // Recover a successful channel creation whose response or local write was lost.
  const channels = await rest('GET', `/guilds/${guild}/channels`);
  if (!Array.isArray(channels)) throw new Error('Could not list Discord channels.');
  const records = channels.map(discordRecord);
  const existing = records.find(channel => channel.type === 0 && typeof channel.topic === 'string' && channel.topic.endsWith(marker));
  if (existing) {
    const id = discordId(existing.id);
    assertDiscordPrivateChannel(existing, data, bot);
    if (existing.name !== name || existing.topic !== topic) await rest('PATCH', `/channels/${id}`, { name, topic });
    return id;
  }
  if (binding.channel) throw new Error('The linked Discord channel was removed or changed. Restore it before continuing.');
  if (records.length >= 498) throw new Error('Discord channel limit reached. Remove unused channels before creating another session.');
  const prefix = `${data.preferences.deviceName.slice(0, 55)} · ${data.deviceId.slice(0, 8)}`;
  let category = records.find(channel => channel.type === 4 && String(channel.name).startsWith(`${prefix} · `)
    && records.filter(child => child.parent_id === channel.id).length < 50);
  if (!category) {
    category = discordRecord(await rest('POST', `/guilds/${guild}/channels`, { name: `${prefix} · ${records.filter(channel => channel.type === 4 && String(channel.name).startsWith(prefix)).length + 1}`,
      type: 4, permission_overwrites: permissions }));
  }
  const created = discordRecord(await rest('POST', `/guilds/${guild}/channels`, {
    name, type: 0, topic, parent_id: discordId(category.id), permission_overwrites: permissions,
  }));
  return discordId(created.id);
}
