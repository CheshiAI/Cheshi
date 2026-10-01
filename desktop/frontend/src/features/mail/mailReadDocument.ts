import createDOMPurify from 'dompurify';
import { mailLink } from './mailHtmlDocument';
import { mailReadDeclarations, mailReadImageUrl, mailReadStyles } from './mailReadStyles';

const TAGS = ['html', 'head', 'body', 'style', 'a', 'abbr', 'address', 'article', 'b', 'bdi', 'bdo', 'big', 'blockquote',
  'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark',
  'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'wbr'];
const ATTRIBUTES = ['align', 'alt', 'background', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class', 'color',
  'colspan', 'dir', 'face', 'height', 'href', 'id', 'lang', 'nowrap', 'rowspan', 'scope', 'size', 'src', 'start',
  'style', 'text', 'title', 'type', 'valign', 'value', 'width'];

/** Prepare a passive reading tree before attaching anything to the app document. */
export function mailReadDocument(source: string, remoteImages: boolean, view: Window & typeof globalThis) {
  const html = createDOMPurify(view).sanitize(source, { WHOLE_DOCUMENT: true, RETURN_DOM: true,
    ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRIBUTES, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
  if (!(html instanceof view.HTMLElement)) throw new TypeError('Invalid mail reading document');
  for (const element of [html, ...html.querySelectorAll<HTMLElement>('*')]) {
    if (element.tagName === 'STYLE') element.textContent = mailReadStyles(element.textContent ?? '', remoteImages, view);
    if (element.hasAttribute('style')) element.setAttribute('style', mailReadDeclarations(element.style, remoteImages, element.tagName === 'IMG'));
    if (element.tagName !== 'IMG') element.removeAttribute('height');
    for (const attribute of ['src', 'background']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const safe = attribute === 'background' || element.tagName === 'IMG' ? mailReadImageUrl(value, remoteImages) : null;
      if (safe) element.setAttribute(attribute, safe);
      else element.removeAttribute(attribute);
    }
    if (element.tagName === 'IMG') element.setAttribute('referrerpolicy', 'no-referrer');
    if (element.hasAttribute('href')) {
      const href = element.tagName === 'A' ? mailLink(element.getAttribute('href')!) : null;
      if (href) { element.setAttribute('href', href); element.setAttribute('rel', 'noopener noreferrer'); }
      else element.removeAttribute('href');
    }
  }
  const body = html.querySelector('body');
  if (!body) throw new TypeError('Missing mail reading body');
  return { html, body };
}
