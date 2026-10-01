import { mailLink } from './mailHtmlDocument';

// A shadow root scopes selectors, but does not sandbox CSS or resource loads.
const PRESENTATION = /^(?:background(?:-color|-image|-position|-size|-repeat|-origin|-clip)?|color|display|visibility|opacity|width|min-width|max-width|margin(?:-(?:top|right|bottom|left|inline|block)(?:-start|-end)?)?|padding(?:-(?:top|right|bottom|left|inline|block)(?:-start|-end)?)?|border(?:-(?:top|right|bottom|left))?(?:-width|-style|-color)?|border-radius|border-collapse|border-spacing|box-sizing|box-shadow|font(?:-family|-size|-style|-weight|-variant|-stretch)?|line-height|letter-spacing|word-spacing|text-align|text-decoration(?:-line|-color|-style|-thickness)?|text-indent|text-transform|text-shadow|text-overflow|white-space|overflow-wrap|word-break|vertical-align|list-style(?:-type|-position)?|table-layout|caption-side|direction|unicode-bidi)$/;
const FUNCTIONS = new Set(['url', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'calc', 'min', 'max', 'clamp', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient']);

export function mailReadImageUrl(value: string, remoteImages: boolean): string | null {
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)) return value;
  return remoteImages ? mailLink(value.startsWith('//') ? `https:${value}` : value) : null;
}

function safeValue(value: string, remoteImages: boolean): string | null {
  // Reject escapes so encoded function names and schemes cannot bypass checks.
  if (/[\\{}<>]/.test(value)) return null;
  const withoutUrls = value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_match, double: string, single: string, bare: string) => {
    const url = mailReadImageUrl((double ?? single ?? bare).trim(), remoteImages);
    return url ? `url("${url}")` : 'none';
  });
  const functionsOnly = withoutUrls.replace(/url\("[^"]*"\)/g, '').replace(/"[^"]*"|'[^']*'/g, '');
  if ([...functionsOnly.matchAll(/([a-z-]+)\s*\(/gi)].some(match => !FUNCTIONS.has(match[1]!.toLowerCase()))) return null;
  return withoutUrls;
}

export function mailReadDeclarations(style: CSSStyleDeclaration, remoteImages: boolean, image = false): string {
  const result: string[] = [];
  for (const property of Array.from(style)) {
    if (!PRESENTATION.test(property) && !(image && property === 'height')) continue;
    const value = safeValue(style.getPropertyValue(property), remoteImages);
    if (value === null) continue;
    const priority = style.getPropertyPriority(property) === 'important' ? '!important' : '';
    result.push(`${property}:${value}${priority}`);
  }
  return result.join(';');
}

export function mailReadStyles(css: string, remoteImages: boolean, view: Window & typeof globalThis): string {
  // Constructed sheets do not load @import and are never attached raw.
  const sheet = new view.CSSStyleSheet();
  try { sheet.replaceSync(css); } catch { return ''; }
  const sanitize = (rules: CSSRuleList): string => Array.from(rules).map(rule => {
    if (rule instanceof view.CSSStyleRule) {
      const selector = rule.selectorText;
      if (/[\\@]/.test(selector) || /:host|::slotted|::part/i.test(selector)) return '';
      const declarations = mailReadDeclarations(rule.style, remoteImages);
      return declarations ? `${selector.replace(/:root\b/g, 'html')}{${declarations}}` : '';
    }
    if (rule instanceof view.CSSMediaRule) return `@media ${rule.conditionText}{${sanitize(rule.cssRules)}}`;
    if (rule instanceof view.CSSSupportsRule) return `@supports ${rule.conditionText}{${sanitize(rule.cssRules)}}`;
    return '';
  }).join('\n');
  return sanitize(sheet.cssRules);
}
