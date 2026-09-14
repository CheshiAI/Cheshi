import { setTimeout as delay } from 'node:timers/promises';
import type { ActiveTurn, CodexChatClient } from './codex-chat-types.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

async function runningCommands(client: CodexChatClient, active: ActiveTurn) {
  const processes = new Map<string, string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = recordValue(await client.request('thread/backgroundTerminals/list', {
      threadId: active.threadId, ...(cursor ? { cursor } : {}), limit: 100,
    }, 5000));
    if (!page || !Array.isArray(page.data)) throw new Error('Codex returned an invalid running command list.');
    for (const value of page.data) {
      const item = recordValue(value);
      const itemId = stringValue(item?.itemId);
      const processId = stringValue(item?.processId);
      if (!itemId || !processId) throw new Error('Codex returned an invalid running command identity.');
      if (active.commands.has(itemId)) processes.set(processId, itemId);
    }
    if (page.nextCursor !== null && typeof page.nextCursor !== 'string') {
      throw new Error('Codex returned an invalid running command cursor.');
    }
    cursor = stringValue(page.nextCursor);
    if (cursor && cursors.has(cursor)) throw new Error('Codex repeated a running command cursor.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return processes;
}

/** Terminate only commands observed in this turn; never use OS PIDs or thread-wide cleanup. */
export async function stopCodexCommands(
  client: CodexChatClient, active: ActiveTurn, isTurnComplete: () => boolean = () => false,
): Promise<void> {
  if (!active.commands.size) return;
  const terminated = new Set<string>();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const running = await runningCommands(client, active);
    const targets = new Map(running);
    for (const [itemId, command] of active.commands) {
      if (!command.completed && command.processId && !terminated.has(itemId)) targets.set(command.processId, itemId);
    }
    for (const [processId, itemId] of targets) {
      const result = recordValue(await client.request('thread/backgroundTerminals/terminate', {
        threadId: active.threadId, processId,
      }, 5000));
      switch (result?.terminated) {
        case true:
          terminated.add(itemId);
          break;
        case false:
          break;
        default:
          throw new Error('Codex returned an invalid command termination result.');
      }
    }
    const remaining = await runningCommands(client, active);
    const unconfirmed = [...active.commands].some(([itemId, command]) => !command.completed && !terminated.has(itemId));
    // Interrupt can finish the turn without a final item/completed notification.
    // Only reconcile that stale item state when the turn AND process list agree.
    if (remaining.size === 0 && (!unconfirmed || isTurnComplete() === true)) return;
    await delay(50);
  }
  throw new Error('Could not confirm that all commands stopped. Press Stop again to retry.');
}
