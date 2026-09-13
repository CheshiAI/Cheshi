import { describe, expect, test } from 'bun:test';
import { prepareChatFork, type ChatSplitApi } from '../frontend/src/features/chat/prepareChatSplit';

function sessionResponse(id: string) {
  return { session: { id, title: 'Conversation' }, items: [] };
}

function fixture(overrides: Partial<ChatSplitApi> = {}) {
  const calls: unknown[][] = [];
  const api: ChatSplitApi = {
    async openCodexChatSession(threadId, contextId) {
      calls.push(['open', threadId, contextId]);
      return sessionResponse(threadId);
    },
    async forkCodexChatSession(contextId) {
      calls.push(['fork', contextId]);
      return sessionResponse('forked-thread');
    },
    async disposeCodexChatContext(contextId) {
      calls.push(['dispose', contextId]);
    },
    ...overrides,
  };
  return { api, calls };
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the fork preparation to fail.');
}

describe('split conversation fork preparation', () => {
  test('opens and forks only in the destination context and retains it for the new pane', async () => {
    const { api, calls } = fixture();
    expect(await prepareChatFork(api, 'source-thread', 'new-pane')).toBe('forked-thread');
    expect(calls).toEqual([
      ['open', 'source-thread', 'new-pane'],
      ['fork', 'new-pane'],
    ]);
  });

  test('does not fork until the source has finished opening', async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    const opened = new Promise<unknown>((resolve) => { resolveOpen = resolve; });
    const { api, calls } = fixture({ openCodexChatSession: async () => opened });
    const preparing = prepareChatFork(api, 'source-thread', 'new-pane');
    expect(calls).toEqual([]);
    resolveOpen?.(sessionResponse('source-thread'));
    expect(await preparing).toBe('forked-thread');
    expect(calls).toEqual([['fork', 'new-pane']]);
  });

  test('cleans up a failed open without forking or replacing its original error', async () => {
    const error = new Error('Could not read conversation.');
    const { api, calls } = fixture({ openCodexChatSession: async () => { throw error; } });
    expect(await rejection(prepareChatFork(api, 'source-thread', 'new-pane'))).toBe(error);
    expect(calls).toEqual([['dispose', 'new-pane']]);
  });

  test('rejects missing, mismatched, and actively responding source records before forking', async () => {
    for (const response of [
      null,
      sessionResponse('other-thread'),
      { ...sessionResponse('source-thread'), responseInProgress: true, responseThreadIds: ['source-thread'] },
    ]) {
      const { api, calls } = fixture({ openCodexChatSession: async () => response });
      expect(await rejection(prepareChatFork(api, 'source-thread', 'new-pane'))).toBeInstanceOf(Error);
      expect(calls).toEqual([['dispose', 'new-pane']]);
    }
  });

  test('cleans up if the fork fails, is malformed, or returns the original conversation', async () => {
    for (const forkCodexChatSession of [
      async () => { throw new Error('Fork rejected.'); },
      async () => ({ session: { id: 'forked-thread' } }),
      async () => sessionResponse('source-thread'),
    ]) {
      const { api, calls } = fixture({ forkCodexChatSession });
      expect(await rejection(prepareChatFork(api, 'source-thread', 'new-pane'))).toBeInstanceOf(Error);
      expect(calls).toEqual([
        ['open', 'source-thread', 'new-pane'],
        ['dispose', 'new-pane'],
      ]);
    }
  });

  test('preserves preparation and cleanup errors when both operations fail', async () => {
    const forkError = new Error('Fork rejected.');
    const cleanupError = new Error('Context cleanup failed.');
    const { api } = fixture({
      forkCodexChatSession: async () => { throw forkError; },
      disposeCodexChatContext: async () => { throw cleanupError; },
    });
    const error = await rejection(prepareChatFork(api, 'source-thread', 'new-pane'));
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Expected aggregate cleanup failure.');
    expect(error.errors).toEqual([forkError, cleanupError]);
    expect(error.cause).toBe(forkError);
  });

  test('rejects absent identifiers without touching any context', async () => {
    const { api, calls } = fixture();
    for (const [sourceId, contextId] of [['', 'new-pane'], ['source-thread', ' ']] as const) {
      expect(await rejection(prepareChatFork(api, sourceId, contextId))).toBeInstanceOf(Error);
    }
    expect(calls).toEqual([]);
  });
});
