// 9pt renders as 12 CSS pixels. Mail drops 12px during HTML paste/save, but
// retains the equivalent point value in the outgoing message.
export const MAIL_DEFAULT_FONT_SIZE = '9pt';

/** Snapshot only Mail's lossy 12px size; keep the live editor and other sizes. */
export function retainMailFontSizes(source: Document, clone: HTMLElement) {
  const view = source.defaultView;
  if (!view) return;
  const body = clone.querySelector('body')!;
  const originals = [source.body, ...source.body.querySelectorAll<HTMLElement>('*')];
  const copies = [body, ...body.querySelectorAll<HTMLElement>('*')];
  originals.forEach((element, index) => {
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      || element.matches('script,style,textarea,noscript')
      || view.getComputedStyle(element).fontSize !== '12px') return;
    const copy = copies[index]!;
    // Include containers without direct text so their line boxes keep the same size.
    // Inline priority preserves the resolved size even with authored !important CSS.
    // Mail discards body attributes, so bare body text needs its own inline run.
    if (element === source.body) {
      for (const node of [...copy.childNodes]) {
        if (node.nodeType !== 3 || !node.textContent?.trim()) continue;
        const span = source.createElement('span');
        span.style.setProperty('font-size', MAIL_DEFAULT_FONT_SIZE, 'important');
        node.replaceWith(span); span.append(node);
      }
    } else copy.style.setProperty('font-size', MAIL_DEFAULT_FONT_SIZE, 'important');
  });
}
