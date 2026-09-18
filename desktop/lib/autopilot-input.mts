import type { Debugger } from 'electron';
import type { AutopilotInteraction } from './autopilot-actions.mts';
import type { AutopilotPage } from './autopilot-model.mts';
import { AUTOPILOT_CONTROL_HELPERS, autopilotOperation } from './autopilot-page.mts';

interface Options {
  debugger: Pick<Debugger, 'attach' | 'detach' | 'isAttached' | 'sendCommand'>;
  evaluate(code: string, signal: AbortSignal): Promise<unknown>;
}

function targetScript(page: AutopilotPage, action: AutopilotInteraction, stage: 'prepare' | 'selection'): string {
  return `(() => {
    ${AUTOPILOT_CONTROL_HELPERS}
    const expected = ${JSON.stringify({ url: page.url, documentId: page.documentId, action, stage })};
    const url = new URL(location.href); url.hash = '';
    const element = registry.elements.get(expected.action.control.id);
    const current = element && describe(element);
    const matches = () => {
      const value = element && describe(element);
      return value && (value.signature === expected.action.control.signature
        || expected.action.kind === 'fill' && expected.action.control.identity && value.identity === expected.action.control.identity)
        && value.value === expected.action.control.value
        && value.kind === expected.action.control.kind && (!expected.action.control.formState || value.formState === expected.action.control.formState);
    };
    if (url.href !== expected.url || (expected.documentId && registry.documentId !== expected.documentId) || !current || !matches()) return 'stale';
    if (expected.stage === 'prepare') element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return 'unavailable';
    const points = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8]];
    const point = points.map(([dx, dy]) => ({ x: left + (right - left) * dx, y: top + (bottom - top) * dy }))
      .find(({x,y}) => element.contains(document.elementFromPoint(x, y)));
    if (!point) return 'unavailable';
    if (expected.action.kind === 'click') return point;
    if (expected.stage === 'prepare') element.focus({ preventScroll: true });
    if (!matches() || document.activeElement !== element) return 'stale';
    if (expected.stage === 'selection' && (element.selectionStart !== 0 || element.selectionEnd !== element.value.length)) {
      // One bounded selection fallback; never retry an uncertain text insertion.
      element.setSelectionRange(0, element.value.length);
      if (element.selectionStart !== 0 || element.selectionEnd !== element.value.length) return 'stale';
    }
    return 'ready';
  })()`;
}

/** Use Chromium input against the owned WebContents; no external browser or debug port. */
export async function executeAutopilotInput(options: Options, page: AutopilotPage, action: AutopilotInteraction,
  signal: AbortSignal, onDispatched: () => void): Promise<unknown> {
  signal.throwIfAborted();
  const target = await options.evaluate(targetScript(page, action, 'prepare'), signal);
  signal.throwIfAborted();
  if (target === 'stale' || target === 'unavailable') return target;
  const client = options.debugger;
  const owned = !client.isAttached();
  if (owned) client.attach('1.3');
  const send = async (method: string, params: Record<string, unknown>) => {
    signal.throwIfAborted();
    await autopilotOperation(client.sendCommand(method, params), signal);
    signal.throwIfAborted();
  };
  try {
    if (action.kind === 'fill') {
      if (target !== 'ready') throw new Error('Could not focus the selected field.');
      onDispatched();
      const key = { key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, commands: ['selectAll'] });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      if (await options.evaluate(targetScript(page, action, 'selection'), signal) !== 'ready') return 'stale';
      signal.throwIfAborted();
      await send('Input.insertText', { text: action.text });
    } else {
      assertPoint(target);
      onDispatched();
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...target, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', clickCount: 1 });
    }
    return 'applied';
  } finally {
    if (owned && client.isAttached()) client.detach();
  }
}

function assertPoint(value: unknown): asserts value is { x: number; y: number } {
  if (!value || typeof value !== 'object' || !('x' in value) || !('y' in value)
    || typeof value.x !== 'number' || typeof value.y !== 'number' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error('Could not locate the selected control.');
  }
}
