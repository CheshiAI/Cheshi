import type { CodexChatAttachment } from '../../cheshiDesktop';
import type { ChatSkill } from './model';

export type ChatSendResult = { status: 'accepted' | 'failed' | 'unknown' | 'blocked'; message?: string };
export interface ChatDraftSnapshot {
  draft: string;
  selectedSkill: ChatSkill | null;
  attachments: CodexChatAttachment[];
}
export interface ChatDraftState extends ChatDraftSnapshot {
  pending: boolean;
  recovery: { input: ChatDraftSnapshot; status: 'restored' | 'available' | 'unknown'; message: string } | null;
}

const emptyDraft = (): ChatDraftSnapshot => ({ draft: '', selectedSkill: null, attachments: [] });

export function chatSendFailure(value: unknown): ChatSendResult | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return (record.sendFailure === 'failed' || record.sendFailure === 'unknown') && typeof record.message === 'string'
    ? { status: record.sendFailure, message: record.message } : null;
}

/** Keeps failed submissions separate from edits made while a request is pending. */
export function createChatDraftRecovery(send: (input: ChatDraftSnapshot) => Promise<ChatSendResult>) {
  let state: ChatDraftState = { ...emptyDraft(), pending: false, recovery: null };
  let revision = 0;
  let session = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ChatDraftState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const empty = () => !state.draft && !state.selectedSkill && state.attachments.length === 0;
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit<K extends keyof ChatDraftSnapshot>(key: K, value: ChatDraftSnapshot[K] | ((current: ChatDraftSnapshot[K]) => ChatDraftSnapshot[K])) {
      revision += 1;
      update({ [key]: typeof value === 'function' ? value(state[key]) : value });
    },
    reset() {
      session += 1;
      revision += 1;
      update({ ...emptyDraft(), pending: false, recovery: null });
    },
    restore() {
      if (state.pending || state.recovery?.status !== 'available' || !empty()) return false;
      revision += 1;
      update({ ...state.recovery.input, recovery: { ...state.recovery, status: 'restored' } });
      return true;
    },
    async submit(): Promise<boolean> {
      if (state.pending || !state.draft.trim()) return false;
      const input = { draft: state.draft, selectedSkill: state.selectedSkill, attachments: [...state.attachments] };
      const originalSession = session;
      const originalRevision = revision;
      update({ ...emptyDraft(), pending: true, recovery: null });
      let result: ChatSendResult;
      try { result = await send(input); }
      catch (error) { result = { status: 'unknown', message: error instanceof Error ? error.message : String(error) }; }
      if (originalSession !== session) return result.status === 'accepted';
      if (result.status === 'accepted') { update({ pending: false }); return true; }
      const message = result.message ?? 'The message was not sent.';
      if (result.status === 'unknown') {
        update({ pending: false, recovery: { input, status: 'unknown', message } });
      } else if (revision === originalRevision) {
        update({ ...input, pending: false, recovery: { input, status: 'restored', message } });
      } else {
        update({ pending: false, recovery: { input, status: 'available', message } });
      }
      return false;
    },
  };
}
