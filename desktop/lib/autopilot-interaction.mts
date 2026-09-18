import { setTimeout as delay } from 'node:timers/promises';
import { autopilotPageFingerprint, isAutopilotSearchControl } from './autopilot-actions.mts';
import type { AutopilotInteraction } from './autopilot-actions.mts';
import type { AutopilotPage } from './autopilot-model.mts';
import { autopilotInteractionScript } from './autopilot-page.mts';
import { AutopilotPageChangedError } from './autopilot-runner.mts';

interface Options {
  read(signal: AbortSignal): Promise<AutopilotPage>;
  evaluate(script: string, signal: AbortSignal): Promise<unknown>;
  loading(): boolean;
  execute?(page: AutopilotPage, action: AutopilotInteraction, signal: AbortSignal, onDispatched: () => void): Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
}

/** Observe a result before issuing another action; never repeat an unverified click. */
export async function performAutopilotInteraction(options: Options, page: AutopilotPage,
  action: AutopilotInteraction, signal: AbortSignal, onDispatched: () => void = () => {}): Promise<AutopilotPage> {
  signal.throwIfAborted();
  const current = await options.read(signal);
  signal.throwIfAborted();
  assertCurrentControl(current, page, action);
  const result = options.execute ? await options.execute(page, action, signal, onDispatched)
    : await options.evaluate(autopilotInteractionScript(page.url, action), signal);
  signal.throwIfAborted();
  if (result === 'stale') throw new AutopilotPageChangedError(await options.read(signal));
  if (result === 'unavailable') throw new AutopilotPageChangedError(await options.read(signal), 'unavailable');
  assertApplied(result);
  if (!options.execute) onDispatched();
  const deadline = performance.now() + (options.timeoutMs ?? 8_000);
  let stableSince = performance.now();
  let previous = '';
  while (performance.now() < deadline) {
    await delay(options.pollMs ?? 150, undefined, { signal });
    if (options.loading()) { previous = ''; continue; }
    let after: AutopilotPage;
    try { after = await options.read(signal); }
    catch (error) {
      signal.throwIfAborted();
      if (options.loading()) continue;
      throw error;
    }
    signal.throwIfAborted();
    const fingerprint = autopilotPageFingerprint(after);
    const retainedControl = after.url === current.url && (!current.documentId || after.documentId === current.documentId)
      && after.controls?.find(control => control.kind === 'input' && control.value === (action.kind === 'fill' ? action.text : '')
        && (control.id === action.control.id || !!action.control.identity && control.identity === action.control.identity));
    const suggestionsReady = !action.control.autocomplete || isAutopilotSearchControl(action.control)
      || after.controls?.some(control => control.role === 'option' && (!control.owner || retainedControl && control.owner === retainedControl.id));
    const changed = action.kind === 'fill'
      ? retainedControl && suggestionsReady
      : fingerprint !== autopilotPageFingerprint(current);
    if (!changed) { previous = ''; continue; }
    if (previous !== fingerprint) { previous = fingerprint; stableSince = performance.now(); }
    if (performance.now() - stableSince >= (options.settleMs ?? 450)) return after;
  }
  throw new Error(action.kind === 'fill' ? 'The search input did not retain the requested text.'
    : 'The button produced no confirmed page change. Stopped to avoid repeating the click.');
}

function assertCurrentControl(current: AutopilotPage, expected: AutopilotPage, action: AutopilotInteraction): void {
  if (current.url !== expected.url || (expected.documentId && current.documentId !== expected.documentId)
    || !current.controls?.some(control => control.id === action.control.id
    && control.kind === action.control.kind && control.signature === action.control.signature && control.value === action.control.value
    && (!action.control.formState || control.formState === action.control.formState))) {
    throw new AutopilotPageChangedError(current);
  }
}

function assertApplied(result: unknown): void {
  if (result !== 'applied') throw new Error('The page did not accept the selected action.');
}
