/** User-selected files are referenced directly; temporary chat does not archive attachments. */
export interface TemporaryChatAttachment {
  kind: 'image' | 'file';
  name: string;
  path: string;
}

export interface TemporaryChatRequest {
  model: string;
  effort: string;
  text: string;
  attachments: TemporaryChatAttachment[];
}

export interface TemporaryChatResult {
  text: string;
  model: string;
}

export class TemporaryChatClosedError extends Error {
  constructor() {
    super('Temporary chat is closed.');
    this.name = 'TemporaryChatClosedError';
  }
}

export type TemporaryChatReply<T> = { status: 'ok'; value: T } | { status: 'closed' };

/** Expected cancellation crosses IPC as data, so Electron does not log it as a handler failure. */
export function readTemporaryChatReply<T>(value: unknown): T {
  const reply = objectValue(value);
  if (reply.status === 'closed') throw new TemporaryChatClosedError();
  if (reply.status !== 'ok' || !Object.hasOwn(reply, 'value')) {
    throw new TypeError('Invalid temporary chat response.');
  }
  return reply.value as T;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Temporary chat request must be an object.');
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')
    || (!allowEmpty && !value.trim())) {
    throw new TypeError(`Temporary chat ${label} is invalid (maximum ${limit} characters).`);
  }
  return value;
}

export function temporaryChatRequest(value: unknown): TemporaryChatRequest {
  const request = objectValue(value);
  const model = boundedString(request.model, 'model', 128);
  const effort = boundedString(request.effort, 'effort', 32);
  const text = boundedString(request.text, 'message', 128_000, true);
  const values = request.attachments ?? [];
  if (!Array.isArray(values) || values.length > 20) {
    throw new TypeError('Temporary chat supports up to 20 attachments.');
  }
  const attachments = values.map((value): TemporaryChatAttachment => {
    const attachment = objectValue(value);
    if (attachment.kind !== 'image' && attachment.kind !== 'file') {
      throw new TypeError('Temporary chat attachment kind is invalid.');
    }
    return {
      kind: attachment.kind,
      name: boundedString(attachment.name, 'attachment name', 1024),
      path: boundedString(attachment.path, 'attachment path', 4096),
    };
  });
  if (!text.trim() && attachments.length === 0) {
    throw new TypeError('Enter a message or attach a file.');
  }
  return { model, effort, text, attachments };
}
