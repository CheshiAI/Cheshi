import { createContext, useContext, useLayoutEffect } from 'react';

type AttachToDraft = (files: (File | string)[]) => Promise<boolean>;
type AppendTextToDraft = (text: string) => boolean | Promise<boolean>;

export function createChatDraftAttachments() {
  const targets = new Map<string, { attach: AttachToDraft; appendText?: AppendTextToDraft }>();
  return {
    register(paneId: string, attach: AttachToDraft, appendText?: AppendTextToDraft) {
      const target = { attach, appendText };
      targets.set(paneId, target);
      return () => { if (targets.get(paneId) === target) targets.delete(paneId); };
    },
    attach(paneId: string, files: (File | string)[]): Promise<boolean> {
      return targets.get(paneId)?.attach(files) ?? Promise.resolve(false);
    },
    async appendText(paneId: string, text: string): Promise<boolean> {
      if (!text.trim()) return false;
      return targets.get(paneId)?.appendText?.(text) ?? false;
    },
  };
}

export const ChatDraftAttachmentsContext = createContext<ReturnType<typeof createChatDraftAttachments> | null>(null);

export function useChatDraftAttachmentTarget(paneId: string | undefined, attach: AttachToDraft, appendText?: AppendTextToDraft) {
  const targets = useContext(ChatDraftAttachmentsContext);
  useLayoutEffect(() => paneId === undefined ? undefined : targets?.register(paneId, attach, appendText), [targets, paneId, attach, appendText]);
}
