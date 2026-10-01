export const MAIL_DEFAULT_TEXT_COLOR = '#18212a';
export const MAIL_DEFAULT_BACKGROUND_COLOR = '#ffffff';

const DEFAULTS_ATTRIBUTE = 'data-cheshi-mail-colors';
const REFERENCE_ATTRIBUTE = 'data-cheshi-mail-color-reference';

function retainMailSourceColors(document: Document) {
  if (document.body.querySelector(`span[${REFERENCE_ATTRIBUTE}]`)) return;
  const walker = document.createTreeWalker(document.body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent || parent.closest('script,style,textarea')
      || parent.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    // Mail inverse-transforms an entirely dark source, even when its colors are
    // explicit. A zero-size default-color space supplies a light source reference
    // without changing the visible text/layout. display:none is discarded by Mail
    // before that decision and cannot be used here.
    const reference = document.createElement('span');
    reference.setAttribute(REFERENCE_ATTRIBUTE, '');
    reference.setAttribute('aria-hidden', 'true');
    reference.style.cssText = 'display:inline!important;font-size:0!important;line-height:0!important;'
      + 'letter-spacing:0!important;word-spacing:0!important;padding:0!important;margin:0!important;border:0!important;'
      + `color:${MAIL_DEFAULT_TEXT_COLOR}!important;background-color:${MAIL_DEFAULT_BACKGROUND_COLOR}!important`;
    reference.textContent = '\u00a0';
    parent.insertBefore(reference, node);
    return;
  }
}

/** Mail's dark-mode paste conversion needs an explicit source color scheme. */
export function applyMailDocumentColors(document: Document) {
  let defaults = document.head.querySelector<HTMLStyleElement>(`style[${DEFAULTS_ATTRIBUTE}]`);
  if (!defaults) {
    defaults = document.createElement('style');
    defaults.setAttribute(DEFAULTS_ATTRIBUTE, '');
  }
  const legacy = document.createElement('span').style;
  legacy.color = document.body.getAttribute('text') ?? '';
  legacy.backgroundColor = document.body.getAttribute('bgcolor') ?? '';
  const root = document.documentElement.style;
  const body = document.body.style;
  // Zero specificity and first position keep authored CSS/inline colors in charge.
  // Inheriting from html also preserves colors specified on the document root.
  // Mail drops html/body attributes while importing clipboard HTML. Mirror
  // their colors in the source stylesheet so those explicit values survive.
  defaults.textContent = `:where(html){color:${root.color || MAIL_DEFAULT_TEXT_COLOR};background-color:${root.backgroundColor || MAIL_DEFAULT_BACKGROUND_COLOR}}`
    + `:where(body){color:${body.color || legacy.color || 'inherit'};background-color:${body.backgroundColor || legacy.backgroundColor || 'inherit'}}`;
  document.head.prepend(defaults);
  retainMailSourceColors(document);
}
