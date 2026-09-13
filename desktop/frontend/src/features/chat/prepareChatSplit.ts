import type { CheshiDesktopApi } from '../../cheshiDesktop';
import { normalizeOpenSessionResponse } from './model';

export type ChatSplitApi = Pick<CheshiDesktopApi,
  'openCodexChatSession' | 'forkCodexChatSession' | 'disposeCodexChatContext'>;

type OpenedSession = ReturnType<typeof normalizeOpenSessionResponse>;

function assertForkSource(opened: OpenedSession, sourceThreadId: string): void {
  if (opened.session.id !== sourceThreadId) {
    throw new Error('The selected conversation could not be opened for forking.');
  }
  if (opened.responseInProgress) {
    throw new Error('Wait for the current response to finish before forking this conversation.');
  }
}

function assertForkResult(opened: OpenedSession, sourceThreadId: string): void {
  if (opened.session.id === sourceThreadId) {
    throw new Error('Codex did not create a separate conversation for the fork.');
  }
}

/** The caller owns the fresh destination context after this operation succeeds. */
export async function prepareChatFork(
  api: ChatSplitApi,
  sourceThreadId: string,
  destinationContextId: string,
): Promise<string> {
  if (!sourceThreadId.trim() || !destinationContextId.trim()) {
    throw new Error('A source conversation and a new chat context are required to fork.');
  }
  try {
    const source = normalizeOpenSessionResponse(
      await api.openCodexChatSession(sourceThreadId, destinationContextId),
    );
    assertForkSource(source, sourceThreadId);
    const fork = normalizeOpenSessionResponse(await api.forkCodexChatSession(destinationContextId));
    assertForkResult(fork, sourceThreadId);
    return fork.session.id;
  } catch (error) {
    try {
      await api.disposeCodexChatContext(destinationContextId);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Could not prepare the fork or release its chat context.', {
        cause: error,
      });
    }
    throw error;
  }
}
