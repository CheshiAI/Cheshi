import { mailEditedReply } from '../../../../shared/mail-reply';
import type { MailReplyEditingRequest, MailReplyEditingResult } from '../../../../shared/mail-reply';
import { applyMailDocumentColors, MAIL_DEFAULT_BACKGROUND_COLOR, MAIL_DEFAULT_TEXT_COLOR } from './mailDocumentColors';
import { MAIL_DEFAULT_FONT_SIZE } from './mailDocumentTypography';

/** Keep quoted mail, signatures, markup, links and image data outside model output. */
export function mailEditableDocument(html: string | undefined, body: string, requestId: string, originalMessage: string) {
  const document = html === undefined ? null : new window.DOMParser().parseFromString(html, 'text/html');
  const nodes: Text[] = [];
  if (document) {
    const walker = document.createTreeWalker(document.body, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (node.textContent?.trim() && parent && !parent.closest('blockquote, .AppleMailSignature, [data-mail-signature], script, style')) {
        nodes.push(node as Text);
      }
    }
  }
  const segments = document ? nodes.map((node, index) => ({ id: `text-${index}`, text: node.data })) : [{ id: 'body', text: body }];
  const request: MailReplyEditingRequest = { requestId, originalMessage: originalMessage.slice(0, 48_000), segments };
  if (!segments.some(segment => segment.text.trim())) throw new Error('Write a reply before sending.');
  return { request, apply(value: MailReplyEditingResult): { html: string; body: string } {
    const edited = mailEditedReply(value, request);
    if (!document) {
      const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const text = edited.segments[0]!.text;
      return { html: `<html><body><div style="font-family:Helvetica,Arial,sans-serif;font-size:${MAIL_DEFAULT_FONT_SIZE};white-space:pre-wrap;color:${MAIL_DEFAULT_TEXT_COLOR};background-color:${MAIL_DEFAULT_BACKGROUND_COLOR}">${escape(text)}</div></body></html>`, body: text };
    }
    nodes.forEach((node, index) => { node.data = edited.segments[index]!.text; });
    const outgoing = document.cloneNode(true) as Document;
    applyMailDocumentColors(outgoing);
    // Body is only a plain-text fallback for the clipboard; native HTML owns layout.
    return { html: `<!DOCTYPE html>${outgoing.documentElement.outerHTML}`, body: document.body.textContent ?? '' };
  } };
}
