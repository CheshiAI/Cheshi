import { AUTOPILOT_DOCUMENT_HELPERS, parseAutopilotSections } from './autopilot-document.mts';
import type { AutopilotSection } from './autopilot-document.mts';
import { autopilotRecord, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotPage } from './autopilot-model.mts';
import type { AutopilotControl, AutopilotInteraction } from './autopilot-actions.mts';
import { AUTOPILOT_SEARCH_LABEL } from './autopilot-actions.mts';

export const AUTOPILOT_CONTROL_HELPERS = String.raw`
  const registry = globalThis.__cheshiAutopilotControls ??= { ids: new WeakMap(), elements: new Map(), next: 0, documentId: String(Date.now()) + ':' + Math.random() };
  const visible = element => element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && element.getClientRects().length && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility);
  const path = element => {
    const parts = [];
    for (let node = element; node && parts.length < 12; node = node.parentElement) {
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(child => child.tagName === node.tagName) : [node];
      parts.unshift(node.tagName + ':' + siblings.indexOf(node));
      if (node.id) { parts.unshift('#' + node.id); break; }
    }
    return parts.join('/');
  };
  const describe = element => {
    if (!visible(element) || element.matches(':disabled') || element.closest('[aria-disabled="true"]')) return null;
    const input = (element.tagName === 'INPUT' && ['text', 'search'].includes(element.type)) || element.tagName === 'TEXTAREA';
    const button = element.tagName === 'BUTTON' || (element.tagName === 'INPUT' && ['button', 'submit'].includes(element.type))
      || ['button', 'option'].includes(element.getAttribute('role'));
    if ((!input && !button) || (input && (element.readOnly || element.getAttribute('aria-readonly') === 'true'))) return null;
    const form = element.form;
    if (form && (element.formMethod || form.method).toLowerCase() !== 'get') return null;
    const label = (element.getAttribute('aria-label') ||
      (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
      || Array.from(element.labels || []).map(label => label.textContent).join(' ').trim()
      || (input ? element.placeholder : element.innerText || element.value) || element.title || element.name || '').trim().slice(0, 300);
    if (!label) return null;
    const role = element.getAttribute('role') || (input ? element.type === 'search' ? 'searchbox' : 'textbox' : 'button');
    const scope = form || element.closest('[role="dialog"], [role="search"], section') || element.parentElement;
    const context = (scope?.innerText || '').slice(0, 1500);
    const identity = JSON.stringify([path(element), element.name || '', role, label, form?.action || '']);
    const formValues = JSON.stringify(Array.from((form || scope || document).querySelectorAll('input,textarea,select'))
      .filter(field => !['password', 'hidden', 'file'].includes(field.type))
      .slice(0, 32).map(field => [path(field), String(field.value).slice(0, 2000)]));
    let hash = 2166136261;
    for (let index = 0; index < formValues.length; index++) hash = Math.imul(hash ^ formValues.charCodeAt(index), 16777619) >>> 0;
    const formState = hash.toString(16);
    const autocomplete = input && (role === 'combobox' || ['list', 'both'].includes(element.getAttribute('aria-autocomplete')));
    const search = input && (${AUTOPILOT_SEARCH_LABEL}.test(label)
      || element.type === 'search' && !autocomplete && form && /^(search|q|query)$/i.test(element.name)
        && Array.from(form.querySelectorAll('input,textarea')).filter(field => field.tagName === 'TEXTAREA'
          || ['text', 'search'].includes(field.type)).length === 1) === true;
    const list = role === 'option' ? element.closest('[role="listbox"]') : null;
    const owner = list?.id ? Array.from(document.querySelectorAll('input[aria-controls], input[aria-owns], textarea[aria-controls], textarea[aria-owns]'))
      .find(field => ((field.getAttribute('aria-controls') || '') + ' ' + (field.getAttribute('aria-owns') || '')).split(/\s+/).includes(list.id)) : null;
    const ownerId = owner && describe(owner)?.id;
    const signature = JSON.stringify([element.tagName, element.type || '', element.id, element.name || '', label,
      form?.action || '', element.formAction || '', element.formMethod || form?.method || '',
      element.getAttribute('aria-expanded'), element.getAttribute('aria-pressed')]);
    let id = registry.ids.get(element);
    if (!id) { id = 'control_' + ++registry.next; registry.ids.set(element, id); }
    return { id, kind: input ? 'input' : 'button', label, signature, identity, role, context, formState, search, autocomplete,
      submit: !!form && ['BUTTON', 'INPUT'].includes(element.tagName) && element.type === 'submit',
      ...(ownerId ? { owner: ownerId } : {}), value: input ? element.value.slice(0, 2000) : '' };
  };
`;

