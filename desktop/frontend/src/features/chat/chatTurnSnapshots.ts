import type { ChatSavedTurnInput } from '../../../../shared/chat-saved-turns';
import { parseChatRelayMessage } from '../../../../shared/chat-relay';
import { parseSavedChatTurnPrompt, savedChatTurnDisplayText } from '../../../../shared/chat-saved-turn-continuation';
import { relayAssistantDisplayText, relayDisplayText } from './chatRelayMessageView';
import type { ChatTimelineItem } from './model';

/** Key action rows by the final timeline item, preserving the saved response identity. */
export function completedChatTurnInputs(
  items: ChatTimelineItem[], threadId: string | null, sessionTitle: string, responding: boolean,
): Map<string, ChatSavedTurnInput> {
  const turns = new Map<string, ChatSavedTurnInput>();
  if (!threadId) return turns;
  let userText = '';
  let responses: string[] = [];
  let lastAssistant: Extract<ChatTimelineItem, { text: string }> | undefined;
  let lastItemId: string | undefined;
  const finish = () => {
    if (!lastAssistant || !lastItemId || responses.length === 0) return;
    turns.set(lastItemId, { threadId, itemId: lastAssistant.id, sessionTitle, userText,
      assistantText: responses.join('\n\n'), createdAt: lastAssistant.createdAt });
  };
  for (const item of items) {
    if (item.kind === 'user') {
      finish();
      const relay = parseChatRelayMessage(item.text);
      const savedTurn = relay ? null : parseSavedChatTurnPrompt(item.text);
      userText = relay ? relayDisplayText(relay) : savedTurn ? savedChatTurnDisplayText(savedTurn) : item.text;
      responses = [];
      lastAssistant = undefined;
      lastItemId = undefined;
    } else if (item.kind === 'assistant' || item.kind === 'plan') {
      const text = relayAssistantDisplayText(item.text, false);
      if (text.trim()) {
        responses.push(text);
        lastAssistant = item;
      }
    }
    if (item.kind !== 'user') lastItemId = item.id;
  }
  if (!responding) finish();
  return turns;
}

const SNAPSHOT_FIELDS = ['threadId', 'itemId', 'sessionTitle', 'userText', 'assistantText', 'createdAt'] as const;

function sameSnapshot(previous: ChatSavedTurnInput | undefined, next: ChatSavedTurnInput): previous is ChatSavedTurnInput {
  return previous !== undefined && SNAPSHOT_FIELDS.every(field => previous[field] === next[field]);
}

interface CachedTurn {
  items: ChatTimelineItem[];
  snapshot: [string, ChatSavedTurnInput] | undefined;
}

/** Per timeline: reuse completed turns without reparsing their text during live output. */
export function createCompletedChatTurnCache() {
  let previousThreadId: string | null = null;
  let previousTitle = '';
  let cache = new Map<string, CachedTurn>();
  let result = new Map<string, ChatSavedTurnInput>();

  return (items: ChatTimelineItem[], threadId: string | null, sessionTitle: string, responding: boolean) => {
    const sameContext = threadId === previousThreadId && sessionTitle === previousTitle;
    const nextCache = new Map<string, CachedTurn>();
    const next = new Map<string, ChatSavedTurnInput>();
    const finish = (start: number, end: number) => {
      if (start === end) return;
      const key = items[start]!.id;
      let entry = sameContext ? cache.get(key) : undefined;
      if (!entry || entry.items.length !== end - start
        || !entry.items.every((item, index) => item === items[start + index])) {
        const turnItems = items.slice(start, end);
        entry = { items: turnItems,
          snapshot: completedChatTurnInputs(turnItems, threadId, sessionTitle, false).entries().next().value };
      }
      nextCache.set(key, entry);
      if (entry.snapshot) {
        const [id, input] = entry.snapshot;
        const previous = sameContext ? result.get(id) : undefined;
        next.set(id, sameSnapshot(previous, input) ? previous : input);
      }
    };
    if (threadId) {
      let start = 0;
      for (let index = 0; index < items.length; index++) {
        if (items[index]!.kind === 'user') { finish(start, index); start = index; }
      }
      // The unfinished tail has no actions yet and needs no response snapshot.
      if (!responding) finish(start, items.length);
    }
    previousThreadId = threadId;
    previousTitle = sessionTitle;
    cache = nextCache;
    if (result.size !== next.size || [...next].some(([id, input]) => result.get(id) !== input)) result = next;
    return result;
  };
}
