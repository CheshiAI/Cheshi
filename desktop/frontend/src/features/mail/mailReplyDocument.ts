import type { MailMessage } from '../../../../shared/apple-mail';
import { mailHtmlDocument } from './mailHtmlDocument';
import { MAIL_DEFAULT_BACKGROUND_COLOR, MAIL_DEFAULT_TEXT_COLOR } from './mailDocumentColors';
import { MAIL_DEFAULT_FONT_SIZE, retainMailFontSizes } from './mailDocumentTypography';

const EDITOR_STYLE = `body{padding:16px!important;min-height:240px!important;outline:none;font:${MAIL_DEFAULT_FONT_SIZE} Helvetica,Arial,sans-serif;color:${MAIL_DEFAULT_TEXT_COLOR};background:${MAIL_DEFAULT_BACKGROUND_COLOR}}blockquote[type="cite"]{margin:16px 0 0;padding:0 0 0 12px;border-left:2px solid #7564da}blockquote[type="cite"]>p:first-child{color:#7564da}`;

/** Keep resource URLs for outgoing HTML while the preview CSP controls fetching. */
export function mailReplyDocument(message: MailMessage, view: Window & typeof globalThis) {
  const source = message.html ?? '';
  const clean = mailHtmlDocument(source, message.inlineImages ?? [], true, view);
  const doc = new view.DOMParser().parseFromString(clean.srcDoc, 'text/html');
  const quote = doc.createElement('blockquote');
  quote.setAttribute('type', 'cite');
  const attribution = doc.createElement('p');
  attribution.textContent = `${message.date ? `On ${new Date(message.date).toLocaleString()}, ` : ''}${message.sender || 'Unknown sender'} wrote:`;
  quote.append(attribution);
  if (message.html) quote.append(...doc.body.childNodes);
  else {
    const text = doc.createElement('div');
    text.style.whiteSpace = 'pre-wrap';
    text.textContent = message.body;
    quote.append(text);
  }
  const paragraph = doc.createElement('p');
  paragraph.append(doc.createElement('br'));
  doc.body.replaceChildren(paragraph, quote);
  const style = doc.createElement('style');
  style.textContent = EDITOR_STYLE;
  doc.head.append(style);
  return serializeReplyDocument(doc);
}

export function serializeReplyDocument(doc: Document) {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  retainMailFontSizes(doc, clone);
  clone.querySelectorAll('meta').forEach(element => element.remove());
  clone.querySelectorAll('[contenteditable]').forEach(element => element.removeAttribute('contenteditable'));
  const body = clone.querySelector('body')!;
  body.removeAttribute('role'); body.removeAttribute('aria-label'); body.removeAttribute('aria-multiline');
  return `<!doctype html>${clone.outerHTML}`;
}

export function replyPreviewDocument(html: string, remoteImages: boolean, view: Window & typeof globalThis) {
  // Retain blocked image URLs so enabling images never resets edits or the undo stack.
  const clean = mailHtmlDocument(html, [], true, view);
  const doc = new view.DOMParser().parseFromString(clean.srcDoc, 'text/html');
  if (!remoteImages) {
    const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!;
    policy.setAttribute('content', policy.getAttribute('content')!.replace('img-src data: https: http:', 'img-src data:'));
  }
  return { srcDoc: `<!doctype html>${doc.documentElement.outerHTML}`, hasRemoteImages: clean.hasRemoteImages };
}
