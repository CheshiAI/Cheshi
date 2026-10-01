export interface MailReplySegment { id: string; text: string }
export interface MailReplyEditingRequest {
  requestId: string;
  originalMessage: string;
  segments: MailReplySegment[];
}
export interface MailReplyEditingResult {
  requestId: string;
  model: string;
  segments: MailReplySegment[];
}

export function mailEditedReply(value: unknown, input: MailReplyEditingRequest): MailReplyEditingResult {
  const result = value as MailReplyEditingResult | null;
  if (!result || result.requestId !== input.requestId || typeof result.model !== 'string'
    || !Array.isArray(result.segments) || result.segments.length !== input.segments.length) {
    throw new Error('Invalid mail editing response.');
  }
  let length = 0;
  const segments = result.segments.map((segment, index) => {
    const original = input.segments[index]!;
    if (!segment || segment.id !== original.id || typeof segment.text !== 'string'
      || segment.text.includes('\0') || (original.text.trim() ? !segment.text.trim() : segment.text !== original.text)) {
      throw new Error('Invalid mail editing segment.');
    }
    length += segment.text.length;
    if (length > 48_000) throw new Error('Edited mail is too large.');
    return { id: original.id, text: segment.text };
  });
  return { requestId: input.requestId, model: result.model, segments };
}