function pageScript(selection?: { url: string; version: string; id: string }): string {
  return `(() => {
  ${AUTOPILOT_CONTROL_HELPERS}
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
  for (const element of document.querySelectorAll('input, textarea, button, [role="button"], [role="option"]')) {
    const control = describe(element);
    if (!control) continue;
    registry.elements.set(control.id, element);
    controls.push(control);
    if (controls.length >= 256) break;
  }
  ${AUTOPILOT_DOCUMENT_HELPERS}
  const selection = ${JSON.stringify(selection ?? null)};
  const currentUrl = new URL(location.href); currentUrl.hash = '';
  const selected = selection && selection.url === currentUrl.href && selection.version === documentVersion
    ? sectionBodies.find(section => section.id === selection.id) : null;
  if (selected?.element?.scrollIntoView) selected.element.scrollIntoView({ block: 'start', inline: 'nearest' });
  return { documentId: registry.documentId, url: location.href, title: document.title.slice(0, 500), sections, documentVersion, documentTruncated,
    ...(selected ? { section: sections.find(section => section.id === selected.id) } : {}),
    text: selected ? selected.text : (document.querySelector('main, [role="main"], article') || document.body)?.innerText.slice(0, 12000) || '', links, controls };
})()`;
}
export const AUTOPILOT_PAGE_SCRIPT = pageScript();
export function autopilotSectionScript(page: AutopilotPage, section: AutopilotSection): string {
  return pageScript({ url: page.url, version: page.documentVersion ?? '', id: section.id });
}

/** Revalidate the exact DOM node immediately before a synchronous interaction. */
export function autopilotInteractionScript(url: string, action: AutopilotInteraction): string {
  return `(() => {
    ${AUTOPILOT_CONTROL_HELPERS}
    const expected = ${JSON.stringify({ url, action })};
    const currentUrl = new URL(location.href); currentUrl.hash = '';
    const element = registry.elements.get(expected.action.control.id);
    const current = element && describe(element);
    if (currentUrl.href !== expected.url || !current || current.signature !== expected.action.control.signature
      || current.value !== expected.action.control.value || current.kind !== expected.action.control.kind) return 'stale';
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.focus();
    if (!element.isConnected || document.activeElement !== element) return 'stale';
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
  const sections = input.sections === undefined ? undefined : parseAutopilotSections(input.sections);
  if (sections && (typeof input.documentVersion !== 'string' || !/^[0-9a-f]{1,8}$/.test(input.documentVersion)
    || (input.documentTruncated !== true && input.documentTruncated !== false))) throw new TypeError('Invalid document version.');
  const section = input.section === undefined ? undefined : parseAutopilotSections([input.section])[0];
  if (section && !sections?.some(entry => JSON.stringify(entry) === JSON.stringify(section))) throw new TypeError('Unknown document section.');
  if (input.documentId !== undefined && (typeof input.documentId !== 'string' || input.documentId.length > 200)) throw new Error('Invalid page identity.');
  return { url, title: input.title, text: input.text, links, controls,
    ...(typeof input.documentId === 'string' ? { documentId: input.documentId } : {}),
    ...(sections ? { sections, documentVersion: input.documentVersion as string, documentTruncated: input.documentTruncated === true } : {}),
    ...(section ? { section } : {}) };

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
    const metadata: Partial<AutopilotControl> = {};
    for (const key of ['identity', 'role', 'context', 'formState', 'owner'] as const) {
      if (control[key] === undefined) continue;
      if (typeof control[key] !== 'string' || control[key].length > 80000) throw new Error('Invalid control context.');
      metadata[key] = control[key];
    }
    for (const key of ['search', 'autocomplete', 'submit'] as const) {
      if (control[key] === undefined) continue;
      if (control[key] !== true && control[key] !== false) throw new Error('Invalid control flag.');
      metadata[key] = control[key];
    }
    return { id: control.id, kind: control.kind, label: control.label, signature: control.signature, value: control.value, ...metadata };
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
