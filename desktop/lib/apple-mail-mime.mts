import PostalMime from 'postal-mime';
import { MAIL_BODY_LIMIT, MAIL_SOURCE_LIMIT, MAIL_INLINE_IMAGE_LIMIT, MAIL_INLINE_IMAGE_COUNT, MAIL_IMAGE_TYPES } from '../shared/apple-mail.ts';
import type { MailMessage, MailInlineImage } from '../shared/apple-mail.ts';

export function mailSource(value: unknown): string | null {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>).source : null;
  return typeof source === 'string' && Buffer.byteLength(source, 'utf8') <= MAIL_SOURCE_LIMIT ? source : null;
}

/** Parse locally; do not fetch remote resources or persist private message contents. */
export async function withMailHtml(message: MailMessage, source: string | null): Promise<MailMessage> {
  if (!source || Buffer.byteLength(source, 'utf8') > MAIL_SOURCE_LIMIT) return message;
  try {
    const parsed = await PostalMime.parse(source, {
      attachmentEncoding: 'base64', maxNestingDepth: 32, maxHeadersSize: 100_000,
      forceRfc822Attachments: true, maxRfc822NestingDepth: 0,
    });
    const html = parsed.html?.replaceAll('\0', '');
    if (!html?.trim() || html.length > MAIL_BODY_LIMIT) return message;
    const inlineImages: MailInlineImage[] = [];
    const seen = new Set<string>();
    let size = 0;
    for (const attachment of parsed.attachments) {
      const contentId = attachment.contentId?.replace(/^<|>$/g, '').trim();
      if (!contentId || contentId.includes('\0') || contentId.length > 4096 || seen.has(contentId)
        || !MAIL_IMAGE_TYPES.some(type => type === attachment.mimeType)
        || typeof attachment.content !== 'string' || !attachment.content) continue;
      if (inlineImages.length >= MAIL_INLINE_IMAGE_COUNT || size + attachment.content.length > MAIL_INLINE_IMAGE_LIMIT) continue;
      seen.add(contentId);
      size += attachment.content.length;
      inlineImages.push({ contentId, mimeType: attachment.mimeType, base64: attachment.content });
    }
    return { ...message, html, inlineImages };
  } catch {
    // Broken MIME must not hide the readable text or expose parser diagnostics.
    return message;
  }
}
