import type { TemporaryChatRequest, TemporaryChatResult } from '../../../../shared/temporary-chat';
import type { CodexChatAttachment } from '../../cheshiDesktop';
import type { ChatModel } from './model';

export interface TemporaryChatApi {
  models(sessionId: string): Promise<ChatModel[]>;
  send(sessionId: string, request: TemporaryChatRequest): Promise<TemporaryChatResult>;
  selectAttachments(sessionId: string): Promise<CodexChatAttachment[]>;
  close(sessionId: string): Promise<void>;
}

export interface TemporaryChatMessage {
  role: 'user' | 'assistant';
  createdAt: number;
  text: string;
  attachments: CodexChatAttachment[];
}

export interface TemporaryChatState {
  models: ChatModel[];
  model: string;
  effort: string;
  messages: TemporaryChatMessage[];
  draft: string;
  attachments: CodexChatAttachment[];
  loading: boolean;
  busy: boolean;
  picking: boolean;
  failed: boolean;
  error: string | null;
}

export function initialTemporaryChatState(): TemporaryChatState {
  return { models: [], model: '', effort: '', messages: [], draft: '', attachments: [],
    loading: true, busy: false, picking: false, failed: false, error: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Temporary chat could not complete the request.';
}

/** Owns one panel's in-memory state and prevents late operations from reviving a closed session. */
export class TemporaryChatSession {
  private readonly api: TemporaryChatApi;
  private readonly id: string;
  private readonly onChange: (state: TemporaryChatState) => void;
  private state = initialTemporaryChatState();
  private closed = false;
  private closeFlight: Promise<void> | null = null;

  constructor(api: TemporaryChatApi, id: string, onChange: (state: TemporaryChatState) => void) {
    this.api = api;
    this.id = id;
    this.onChange = onChange;
  }

  private update(patch: Partial<TemporaryChatState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  async start(): Promise<void> {
    if (this.closed) return;
    try {
      const models = await this.api.models(this.id);
      if (this.closed) return;
      const selected = models.find(model => model.isDefault) ?? models[0];
      if (!selected) {
        this.update({ loading: false, failed: true, error: 'No models are available. Close and reopen to retry.' });
        return;
      }
      this.update({ models, model: selected.model, effort: selected.defaultReasoningEffort, loading: false });
    } catch (error) {
      this.update({ loading: false, failed: true, error: `${errorMessage(error)} Close and reopen to retry.` });
    }
  }

  setDraft(draft: string): void { this.update({ draft }); }

  selectModel(model: string): void {
    if (this.state.busy || this.state.failed) return;
    const selected = this.state.models.find(option => option.model === model);
    if (selected) this.update({ model, effort: selected.defaultReasoningEffort });
  }

  selectEffort(effort: string): void {
    if (this.state.busy || this.state.failed) return;
    const model = this.state.models.find(option => option.model === this.state.model);
    if (model?.supportedReasoningEfforts.some(option => option.effort === effort)) this.update({ effort });
  }

  removeAttachment(path: string): void {
    if (this.state.busy) return;
    this.update({ attachments: this.state.attachments.filter(attachment => attachment.path !== path) });
  }

  async selectAttachments(): Promise<void> {
    if (this.closed || this.state.busy || this.state.picking || this.state.failed) return;
    this.update({ picking: true, error: null });
    try {
      const selected = await this.api.selectAttachments(this.id);
      if (this.closed) return;
      const attachments = [...new Map([...this.state.attachments, ...selected]
        .map(attachment => [attachment.path, attachment])).values()];
      if (attachments.length > 20) {
        this.update({ error: 'Attach up to 20 files per message.' });
      } else this.update({ attachments });
    } catch (error) {
      this.update({ error: errorMessage(error) });
    } finally {
      this.update({ picking: false });
    }
  }

  async send(): Promise<void> {
    const state = this.state;
    if (this.closed || state.loading || state.busy || state.picking || state.failed
      || !state.model || (!state.draft.trim() && state.attachments.length === 0)) return;
    const request = { model: state.model, effort: state.effort, text: state.draft, attachments: state.attachments };
    const user: TemporaryChatMessage = { role: 'user', createdAt: Date.now() / 1000, text: state.draft, attachments: state.attachments };
    this.update({ busy: true, error: null, draft: '', attachments: [], messages: [...state.messages, user] });
    try {
      const response = await this.api.send(this.id, request);
      this.update({ messages: [...state.messages, user, { role: 'assistant', createdAt: Date.now() / 1000, text: response.text, attachments: [] }] });
    } catch (error) {
      this.update({ messages: state.messages, draft: state.draft, attachments: state.attachments, failed: true,
        error: `${errorMessage(error)} Close and reopen to start a new temporary chat.` });
    } finally {
      this.update({ busy: false });
    }
  }

  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    this.closed = true;
    this.state = initialTemporaryChatState();
    this.closeFlight = this.api.close(this.id);
    return this.closeFlight;
  }
}
