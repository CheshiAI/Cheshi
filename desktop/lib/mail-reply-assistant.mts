import { EphemeralSessionService } from './ephemeral-session-service.mts';
import { MAIL_REPLY_INSTRUCTIONS } from './mail-reply-instructions.mts';
import type { CodexChatClient } from './codex-chat-types.mts';
import { recordValue } from './codex-service-utils.mts';
import type { MailReplySegment, MailReplyEditingRequest, MailReplyEditingResult } from '../shared/mail-reply.ts';
export type { MailReplySegment, MailReplyEditingRequest, MailReplyEditingResult } from '../shared/mail-reply.ts';

const MAX_TEXT = 48_000;
const MAX_SEGMENTS = 256;
const schema = {
  type: 'object', additionalProperties: false, required: ['segments'],
  properties: { segments: { type: 'array', minItems: 1, maxItems: MAX_SEGMENTS,
    items: { type: 'object', additionalProperties: false, required: ['id', 'text'],
      properties: { id: { type: 'string' }, text: { type: 'string' } } } } },
};

function boundedText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
    throw new Error('Invalid mail reply text.');
  }
  return value;
}

function identifier(value: unknown): string {
  const text = boundedText(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(text)) throw new Error('Invalid mail reply identifier.');
  return text;
}

function requestSnapshot(value: unknown): MailReplyEditingRequest {
  const raw = recordValue(value);
  if (!raw || !Array.isArray(raw.segments) || raw.segments.length === 0 || raw.segments.length > MAX_SEGMENTS) {
    throw new Error('Provide between 1 and 256 editable reply segments.');
  }
  const segments = raw.segments.map((value: unknown) => {
    const segment = recordValue(value);
    return { id: identifier(segment?.id), text: boundedText(segment?.text, MAX_TEXT) };
  });
  if (new Set(segments.map(segment => segment.id)).size !== segments.length
    || segments.reduce((total, segment) => total + segment.text.length, 0) > MAX_TEXT
    || !segments.some(segment => segment.text.trim())) {
    throw new Error('Reply text must be non-empty, bounded and have unique segment IDs.');
  }
  const request = { requestId: identifier(raw.requestId), originalMessage: boundedText(raw.originalMessage, MAX_TEXT), segments };
  if (JSON.stringify(request).length > 120_000) throw new Error('The mail reply context is too large.');
  return request;
}

function parsedSegments(text: string, input: MailReplySegment[]): MailReplySegment[] {
  if (text.length > 120_000) throw new Error('The edited reply is too large.');
  const raw = recordValue(JSON.parse(text));
  if (!raw || Object.keys(raw).length !== 1 || !Array.isArray(raw.segments) || raw.segments.length !== input.length) {
    throw new Error('The mail agent returned an incomplete reply.');
  }
  let size = 0;
  return raw.segments.map((value: unknown, index: number) => {
    const row = recordValue(value);
    const original = input[index]!;
    if (!row || Object.keys(row).length !== 2 || row.id !== original.id) {
      throw new Error('The mail agent changed reply segment boundaries.');
    }
    const edited = boundedText(row.text, MAX_TEXT);
    size += edited.length;
    if (size > MAX_TEXT || (original.text.trim() ? !edited.trim() : edited !== original.text)) {
      throw new Error('The mail agent removed reply text or changed empty segments.');
    }
    return { id: original.id, text: edited };
  });
}

/** One isolated editing run at a time. No Mail access, UI automation or delivery occurs here. */
export class MailReplyAssistant {
  private readonly options: {
    cwd: string;
    model: string;
    effort: string;
    createClient(): CodexChatClient & { stop(): Promise<void> };
    timeoutMs?: number;
  };
  private active: AbortController | null = null;
  private stopped = false;

  constructor(options: MailReplyAssistant['options']) { this.options = options; }
  get busy(): boolean { return this.active !== null; }
  cancel(): void { this.active?.abort(new Error('Mail reply editing canceled.')); }
  stop(): void { this.stopped = true; this.cancel(); }

  async polish(value: unknown, signal?: AbortSignal): Promise<MailReplyEditingResult> {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error('The mail reply assistant has stopped.');
    if (this.active) throw new Error('The mail reply assistant is busy.');
    const request = requestSnapshot(value);
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    this.active = controller;
    let client: ReturnType<MailReplyAssistant['options']['createClient']> | undefined;
    let session: EphemeralSessionService | undefined;
    let output: MailReplyEditingResult;
    try {
      controller.signal.throwIfAborted();
      client = this.options.createClient();
      session = new EphemeralSessionService(client, this.options.cwd, this.options.timeoutMs ?? 90_000);
      const result = await session.run({ requestId: request.requestId,
        model: this.options.model, effort: this.options.effort, instructions: MAIL_REPLY_INSTRUCTIONS,
        input: JSON.stringify({ originalMessage: request.originalMessage, segments: request.segments }),
      }, { signal: controller.signal, outputSchema: schema, disableTools: true, serviceTier: 'default', requireSubscription: true });
      controller.signal.throwIfAborted();
      output = { requestId: request.requestId, model: result.model, segments: parsedSegments(result.text, request.segments) };
    } finally {
      session?.stop();
      try { await client?.stop(); }
      finally {
        signal?.removeEventListener('abort', cancel);
        this.active = null;
      }
    }
    controller.signal.throwIfAborted();
    return output;
  }
}
