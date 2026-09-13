import { prepareChatFork, type ChatSplitApi } from './prepareChatSplit';

/** Prepare the fork separately so a failed fork never replaces the current conversation. */
export async function openChatHistoryFork(
  api: ChatSplitApi,
  sourceThreadId: string,
  temporaryContextId: string,
  openFork: (threadId: string) => Promise<boolean>,
): Promise<boolean> {
  const forkThreadId = await prepareChatFork(api, sourceThreadId, temporaryContextId);
  let openingFailure: { error: unknown } | undefined;
  try {
    return await openFork(forkThreadId);
  } catch (error) {
    openingFailure = { error };
    throw error;
  } finally {
    try {
      await api.disposeCodexChatContext(temporaryContextId);
    } catch (cleanupError) {
      if (openingFailure) {
        throw new AggregateError(
          [openingFailure.error, cleanupError],
          'Could not open the fork or release its temporary chat context.',
          { cause: openingFailure.error },
        );
      }
      throw cleanupError;
    }
  }
}
