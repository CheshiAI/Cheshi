import { useLayoutEffect, useRef, type RefObject } from 'react';
import { chatImportLabel } from '../../../../shared/chat-imports';
import type { CodexChatAttachment } from '../../cheshiDesktop';
import type { ChatDraftSnapshot } from './chatDraftRecovery';
import { addChatDroppedItems, chatImportSelection, insertChatImportText, removeChatImport } from './chatImportDraft';
import type { ChatDirectoryReference } from '../../../../shared/chat-attachment-import';
import type { ChatInputHandle } from './chatInputHandle';

/** Restore the caret after the input applies the new controlled draft value. */
export function useChatImportCaret(draft: string, textareaRef: RefObject<ChatInputHandle | null>, active = true) {
  const pending = useRef<{ draft: string; caret: number | null } | null>(null);
  useLayoutEffect(() => {
    const change = pending.current;
    pending.current = null;
    if (!active || !change || change.caret === null || change.draft !== draft) return;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(change.caret, change.caret);
  });
  return {
    selection: (value: string) => chatImportSelection(textareaRef.current, value),
    restore: (change: { draft: string; caret: number | null }) => { pending.current = change; },
  };
}

export function useChatImportDraft(draft: string, textareaRef: RefObject<ChatInputHandle | null>,
  editInput: (edit: (input: ChatDraftSnapshot) => ChatDraftSnapshot) => void, active: boolean) {
  const caret = useChatImportCaret(draft, textareaRef, active);
  const updateDraft = (value: string, imports?: readonly CodexChatAttachment[]) => editInput(input => ({
    ...input, draft: value, ...(imports === undefined ? {} : { attachments: [...imports] }),
  }));
  return {
    updateDraft,
    restoreInputHistory: updateDraft,
    addAttachments: (attachments: CodexChatAttachment[], directories: readonly ChatDirectoryReference[] = []) => editInput(input => {
      const change = addChatDroppedItems(input, attachments, directories, caret.selection(input.draft));
      caret.restore(change);
      return { ...input, draft: change.draft, attachments: change.attachments };
    }),
    removeAttachment: (path: string) => editInput(input => ({ ...input, ...removeChatImport(input, path) })),
    insertAttachmentReference: (path: string) => editInput(input => {
      const attachment = input.attachments.find(item => item.path === path);
      if (attachment?.importNumber === undefined) return input;
      const change = insertChatImportText(input.draft, [chatImportLabel(attachment.importNumber)], caret.selection(input.draft));
      caret.restore(change);
      return { ...input, draft: change.draft };
    }),
  };
}
