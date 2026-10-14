import { chatImportLabel, assertChatImportNumbers } from '../../../../shared/chat-imports';
import type { CodexChatAttachment } from '../../cheshiDesktop';
import { mergeChatAttachments } from './attachmentTransferModel';
import type { ChatInputHandle } from './chatInputHandle';

export interface ChatImportDraft { draft: string; attachments: CodexChatAttachment[] }
export interface ChatImportSelection { start: number; end: number }

export function insertChatImportText(draft: string, labels: string[], selection?: ChatImportSelection) {
  const start = Math.max(0, Math.min(selection?.start ?? draft.length, draft.length));
  const end = Math.max(start, Math.min(selection?.end ?? start, draft.length));
  const before = draft.slice(0, start), after = draft.slice(end);
  const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${labels.join(' ')}${after && !/^\s/.test(after) ? ' ' : ''}`;
  return { draft: before + inserted + after, caret: start + inserted.length };
}

export function addChatImports(input: ChatImportDraft, incoming: readonly CodexChatAttachment[], selection?: ChatImportSelection) {
  const merged = mergeChatAttachments(input.attachments, incoming);
  const previous = new Set(input.attachments.map(item => item.path));
  if (merged.every(item => previous.has(item.path))) return { ...input, caret: null };
  assertChatImportNumbers(input.attachments);
  const reserved = new Set(input.attachments.flatMap(item => item.importNumber === undefined ? [] : [item.importNumber]));
  for (const match of input.draft.matchAll(/\[import (\d+)\]/g)) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0 && number <= 1_000_000) reserved.add(number);
  }
  let next = 1;
  for (const number of reserved) next = Math.max(next, number + 1);
  const attachments = merged.map(item => {
    if (previous.has(item.path) && item.importNumber !== undefined) return item;
    if (next > 1_000_000) next = 1;
    while (reserved.has(next)) next += 1;
    reserved.add(next);
    return { ...item, importNumber: next++ };
  });
  const added = attachments.filter(item => !previous.has(item.path));
  const inserted = insertChatImportText(input.draft, added.map(item => chatImportLabel(item.importNumber!)), selection);
  return { ...inserted, attachments };
}

export function removeChatImport(input: ChatImportDraft, path: string): ChatImportDraft {
  const item = input.attachments.find(attachment => attachment.path === path);
  return {
    draft: item?.importNumber === undefined ? input.draft : input.draft.replaceAll(chatImportLabel(item.importNumber), ''),
    attachments: input.attachments.filter(attachment => attachment.path !== path),
  };
}

export function chatImportSelection(input: ChatInputHandle | null, draft: string): ChatImportSelection | undefined {
  return input?.value === draft ? { start: input.selectionStart, end: input.selectionEnd } : undefined;
}
