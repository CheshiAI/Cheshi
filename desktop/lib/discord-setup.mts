import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { CodexChatService } from './codex-chat-service.mts';
import { armDiscordSetup, closeDiscordSetup, type DiscordSetupBrowser } from './discord-setup-tools.mts';

export async function startDiscordSetup(service: CodexChatService, createBrowser?: () => DiscordSetupBrowser): Promise<string> {
  if (service.activeTurns.size || service.pendingTurnStarts.size || service.pendingApprovals.size || service.userInputs.list().length) {
    throw new Error('Finish the current chat before starting the setup assistant.');
  }
  if (!createBrowser) throw new Error('Restart Cheshi to use the automated setup assistant.');
  const instructions = readFileSync(new URL('../../resources/skills/cheshi-discord-setup/SKILL.md', import.meta.url), 'utf8');
  await service.newSession();
  armDiscordSetup(service, createBrowser());
  const text = `Set up my personal Discord connection using the bundled cheshi-discord-setup skill below. Perform the setup with the cheshi_discord_setup tool; do not hand me a list of browser steps. Use English for all setup messages and progress. Begin by inspecting existing settings and opening the dedicated setup window. Do not request my bot token in chat.\n\n${instructions}`;
  try {
    const result = await service.sendMessage(text, randomUUID(), null, [], null);
    return result.threadId;
  } catch (error) { closeDiscordSetup(service); throw error; }
}
