import type { IpcRenderer } from 'electron';
import { DISCORD_CHANNEL, discordConfirmation, discordPreferences, discordSettings, type DiscordApi } from '../shared/discord.ts';
export function createDiscordApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): DiscordApi {
  return {
    get: async () => discordSettings(await ipc.invoke(`${DISCORD_CHANNEL}:get`)),
    save: async value => discordSettings(await ipc.invoke(`${DISCORD_CHANNEL}:save`, { ...discordPreferences(value), token: value.token })),
    test: async () => discordSettings(await ipc.invoke(`${DISCORD_CHANNEL}:test`)),
    setup: async contextId => {
      const value: unknown = await ipc.invoke(`${DISCORD_CHANNEL}:setup`, contextId);
      if (typeof value !== 'string') throw new TypeError('Invalid setup skill path.');
      return value;
    },
    getConfirmation: async () => discordConfirmation(await ipc.invoke(`${DISCORD_CHANNEL}:confirmation`)),
    onConfirmation: listener => {
      const handler = (_event: unknown, value: unknown) => listener(discordConfirmation(value));
      ipc.on(`${DISCORD_CHANNEL}:confirmation-changed`, handler);
      return () => { ipc.removeListener(`${DISCORD_CHANNEL}:confirmation-changed`, handler); };
    },
    respondConfirmation: async (id, accepted) => { await ipc.invoke(`${DISCORD_CHANNEL}:confirm`, { id, accepted }); },
  };
}
