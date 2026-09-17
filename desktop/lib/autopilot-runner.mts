import { AUTOPILOT_MAX_STEPS, autopilotRunning, parseAutopilotRequest, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotState } from '../shared/autopilot.ts';
import type { AutopilotDecision, AutopilotDecisionInput, AutopilotLink, AutopilotPage } from './autopilot-model.mts';
import { autopilotActionLabel, autopilotActions, autopilotInteractionKey, sameAutopilotInteraction } from './autopilot-actions.mts';
import type { AutopilotInteraction } from './autopilot-actions.mts';
import { runAutopilotResearch } from './autopilot-research.mts';

const MAX_PAGE_CHANGE_RETRIES = 2;

export class AutopilotPageChangedError extends Error {
  readonly page: AutopilotPage;

  constructor(page: AutopilotPage) {
    super('The page changed while choosing a link.');
    this.name = 'AutopilotPageChangedError';
    this.page = page;
  }
}

export interface AutopilotRunnerOptions {
  configured(): boolean;
  decide(input: AutopilotDecisionInput): Promise<AutopilotDecision>;
  load(url: string, signal: AbortSignal): Promise<AutopilotPage>;
  read?(signal: AbortSignal): Promise<AutopilotPage>;
  follow(page: AutopilotPage, link: AutopilotLink, signal: AbortSignal): Promise<AutopilotPage>;
  interact?(page: AutopilotPage, action: AutopilotInteraction, signal: AbortSignal): Promise<AutopilotPage>;
  cancelLoad(): void;
  onState(state: AutopilotState): void;
}

export function createAutopilotRunner(options: AutopilotRunnerOptions) {
  let state: AutopilotState = { configured: options.configured(), phase: 'idle', url: '', title: '', goal: '',
    error: null, modelMs: 0, steps: [] };
  let run: AbortController | null = null;
  let disposed = false;
  const snapshot = (): AutopilotState => ({ ...state, configured: options.configured(), steps: state.steps.map(step => ({ ...step })),
    ...(state.sources ? { sources: state.sources.map(source => ({ ...source })) } : {}),
    ...(state.issues ? { issues: state.issues.map(issue => ({ ...issue })) } : {}) });
  const emit = () => { if (!disposed) options.onState(snapshot()); };
  const update = (value: Partial<AutopilotState>) => { state = { ...state, ...value }; emit(); };

  async function execute(controller: AbortController) {
    const { signal } = controller;
    let started = performance.now();
    try {
      if (state.mode === 'research') {
        await runAutopilotResearch(options, { ...state }, signal, value => {
          if (run === controller && !signal.aborted && !disposed) update(value);
        });
        return;
      }
      let page = await options.load(state.url, signal);
      signal.throwIfAborted();
      let loadMs = performance.now() - started;
      let decisionMs = 0;
      let confidence: number | null = null;
      const visited: string[] = [];
      const completedInteractions: string[] = [];
      let step = 0;
      let retries = 0;
      let recordPage = true;
      let action: string | undefined;
      let samePageInteraction = false;
      while (step <= AUTOPILOT_MAX_STEPS) {
        signal.throwIfAborted();
        if (recordPage) {
          const url = safeAutopilotUrl(page.url);
          assertDestination(url, samePageInteraction && url === visited.at(-1) ? [] : visited);
          if (url !== visited.at(-1)) visited.push(url!);
          update({ url: url!, title: page.title, phase: 'thinking',
            steps: [...state.steps, { url: url!, title: page.title, loadMs, decisionMs, confidence,
              ...(action ? { action } : {}) }] });
          decisionMs = 0;
          loadMs = 0;
        } else {
          update({ title: page.title, phase: 'thinking', steps: state.steps.map((entry, index) =>
            index === state.steps.length - 1 ? { ...entry, title: page.title } : entry) });
        }
        started = performance.now();
        const decision = await options.decide({ page, goal: state.goal, visited, signal, searchText: state.searchText,
          completedInteractions, history: state.steps.flatMap(step => step.action ? [step.action] : []) });
        signal.throwIfAborted();
        const elapsed = performance.now() - started;
        decisionMs += elapsed;
        confidence = decision.confidence;
        update({ modelMs: state.modelMs + elapsed });
        if (decision.completed) { update({ phase: 'completed' }); return; }
        if (step === AUTOPILOT_MAX_STEPS) { update({ phase: 'limit' }); return; }
        const interaction = decision.interaction;
        if (interaction) assertInteraction(interaction, page, state.searchText, !!options.interact, completedInteractions);
        else assertLink(decision.link, page, visited);
        update({ phase: interaction ? 'acting' : 'loading' });
        started = performance.now();
        const interactionKey = interaction ? autopilotInteractionKey(page.url, interaction) : null;
        try {
          page = interaction ? await options.interact!(page, interaction, signal)
            : await options.follow(page, decision.link!, signal);
          signal.throwIfAborted();
          if (interactionKey) completedInteractions.push(interactionKey);
          action = autopilotActionLabel(interaction ?? { kind: 'navigate', link: decision.link! }).slice(0, 600);
          samePageInteraction = !!interaction;
          retries = 0;
          recordPage = true;
          step += 1;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof AutopilotPageChangedError)) throw error;
          assertPageChangeRetry(++retries);
          // A changed URL is a real page transition; a refreshed DOM is not.
          recordPage = error.page.url !== page.url;
          samePageInteraction = false;
          if (recordPage) action = 'Page changed; refreshed controls';
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
      state = { configured: options.configured(), ...request, title: '', phase: 'loading', error: null, modelMs: 0, steps: [],
        ...(request.mode === 'research' ? { sources: [], issues: [] } : {}) };
      emit();
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

function assertInteraction(action: AutopilotInteraction, page: AutopilotPage, searchText: string | undefined, supported: boolean, completedInteractions: string[]): void {
  if (!supported || !autopilotActions(page, [], searchText, completedInteractions).some(candidate =>
    candidate.kind !== 'navigate' && sameAutopilotInteraction(candidate, action))) {
    throw new Error('The selected control is not available for this search.');
  }
}
