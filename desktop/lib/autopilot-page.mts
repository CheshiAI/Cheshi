import { autopilotRecord, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotPage } from './autopilot-model.mts';

export const AUTOPILOT_PAGE_SCRIPT = String.raw`(() => {
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
  return { url: location.href, title: document.title.slice(0, 500),
    text: (document.querySelector('main, [role="main"], article') || document.body)?.innerText.slice(0, 12000) || '', links };
})()`;

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
  return { url, title: input.title, text: input.text, links };
}

/** Abort also releases a pending renderer evaluation which Electron cannot otherwise cancel. */
export async function autopilotOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new Error('The page took too long to respond.')), 30_000);
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
