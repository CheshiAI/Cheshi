import { autopilotRecord, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotPage } from './autopilot-model.mts';
import type { AutopilotControl, AutopilotInteraction } from './autopilot-actions.mts';

const CONTROL_HELPERS = String.raw`
  const registry = globalThis.__cheshiAutopilotControls ??= { ids: new WeakMap(), elements: new Map(), next: 0 };
  const visible = element => element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && element.getClientRects().length && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility);
  const describe = element => {
    if (!visible(element) || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return null;
    const input = (element.tagName === 'INPUT' && ['text', 'search'].includes(element.type)) || element.tagName === 'TEXTAREA';
    const button = element.tagName === 'BUTTON' || (element.tagName === 'INPUT' && ['button', 'submit'].includes(element.type))
      || element.getAttribute('role') === 'button';
    if ((!input && !button) || (input && element.readOnly)) return null;
    const form = element.form;
    if (form && (element.formMethod || form.method).toLowerCase() !== 'get') return null;
    const label = (element.getAttribute('aria-label') ||
      (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
      || Array.from(element.labels || []).map(label => label.textContent).join(' ').trim()
      || (input ? element.placeholder : element.innerText || element.value) || element.title || element.name || '').trim().slice(0, 300);
    if (!label) return null;
    const signature = JSON.stringify([element.tagName, element.type || '', element.id, element.name || '', label,
      form?.action || '', element.formAction || '', element.formMethod || form?.method || '',
      element.getAttribute('aria-expanded'), element.getAttribute('aria-pressed')]);
    let id = registry.ids.get(element);
    if (!id) { id = 'control_' + ++registry.next; registry.ids.set(element, id); }
    return { id, kind: input ? 'input' : 'button', label, signature, value: input ? element.value.slice(0, 2000) : '' };
  };
`;

export const AUTOPILOT_PAGE_SCRIPT = `(() => {
  ${CONTROL_HELPERS}
  const links = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (anchor.hasAttribute('download') || !anchor.getClientRects().length) continue;
    const style = getComputedStyle(anchor);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
    let url;
    try { url = new URL(anchor.href); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ url: url.href, label: (anchor.innerText || anchor.getAttribute('aria-label') || anchor.title || url.href).trim().slice(0, 300) });
    if (links.length > 4096) break;
  }
  const controls = [];
  registry.elements.clear();
  for (const element of document.querySelectorAll('input, textarea, button, [role="button"]')) {
    const control = describe(element);
    if (!control) continue;
    registry.elements.set(control.id, element);
    controls.push(control);
    if (controls.length >= 256) break;
  }
  return { url: location.href, title: document.title.slice(0, 500),
    text: (document.querySelector('main, [role="main"], article') || document.body)?.innerText.slice(0, 12000) || '', links, controls };
})()`;

/** Revalidate the exact DOM node immediately before a synchronous interaction. */
export function autopilotInteractionScript(url: string, action: AutopilotInteraction): string {
  return `(() => {
    ${CONTROL_HELPERS}
    const expected = ${JSON.stringify({ url, action })};
    const currentUrl = new URL(location.href); currentUrl.hash = '';
    const element = registry.elements.get(expected.action.control.id);
    const current = element && describe(element);
    if (currentUrl.href !== expected.url || !current || current.signature !== expected.action.control.signature
      || current.value !== expected.action.control.value || current.kind !== expected.action.control.kind) return 'stale';
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.focus();
    if (expected.action.kind === 'fill') {
      if (current.kind !== 'input') return 'stale';
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, expected.action.text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.value === expected.action.text ? 'applied' : 'rejected';
    }
    if (current.kind !== 'button') return 'stale';
    element.click();
    return 'applied';
  })()`;
}

export function parseAutopilotPage(value: unknown): AutopilotPage {
  const input = autopilotRecord(value);
  const url = safeAutopilotUrl(input.url);
  if (!url || typeof input.title !== 'string' || input.title.length > 500
    || typeof input.text !== 'string' || input.text.length > 12000 || !Array.isArray(input.links)) {
    throw new Error('Could not read this page.');
  }
  if (input.links.length > 4096) throw new Error('This page has too many links. Try a more specific start page.');
  const seen = new Set<string>([url]);
  const links = input.links.flatMap((value, index) => {
    const link = autopilotRecord(value);
    const destination = safeAutopilotUrl(link.url);
    if (!destination || seen.has(destination) || typeof link.label !== 'string' || link.label.length > 300) return [];
    seen.add(destination);
    return [{ id: `link_${index}`, url: destination, label: link.label }];
  });
  const controls = parseControls(input.controls);
  return { url, title: input.title, text: input.text, links, controls };
}

function parseControls(value: unknown): AutopilotControl[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error('Could not read page controls.');
  const ids = new Set<string>();
  return value.map(value => {
    const control = autopilotRecord(value);
    if (typeof control.id !== 'string' || !/^control_[1-9]\d*$/.test(control.id) || ids.has(control.id)
      || (control.kind !== 'input' && control.kind !== 'button')
      || typeof control.label !== 'string' || !control.label || control.label.length > 300
      || typeof control.signature !== 'string' || control.signature.length > 20000
      || typeof control.value !== 'string' || control.value.length > 2000) throw new Error('Invalid page control.');
    ids.add(control.id);
    return { id: control.id, kind: control.kind, label: control.label, signature: control.signature, value: control.value };
  });
}

/** Abort also releases a pending renderer evaluation which Electron cannot otherwise cancel. */
export async function autopilotOperation<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs = 30_000): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new Error('The page took too long to respond.')), timeoutMs);
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
