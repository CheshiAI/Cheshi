import createDOMPurify from 'dompurify';
import type { MailInlineImage } from '../../../../shared/apple-mail';

export function mailLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function contentId(value: string): string {
  try { return decodeURIComponent(value).replace(/^<|>$/g, '').trim(); }
  catch { return ''; }
}

/** Expand the outer, single-column layout without stretching nested columns, buttons or logos. */
function expandMailLayout(body: HTMLElement) {
  let container: Element = body;
  while (true) {
    const children = [...container.children].filter(child => {
      const style = (child as HTMLElement).style;
      return !['STYLE', 'META', 'LINK'].includes(child.tagName) && !child.hasAttribute('hidden')
        && style?.display !== 'none';
    });
    if (children.length !== 1) return;
    const child = children[0]!;
    if (!['DIV', 'CENTER', 'MAIN', 'SECTION', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD'].includes(child.tagName)) return;
    if (['DIV', 'CENTER', 'MAIN', 'SECTION', 'TABLE'].includes(child.tagName)) {
      const style = (child as HTMLElement).style;
      style.setProperty('width', '100%', 'important');
      style.setProperty('max-width', 'none', 'important');
      style.setProperty('min-width', '0', 'important');
      style.setProperty('box-sizing', 'border-box', 'important');
      if (child.hasAttribute('width')) child.setAttribute('width', '100%');
    }
    container = child;
  }
}

/** Styles stay inside a script-disabled frame; all resource requests are constrained by its CSP. */
export function mailHtmlDocument(html: string, images: MailInlineImage[], allowRemoteImages: boolean, view: Window & typeof globalThis) {
  const clean = createDOMPurify(view).sanitize(html, {
    WHOLE_DOCUMENT: true, RETURN_DOM: true, USE_PROFILES: { html: true }, ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button',
      'textarea', 'select', 'option', 'video', 'audio', 'source', 'track', 'base', 'link', 'meta', 'template'],
    FORBID_ATTR: ['srcset', 'ping', 'srcdoc', 'action', 'formaction', 'target', 'download', 'autofocus'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  if (!(clean instanceof view.HTMLElement)) throw new TypeError('Invalid HTML document');
  const doc = clean.ownerDocument;
  const inline = new Map(images.map(image => [image.contentId, `data:${image.mimeType};base64,${image.base64}`]));
  let hasRemoteImages = false;
  const imageUrl = (value: string): string | null => {
    const url = value.trim();
    if (/^cid:/i.test(url)) return inline.get(contentId(url.slice(4))) ?? null;
    if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url)) return url;
    const remote = mailLink(url.startsWith('//') ? `https:${url}` : url);
    if (remote) hasRemoteImages = true;
    return allowRemoteImages ? remote : null;
  };
  const css = (value: string) => {
    const replaced = value.replace(/url\(\s*(['"]?)cid:([^'"\s)]+)\1\s*\)/gi,
      (_match, _quote: string, id: string) => `url("${inline.get(contentId(id)) ?? ''}")`);
    // Escaped CSS URLs are also gated by CSP, and get the same opt-in control.
    if (/url\(\s*['"]?(?:https?:|\/\/)|\\/i.test(replaced)) hasRemoteImages = true;
    return replaced;
  };
  for (const element of clean.querySelectorAll('*')) {
    for (const attribute of ['src', 'background']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const safe = attribute === 'background' || element.tagName === 'IMG' ? imageUrl(value) : null;
      if (safe) element.setAttribute(attribute, safe);
      else element.removeAttribute(attribute);
    }
    if (element.hasAttribute('href')) {
      const href = element.tagName === 'A' ? mailLink(element.getAttribute('href')!) : null;
      if (href) { element.setAttribute('href', href); element.setAttribute('rel', 'noopener noreferrer'); }
      else element.removeAttribute('href');
    }
    if (element.hasAttribute('style')) element.setAttribute('style', css(element.getAttribute('style')!));
    if (element.tagName === 'STYLE') element.textContent = css(element.textContent ?? '');
  }
  const body = clean.querySelector('body');
  if (body) expandMailLayout(body);
  const head = clean.querySelector('head') ?? clean.insertBefore(doc.createElement('head'), clean.firstChild);
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${allowRemoteImages ? ' https: http:' : ''}; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  head.prepend(policy);
  const referrer = doc.createElement('meta');
  referrer.name = 'referrer'; referrer.content = 'no-referrer'; head.append(referrer);
  const baseStyle = doc.createElement('style');
  baseStyle.textContent = 'html{color-scheme:light;height:auto!important;min-height:0!important}html,body{width:100%!important;max-width:none!important;box-sizing:border-box}body{height:auto!important;min-height:0!important;margin:0!important;overflow-wrap:anywhere}img{max-width:100%;height:auto}';
  head.insertBefore(baseStyle, policy.nextSibling);
  return { srcDoc: `<!doctype html>${clean.outerHTML}`, hasRemoteImages };
}
