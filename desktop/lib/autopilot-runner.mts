import { AUTOPILOT_MAX_STEPS, autopilotRunning, parseAutopilotRequest, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotState } from '../shared/autopilot.ts';
import type { AutopilotDecision, AutopilotDecisionInput, AutopilotLink, AutopilotPage } from './autopilot-model.mts';

const MAX_PAGE_CHANGE_RETRIES = 2;

export class AutopilotPageChangedError extends Error {
  readonly page: AutopilotPage;

  constructor(page: AutopilotPage) {
    super('The page changed while choosing a link.');
    this.name = 'AutopilotPageChangedError';
    this.page = page;
  }
}

interface Options {
  configured(): boolean;
  decide(input: AutopilotDecisionInput): Promise<AutopilotDecision>;
  load(url: string, signal: AbortSignal): Promise<AutopilotPage>;
  follow(page: AutopilotPage, link: AutopilotLink, signal: AbortSignal): Promise<AutopilotPage>;
  cancelLoad(): void;
  onState(state: AutopilotState): void;
}

export function createAutopilotRunner(options: Options) {
  let state: AutopilotState = { configured: options.configured(), phase: 'idle', url: '', title: '', goal: '',
    error: null, modelMs: 0, steps: [] };
  let run: AbortController | null = null;
  let disposed = false;
  const snapshot = (): AutopilotState => ({ ...state, configured: options.configured(), steps: state.steps.map(step => ({ ...step })) });
  const emit = () => { if (!disposed) options.onState(snapshot()); };
  const update = (value: Partial<AutopilotState>) => { state = { ...state, ...value }; emit(); };

  async function execute(controller: AbortController) {
    const { signal } = controller;
    let started = performance.now();
    try {
      let page = await options.load(state.url, signal);
      signal.throwIfAborted();
      let loadMs = performance.now() - started;
      let decisionMs = 0;
      let confidence: number | null = null;
      const visited: string[] = [];
      let step = 0;
      let retries = 0;
      let recordPage = true;
      while (step <= AUTOPILOT_MAX_STEPS) {
        signal.throwIfAborted();
        if (recordPage) {
          const url = safeAutopilotUrl(page.url);
          assertDestination(url, visited);
          visited.push(url!);
          update({ url: url!, title: page.title, phase: 'thinking',
            steps: [...state.steps, { url: url!, title: page.title, loadMs, decisionMs, confidence }] });
          decisionMs = 0;
          loadMs = 0;
        } else {
          update({ title: page.title, phase: 'thinking', steps: state.steps.map((entry, index) =>
            index === state.steps.length - 1 ? { ...entry, title: page.title } : entry) });
        }
        started = performance.now();
        const decision = await options.decide({ page, goal: state.goal, visited, signal });
        signal.throwIfAborted();
        const elapsed = performance.now() - started;
        decisionMs += elapsed;
        confidence = decision.confidence;
        update({ modelMs: state.modelMs + elapsed });
        if (decision.completed) { update({ phase: 'completed' }); return; }
        if (step === AUTOPILOT_MAX_STEPS) { update({ phase: 'limit' }); return; }
        assertLink(decision.link, page, visited);
        update({ phase: 'loading' });
        started = performance.now();
        try {
          page = await options.follow(page, decision.link!, signal);
          signal.throwIfAborted();
          retries = 0;
          recordPage = true;
          step += 1;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof AutopilotPageChangedError)) throw error;
          assertPageChangeRetry(++retries);
          // A changed URL is a real page transition; a refreshed DOM is not.
          recordPage = error.page.url !== page.url;
          if (recordPage) step += 1;
          page = error.page;
        }
        loadMs += performance.now() - started;
      }
    } catch (error) {
      if (run === controller && !signal.aborted && !disposed) {
        update({ phase: 'error', error: error instanceof Error ? error.message.slice(0, 2000) : 'Autopilot could not continue.' });
      }
    } finally {
      if (run === controller) run = null;
    }
  }

  function stop() {
    run?.abort();
    run = null;
    options.cancelLoad();
    if (autopilotRunning(state)) update({ phase: 'stopped' });
    return snapshot();
  }

  return {
    snapshot,
    start(value: unknown) {
      if (disposed) throw new Error('Autopilot is closed.');
      if (autopilotRunning(state)) throw new Error('Stop the current run before starting another.');
      const request = parseAutopilotRequest(value);
      if (!options.configured()) throw new Error('Set TYPE_SAFE_AI in the app environment to use Autopilot.');
      run = new AbortController();
      update({ ...request, title: '', phase: 'loading', error: null, modelMs: 0, steps: [] });
      void execute(run);
      return snapshot();
    },
    stop,
    dispose() { stop(); disposed = true; },
  };
}

function assertPageChangeRetry(retries: number): void {
  if (retries > MAX_PAGE_CHANGE_RETRIES) {
    throw new Error('The page kept changing after 2 retries. Try again once it has settled.');
  }
}

function assertDestination(url: string | null, visited: string[]): void {
  if (!url) throw new Error('This destination is not an HTTP(S) page.');
  if (visited.includes(url)) throw new Error('Navigation returned to a visited page. Try a more specific goal.');
}

function assertLink(link: AutopilotLink | null, page: AutopilotPage, visited: string[]): void {
  if (!link) throw new Error('No unvisited links remain on this page.');
  if (!page.links.some(candidate => candidate.id === link.id && candidate.url === link.url)
    || !safeAutopilotUrl(link.url) || visited.includes(link.url)) {
    throw new Error('The selected link is not an available destination.');
  }
}
