import { describe, expect, test } from 'bun:test';
import { openChatHistoryFork } from '../frontend/src/features/chat/openChatHistoryFork';
import type { ChatSplitApi } from '../frontend/src/features/chat/prepareChatSplit';

function sessionResponse(id: string) {
  return { session: { id, title: 'Conversation' }, items: [] };
}

function fixture(overrides: Partial<ChatSplitApi> = {}) {
  const calls: unknown[][] = [];
  const api: ChatSplitApi = {
    async openCodexChatSession(threadId, contextId) {
      calls.push(['prepare', threadId, contextId]);
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
  const openFork = async (threadId: string): Promise<boolean> => {
    calls.push(['open', threadId]);
    return true;
  };
  return { api, calls, openFork };
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected opening a history fork to fail.');
}

describe('opening a conversation history fork', () => {
  test('prepares in a temporary context, opens only the fork, and then releases the context', async () => {
    const { api, calls, openFork } = fixture();
    expect(await openChatHistoryFork(api, 'source-thread', 'temporary', openFork)).toBe(true);
    expect(calls).toEqual([
      ['prepare', 'source-thread', 'temporary'],
      ['fork', 'temporary'],
      ['open', 'forked-thread'],
      ['dispose', 'temporary'],
    ]);
  });

  test('does not replace the current conversation or dispose twice when preparation fails', async () => {
    const preparationError = new Error('Fork failed.');
    const { api, calls, openFork } = fixture({
      forkCodexChatSession: async () => { throw preparationError; },
    });
    expect(await rejection(openChatHistoryFork(api, 'source-thread', 'temporary', openFork)))
      .toBe(preparationError);
    expect(calls).toEqual([
      ['prepare', 'source-thread', 'temporary'],
      ['dispose', 'temporary'],
    ]);
  });

  test('does not retry cleanup when preparation and its cleanup both fail', async () => {
    const preparationError = new Error('Fork failed.');
    const cleanupError = new Error('Cleanup failed.');
    let cleanupCalls = 0;
    const { api, calls, openFork } = fixture({
      forkCodexChatSession: async () => { throw preparationError; },
      disposeCodexChatContext: async () => { cleanupCalls += 1; throw cleanupError; },
    });
    const error = await rejection(openChatHistoryFork(api, 'source-thread', 'temporary', openFork));
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Expected aggregate failure.');
    expect(error.errors).toEqual([preparationError, cleanupError]);
    expect(cleanupCalls).toBe(1);
    expect(calls).toEqual([['prepare', 'source-thread', 'temporary']]);
  });

  test('releases the temporary context when the target pane declines the open', async () => {
    const { api, calls } = fixture();
    expect(await openChatHistoryFork(api, 'source-thread', 'temporary', async () => false)).toBe(false);
    expect(calls.at(-1)).toEqual(['dispose', 'temporary']);
  });

  test('releases the temporary context and retains the opening error', async () => {
    const openingError = new Error('Could not open the fork.');
    const { api, calls } = fixture();
    const error = await rejection(openChatHistoryFork(api, 'source-thread', 'temporary', async () => {
      throw openingError;
    }));
    expect(error).toBe(openingError);
    expect(calls.at(-1)).toEqual(['dispose', 'temporary']);
  });

  test('retains both opening and cleanup errors, including an undefined rejection', async () => {
    for (const openingError of [new Error('Could not open the fork.'), undefined]) {
      const cleanupError = new Error('Cleanup failed.');
      const { api } = fixture({ disposeCodexChatContext: async () => { throw cleanupError; } });
      const error = await rejection(openChatHistoryFork(api, 'source-thread', 'temporary', async () => {
        throw openingError;
      }));
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error('Expected aggregate failure.');
      expect(error.errors).toEqual([openingError, cleanupError]);
      expect(error.cause).toBe(openingError);
    }
  });

  test('reports cleanup failure even after the fork was opened', async () => {
    const cleanupError = new Error('Cleanup failed.');
    const { api, calls, openFork } = fixture({
      disposeCodexChatContext: async () => { throw cleanupError; },
    });
    expect(await rejection(openChatHistoryFork(api, 'source-thread', 'temporary', openFork)))
      .toBe(cleanupError);
    expect(calls.at(-1)).toEqual(['open', 'forked-thread']);
  });
});
