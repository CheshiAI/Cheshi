import { createContext, useContext, useLayoutEffect } from 'react';

type AttachToDraft = (files: (File | string)[]) => Promise<boolean>;

export function createChatDraftAttachments() {
  const targets = new Map<string, AttachToDraft>();
  return {
    register(paneId: string, attach: AttachToDraft) {
      targets.set(paneId, attach);
      return () => { if (targets.get(paneId) === attach) targets.delete(paneId); };
    },
    attach(paneId: string, files: (File | string)[]): Promise<boolean> {
      return targets.get(paneId)?.(files) ?? Promise.resolve(false);
    },
  };
}

export const ChatDraftAttachmentsContext = createContext<ReturnType<typeof createChatDraftAttachments> | null>(null);

export function useChatDraftAttachmentTarget(paneId: string | undefined, attach: AttachToDraft) {
  const targets = useContext(ChatDraftAttachmentsContext);
  useLayoutEffect(() => paneId === undefined ? undefined : targets?.register(paneId, attach), [targets, paneId, attach]);
}
