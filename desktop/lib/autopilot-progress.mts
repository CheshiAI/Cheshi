import { autopilotActionLabel, autopilotInteractionKey, autopilotPageFingerprint } from './autopilot-actions.mts';
import type { AutopilotInteraction } from './autopilot-actions.mts';
import type { AutopilotPage } from './autopilot-model.mts';
import { AutopilotPageChangedError } from './autopilot-runner.mts';

export interface AutopilotOutcome {
  url: string;
  action: string;
  key: string;
  status: 'dispatched' | 'verified' | 'unconfirmed' | 'stale' | 'unavailable';
  resultUrl?: string;
  pageChanged?: boolean;
}

/** Owned by one run, including all research questions and query attempts. */
export class AutopilotProgress {
  readonly outcomes: AutopilotOutcome[] = [];
  readonly attempted = new Set<string>();
  readonly pages = new Map<string, { page: AutopilotPage; accessedAt: string }>();
  private readonly unavailable = new Map<string, string>();

  get completedInteractions(): string[] {
    return this.outcomes.filter(entry => entry.status !== 'stale' && entry.status !== 'unavailable').map(entry => entry.key);
  }

  excludedInteractions(page: AutopilotPage): string[] {
    const fingerprint = autopilotPageFingerprint(page);
    return [...this.completedInteractions, ...[...this.unavailable].filter(([, observed]) => observed === fingerprint).map(([key]) => key)];
  }

  get history(): string[] {
    return this.outcomes.map(entry => `${entry.status}: ${entry.action} (${entry.url})`);
  }

  remember(page: AutopilotPage, requestedUrl = page.url): void {
    this.attempted.add(requestedUrl);
    this.attempted.add(page.url);
    const snapshot = { page: structuredClone(page), accessedAt: new Date().toISOString() };
    this.pages.set(requestedUrl, snapshot);
    this.pages.set(page.url, snapshot);
  }

  invalidate(url: string): void {
    for (const [key, snapshot] of this.pages) if (snapshot.page.url === url) this.pages.delete(key);
  }

  async interact(page: AutopilotPage, action: AutopilotInteraction, signal: AbortSignal,
    execute: (onDispatched: () => void) => Promise<AutopilotPage>): Promise<AutopilotPage> {
    signal.throwIfAborted();
    const key = autopilotInteractionKey(page.url, action);
    if (this.excludedInteractions(page).includes(key)) throw new Error('This browser action was already attempted or is unavailable.');
    const entry: AutopilotOutcome = { url: page.url, key, action: autopilotActionLabel(action), status: 'unconfirmed' };
    // Reserve before executing. An uncertain response must never authorize replay.
    this.outcomes.push(entry);
    if (action.kind === 'fill' && action.text === action.control.value) {
      entry.status = 'verified';
      entry.action = `Already set: ${action.control.label}`;
      entry.pageChanged = false;
      return page;
    }
    let dispatched = false;
    try {
      const after = await execute(() => { dispatched = true; entry.status = 'dispatched'; });
      signal.throwIfAborted();
      entry.status = 'verified';
      entry.resultUrl = after.url;
      entry.pageChanged = autopilotPageFingerprint(after) !== autopilotPageFingerprint(page);
      this.remember(after);
      return after;
    } catch (error) {
      entry.status = !dispatched && error instanceof AutopilotPageChangedError ? 'stale' : 'unconfirmed';
      if (!dispatched && error instanceof AutopilotPageChangedError && error.reason === 'unavailable') {
        entry.status = 'unavailable';
        const fingerprint = autopilotPageFingerprint(error.page);
        this.unavailable.set(key, fingerprint);
        if (action.kind === 'fill') this.unavailable.set(autopilotInteractionKey(page.url, { ...action, text: '' }), fingerprint);
      }
      signal.throwIfAborted();
      if (dispatched && error instanceof AutopilotPageChangedError) {
        throw new Error('The action was sent but its result could not be confirmed. It will not be repeated.');
      }
      throw error;
    }
  }
}
