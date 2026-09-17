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
  client: CodexChatClient, active: ActiveTurn, isTurnCompleted: () => boolean = () => false,
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
    // Interruption may omit individual item completions. A completed turn plus a
    // subsequent empty process list confirms cleanup without those notifications.
    const turnCompleted = isTurnCompleted() === true;
    const remaining = await runningCommands(client, active);
    const unconfirmed = [...active.commands].some(([itemId, command]) => !command.completed && !terminated.has(itemId));
    if (remaining.size === 0 && (turnCompleted || !unconfirmed)) return;
    await delay(50);
  }
  throw new Error('Some commands are still running. Press Stop again to retry.');
}
