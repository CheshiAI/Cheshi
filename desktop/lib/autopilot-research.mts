import { AUTOPILOT_MAX_STEPS, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotIssue, AutopilotRequest, AutopilotSource, AutopilotState, AutopilotStep } from '../shared/autopilot.ts';
import { autopilotActionLabel, autopilotActions, autopilotInteractionKey, sameAutopilotInteraction } from './autopilot-actions.mts';
import type { AutopilotDecision, AutopilotLink, AutopilotPage } from './autopilot-model.mts';
import { researchPagePassages } from './autopilot-evidence.mts';
import { AutopilotPageChangedError } from './autopilot-runner.mts';
import type { AutopilotRunnerOptions } from './autopilot-runner.mts';

/** Keep discovered links across pages, so research can leave a dead end for another source. */
export async function runAutopilotResearch(options: AutopilotRunnerOptions, request: AutopilotRequest,
  signal: AbortSignal, update: (value: Partial<AutopilotState>) => void): Promise<void> {
  const sources: AutopilotSource[] = [];
  const issues: AutopilotIssue[] = [];
  const steps: AutopilotStep[] = [];
  const completedInteractions: string[] = [];
  const attempted = new Set<string>([request.url]);
  const frontier = new Map<string, { link: AutopilotLink; origin: string }>();
  let sequence = 0;
  let modelMs = 0;
  let actionCount = 0;
  let staleRetries = 0;
  const target = request.targetSources ?? 5;
  const publish = (value: Partial<AutopilotState> = {}) => update({
    sources: sources.map(source => ({ ...source })), issues: issues.map(issue => ({ ...issue })),
    steps: steps.map(step => ({ ...step })), modelMs, ...value,
  });
  const issue = (url: string, message: string) => { issues.push({ url, message: message.slice(0, 2000) }); };
  const partial = (message: string) => publish({ phase: 'partial', error: message });
  const clearOrigin = (url: string) => {
    for (const [destination, entry] of frontier) if (entry.origin === url) frontier.delete(destination);
  };
  const remember = (page: AutopilotPage) => {
    clearOrigin(page.url);
    attempted.add(page.url);
    frontier.delete(page.url);
    for (const candidate of page.links) {
      const url = safeAutopilotUrl(candidate.url);
      if (!url || attempted.has(url) || frontier.has(url) || frontier.size >= 512) continue;
      frontier.set(url, { origin: page.url, link: { ...candidate, url, id: `research_link_${++sequence}` } });
    }
  };
  const readFailed = (url: string): AutopilotPage => ({ url, title: 'Unavailable page', text: '', links: [] });
  const record = (page: AutopilotPage, elapsed: number, decisionMs: number, confidence: number | null, action?: string) => {
    steps.push({ url: page.url, title: page.title, loadMs: elapsed, decisionMs, confidence, ...(action ? { action } : {}) });
    publish({ url: page.url, title: page.title, phase: 'thinking' });
  };
  let started = performance.now();
  let page: AutopilotPage;
  try { page = await options.load(request.url, signal); }
  catch {
    signal.throwIfAborted();
    issue(request.url, 'Could not load or read this source.');
    page = readFailed(request.url);
  }
  signal.throwIfAborted();
  record(page, performance.now() - started, 0, null);
  let accessedAt = new Date().toISOString();

  while (true) {
    signal.throwIfAborted();
    remember(page);
    if (!page.text && !frontier.size && !(page.controls?.length)) { partial('No readable sources remain.'); return; }
    const candidates = [...frontier.values()].map(entry => entry.link);
    started = performance.now();
    const decision = await options.decide({ page: { ...page, links: candidates }, goal: request.goal,
      searchText: request.searchText, visited: [...attempted], signal, research: true,
      completedInteractions, history: steps.flatMap(step => step.action ? [step.action] : []) });
    signal.throwIfAborted();
    const decisionMs = performance.now() - started;
    modelMs += decisionMs;
    if (decision.evidence && options.read) {
      const observed = await options.read(signal);
      signal.throwIfAborted();
      if (observed.url !== page.url || observed.text !== page.text) {
        clearOrigin(page.url);
        if (++staleRetries > 2) {
          issue(page.url, 'Evidence changed repeatedly while being checked.');
          partial('Could not confirm the current page evidence.'); return;
        }
        if (observed.url !== page.url) {
          if (actionCount >= AUTOPILOT_MAX_STEPS) { partial('Action limit reached while checking evidence.'); return; }
          actionCount++;
          record(observed, 0, decisionMs, decision.confidence, 'Page changed; checking evidence again');
        } else publish({ title: observed.title, phase: 'thinking' });
        page = observed;
        accessedAt = new Date().toISOString();
        continue;
      }
    }
    assertEvidence(decision, page);
    if (decision.evidence && !sources.some(source => source.url === page.url)) {
      sources.push({ url: page.url, title: page.title, accessedAt, evidence: decision.evidence.text,
        confidence: decision.evidence.confidence });
    }
    publish();
    if (sources.length >= target) { publish({ phase: 'completed', error: null }); return; }
    if (actionCount >= AUTOPILOT_MAX_STEPS) { partial('Action limit reached before collecting all requested sources.'); return; }
    if (!decision.interaction && !decision.link) { partial('No more available actions; collected sources are ready to export.'); return; }

    const current = page;
    const interaction = decision.interaction;
    const selected = decision.link;
    assertAction(decision, current, candidates, request.searchText, !!options.interact, completedInteractions);
    const label = autopilotActionLabel(interaction ?? { kind: 'navigate', link: selected! }).slice(0, 600);
    publish({ phase: interaction ? 'acting' : 'loading' });
    started = performance.now();
    actionCount++;
    try {
      if (interaction) page = await options.interact!(current, interaction, signal);
      else {
        attempted.add(selected!.url);
        frontier.delete(selected!.url);
        const local = current.links.find(link => link.url === selected!.url);
        // A saved frontier entry is an actual link observed on an earlier page.
        page = local ? await options.follow(current, local, signal) : await options.load(selected!.url, signal);
      }
      signal.throwIfAborted();
      if (interaction) completedInteractions.push(autopilotInteractionKey(current.url, interaction));
      staleRetries = 0;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AutopilotPageChangedError) {
        clearOrigin(current.url);
        if (selected) attempted.delete(selected.url);
        page = error.page;
        if (++staleRetries > 2) {
          issue(current.url, 'The page kept changing; stopped before repeating an action.');
          partial('The page kept changing. Collected sources are available.'); return;
        }
      } else if (interaction) {
        issue(current.url, 'The action could not be confirmed; it was not repeated.');
        partial('The action could not be confirmed. Collected sources are available.'); return;
      } else {
        issue(selected!.url, 'Could not load or read this source.');
        page = readFailed(selected!.url);
      }
    }
    signal.throwIfAborted();
    accessedAt = new Date().toISOString();
    record(page, performance.now() - started, decisionMs, decision.confidence, label);
  }
}

function assertEvidence(decision: AutopilotDecision, page: AutopilotPage): void {
  const evidence = decision.evidence;
  if (evidence && (!Object.values(researchPagePassages(page)).includes(evidence.text)
    || !Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1)) {
    throw new Error('The selected evidence is not a passage from this page.');
  }
}

function assertAction(decision: AutopilotDecision, page: AutopilotPage, candidates: AutopilotLink[],
  searchText: string | undefined, supported: boolean, completedInteractions: string[]): void {
  if (decision.interaction) {
    if (supported && autopilotActions(page, [], searchText, completedInteractions).some(action => action.kind !== 'navigate'
      && sameAutopilotInteraction(action, decision.interaction!))) return;
  } else if (decision.link && candidates.some(link => link.id === decision.link!.id && link.url === decision.link!.url)) return;
  throw new Error('The research action was not observed in the browser.');
}
