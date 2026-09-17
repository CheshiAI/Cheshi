import { AUTOPILOT_MAX_STEPS, AUTOPILOT_MAX_READS, autopilotUsage, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotRequest, AutopilotState, AutopilotSource, AutopilotIssue, AutopilotStep } from '../shared/autopilot.ts';
import { questionStatus, researchPublisher } from '../shared/autopilot-investigation.ts';
import type { ResearchInvestigation } from '../shared/autopilot-investigation.ts';
import { autopilotActionLabel, autopilotInteractionKey } from './autopilot-actions.mts';
import type { AutopilotPage, AutopilotLink } from './autopilot-model.mts';
import { AutopilotPageChangedError } from './autopilot-runner.mts';
import type { AutopilotRunnerOptions } from './autopilot-runner.mts';
import { assertAction, assertEvidence } from './autopilot-research.mts';
import { isResearchSearchPage, researchPagePassages } from './autopilot-evidence.mts';

/** Planning and synthesis are Codex turns. Only the browser and Jev collect evidence. */
export async function runAutopilotInvestigation(options: AutopilotRunnerOptions, request: AutopilotRequest,
  signal: AbortSignal, update: (state: Partial<AutopilotState>) => void): Promise<void> {
  update({ phase: 'planning' });
  const session = await options.research!.open(request.contextId, signal);
  const sources: AutopilotSource[] = [], issues: AutopilotIssue[] = [], steps: AutopilotStep[] = [];
  let investigation: ResearchInvestigation | undefined;
  let modelMs = 0;
  const publish = (value: Partial<AutopilotState> = {}) => {
    signal.throwIfAborted();
    update({ sources: sources.map(source => ({ ...source })), issues: issues.map(issue => ({ ...issue })),
      steps: steps.map(step => ({ ...step })), modelMs,
      ...(investigation ? { investigation: structuredClone(investigation) } : {}), ...value });
  };
  const issue = (url: string, message: string) => { if (issues.length < 24) issues.push({ url, message: message.slice(0, 2000) }); };
  const exhausted = () => autopilotUsage(steps).navigation >= AUTOPILOT_MAX_STEPS;
  const readingExhausted = () => autopilotUsage(steps).readings >= AUTOPILOT_MAX_READS;
  const record = (page: AutopilotPage, started: number, decisionMs: number, action: string, kind: 'navigation' | 'reading' = 'navigation') => {
    signal.throwIfAborted();
    steps.push({ url: page.url, title: page.title, loadMs: performance.now() - started, decisionMs, confidence: null, kind, action: action.slice(0, 600) });
    publish({ url: page.url, title: page.title, phase: 'thinking' });
  };
  const load = async (url: string, action: string): Promise<AutopilotPage | null> => {
    if (exhausted()) return null;
    publish({ phase: 'loading' });
    const started = performance.now();
    try {
      const page = await options.load(url, signal);
      record(page, started, 0, action);
      return page;
    } catch {
      signal.throwIfAborted();
      issue(url, 'Could not load or read this source.');
      record({ url, title: 'Unavailable page', text: '', links: [] }, started, 0, action);
      return null;
    }
  };
  try {
    let started = performance.now();
    const plan = await session.plan(request.searchText ? `${request.goal}\nSearch hint: ${request.searchText}` : request.goal, signal);
    signal.throwIfAborted();
    modelMs += performance.now() - started;
    investigation = { plan, assessments: [], activeQuestionId: null, model: session.model };
    publish();
    const attempts = new Map<string, number>();
    const documentReads = new Map<string, Set<string>>();
    const documentAttempts = new Map<string, number>();
    const evidencePasses = new Map<string, number>();
    const reportedTruncations = new Set<string>();
    const observations = new Map<string, { evidenceCount: number; visits: number }>();
    const budget = request.targetSources ?? 5;
    let failure: string | null = null;
    try {
      while (!exhausted() && sources.length < budget) {
        // Give each unanswered question a first search before spending its second search.
        const question = plan.questions.filter(q => questionStatus(q, investigation!.assessments) !== 'answered' && (attempts.get(q.id) ?? 0) < 2)
          .sort((a, b) => (attempts.get(a.id) ?? 0) - (attempts.get(b.id) ?? 0))[0];
        if (!question) break;
        const attempt = attempts.get(question.id) ?? 0;
        attempts.set(question.id, attempt + 1);
        investigation.activeQuestionId = question.id;
        const needsOfficial = question.requireOfficial && !investigation.assessments.some(entry => entry.questionId === question.id
          && entry.role === 'official' && entry.sufficient && entry.relation === 'supports');
        const query = attempt && needsOfficial && plan.officialDomains.length
          ? `${question.query} site:${plan.officialDomains[0]}` : attempt ? question.externalQuery : question.query;
        const search = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const isSearchHome = /^https?:\/\/(?:www\.)?google\.[^/]+\/?$/.test(request.url);
        let page = await load(!steps.length && !isSearchHome ? request.url : search, `Search: ${query}`);
        const visited = new Set<string>();
        const frontier = new Map<string, AutopilotLink>();
        const completedInteractions: string[] = [];
        let serial = 0, stale = 0;
        // Reading has its own budget; a query still has a bounded decision allowance.
        for (let decisionCount = 0; page && decisionCount < 16; decisionCount++) {
          signal.throwIfAborted();
          const documentKey = JSON.stringify([question.id, page.url]);
          const sectionKey = JSON.stringify([question.id, page.url, page.documentVersion]);
          const readSections = documentReads.get(sectionKey) ?? new Set<string>();
          documentReads.set(sectionKey, readSections);
          const readAttempts = documentAttempts.get(documentKey) ?? 0;
          if (page.documentTruncated && !reportedTruncations.has(page.url)) {
            reportedTruncations.add(page.url);
            issue(page.url, 'The document exceeds the reading limit; uninspected sections remain unconfirmed.');
          }
          const collectedEvidence = investigation.assessments.filter(entry => entry.questionId === question.id)
            .map(entry => sources.find(source => source.id === entry.sourceId)!.evidence);
          // Ignore changing section IDs or document revisions when the observed content is unchanged.
          const observationKey = JSON.stringify([question.id, page.url, page.text.replace(/\s+/g, ' ').trim()]);
          const previous = observations.get(observationKey);
          const visits = previous?.evidenceCount === collectedEvidence.length ? previous.visits + 1 : 1;
          observations.set(observationKey, { evidenceCount: collectedEvidence.length, visits });
          if (visits >= 3) {
            issue(page.url, 'Repeated the same content without new evidence; moving to another question or search.');
            break;
          }
          visited.add(page.url);
          frontier.delete(page.url);
          for (const link of page.links) {
            const url = safeAutopilotUrl(link.url);
            if (url && !visited.has(url) && !frontier.has(url) && frontier.size < 512) {
              frontier.set(url, { ...link, url, id: `question_link_${++serial}` });
            }
          }
          const candidates = [...frontier.values()];
          started = performance.now();
          const decision = await options.decide({ page: { ...page, links: candidates,
            ...(!options.readSection || readAttempts >= 4 || readingExhausted() || isResearchSearchPage(page.url) ? { sections: [] } : {}) }, question, officialDomains: plan.officialDomains,
            goal: `${request.goal}\nCurrent question: ${question.question}${attempt ? needsOfficial ? '\nFind the official detailed specification.' : '\nFind independent analysis and check contrary evidence.' : ''}`,
            research: true, searchText: query, visited: [...visited], completedInteractions, signal,
            readSections: [...readSections], collectedEvidence });
          signal.throwIfAborted();
          const decisionMs = performance.now() - started;
          modelMs += decisionMs;
          if (decision.evidence && options.read) {
            let observed: AutopilotPage;
            try { observed = await options.read(signal, page); }
            catch (error) {
              if (!(error instanceof AutopilotPageChangedError)) throw error;
              observed = error.page;
            }
            signal.throwIfAborted();
            if (observed.url !== page.url || observed.text !== page.text || observed.documentVersion !== page.documentVersion) {
              if (++stale > 2) { issue(page.url, 'Evidence changed repeatedly; this question remains unconfirmed.'); break; }
              frontier.clear();
              if (observed.url !== page.url) {
                if (exhausted()) break;
                record(observed, performance.now(), decisionMs, 'Page changed; checking evidence again');
              }
              page = observed;
              continue;
            }
          }
          assertEvidence(decision, page);
          if (decision.evidence) {
            const assessment = decision.assessment;
            assertAssessment(assessment);
            let source = sources.find(source => source.url === page!.url && source.evidence === decision.evidence!.text);
            if (!source) {
              source = { id: `s${sources.length + 1}`, url: page.url, title: page.title, evidence: decision.evidence.text,
                confidence: decision.evidence.confidence, accessedAt: new Date().toISOString(), publisher: researchPublisher(page.url, plan.officialDomains),
                ...(page.section ? { section: page.section.title, sectionId: page.section.id } : {}) };
              sources.push(source);
            }
            if (page.section && !source.section) { source.section = page.section.title; source.sectionId = page.section.id; }
            if (!investigation.assessments.some(entry => entry.questionId === question.id && entry.sourceId === source.id)) {
              // Model classification can only downgrade independence of a known official publisher.
              investigation.assessments.push({ ...assessment, role: source.publisher === 'official' ? 'official' : assessment.role,
                sourceId: source.id!, questionId: question.id });
            }
            publish();
          }
          if (sources.length >= budget) break;
          if (decision.section) {
            assertSection(page, decision.section, readSections, readAttempts, !!options.readSection && !readingExhausted());
            if (decisionCount === 15) break;
            documentAttempts.set(documentKey, readAttempts + 1);
            publish({ phase: 'reading' });
            started = performance.now();
            try {
              page = await options.readSection!(page, decision.section, signal);
              signal.throwIfAborted();
              readSections.add(decision.section.id);
              record(page, started, decisionMs, `Read section: ${decision.section.title}`, 'reading');
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof AutopilotPageChangedError && ++stale <= 2) {
                page = error.page; frontier.clear();
                record(page, started, decisionMs, 'Document changed; refreshed sections', 'reading');
              } else {
                record(page, started, decisionMs, 'Unconfirmed document section', 'reading');
                issue(page.url, 'Could not confirm the document section.'); break;
              }
            }
            continue;
          }
          if (questionStatus(question, investigation.assessments) === 'answered') break;
          const evidenceKey = JSON.stringify([question.id, page.url, page.documentVersion, page.section?.id]);
          const passes = evidencePasses.get(evidenceKey) ?? 0;
          const unused = Object.values(researchPagePassages(page)).some(text => text !== decision.evidence?.text && !collectedEvidence.includes(text));
          if (!readingExhausted() && page.section && decision.evidence && unused && passes < 1 && decisionCount < 15) {
            evidencePasses.set(evidenceKey, passes + 1);
            record(page, performance.now(), decisionMs, `Read additional evidence: ${page.section.title}`, 'reading');
            continue;
          }
          if (attempt === 0 && investigation.assessments.some(entry => entry.questionId === question.id && entry.sufficient)
            && question.requireIndependent) break;
          if (exhausted() || (!decision.interaction && !decision.link)) break;
          // Do not perform a navigation when this query's last decision cannot inspect it.
          if (decisionCount === 15) break;
          assertAction(decision, page, candidates, query, !!options.interact, completedInteractions);
          const current = page;
          const interaction = decision.interaction;
          const selected = decision.link;
          const label = autopilotActionLabel(interaction ?? { kind: 'navigate', link: selected! });
          publish({ phase: interaction ? 'acting' : 'loading' });
          started = performance.now();
          try {
            if (interaction) page = await options.interact!(current, interaction, signal);
            else {
              const local = current.links.find(link => link.url === selected!.url);
              page = local ? await options.follow(current, local, signal) : await options.load(selected!.url, signal);
            }
            signal.throwIfAborted();
            if (interaction) completedInteractions.push(autopilotInteractionKey(current.url, interaction));
            record(page, started, decisionMs, label);
            stale = 0;
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof AutopilotPageChangedError && ++stale <= 2) {
              page = error.page;
              frontier.clear();
              record(page, started, decisionMs, 'Page changed; refreshed actions');
            } else {
              const url = selected?.url ?? current.url;
              issue(url, 'Could not confirm the browser action; searching another question.');
              record({ url, title: 'Unconfirmed action', text: '', links: [] }, started, decisionMs, label);
              break;
            }
          }
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      failure = error instanceof Error ? error.message.slice(0, 2000) : 'Evidence collection failed.';
      issue(steps.at(-1)?.url ?? request.url, failure);
    }
    const remaining = plan.questions.some(question => questionStatus(question, investigation!.assessments) !== 'answered');
    if (remaining && exhausted()) issue(steps.at(-1)?.url ?? request.url, 'Navigation limit reached (20 actions). Collected evidence was retained.');
    if (remaining && readingExhausted()) issue(steps.at(-1)?.url ?? request.url, 'Document reading limit reached (40 reads). Collected evidence was retained.');
    investigation.activeQuestionId = null;
    publish({ phase: 'synthesizing' });
    started = performance.now();
    investigation.report = await session.report(request.goal, plan, sources, investigation.assessments, signal);
    signal.throwIfAborted();
    modelMs += performance.now() - started;
    const complete = investigation.report.answers.every(answer => answer.status === 'answered');
    publish({ phase: complete && !failure ? 'completed' : 'partial',
      error: failure ?? (complete ? null : exhausted()
        ? 'Navigation limit reached (20 actions). Some questions remain unconfirmed.'
        : 'Some questions remain unconfirmed or conflicting. See the report limitations.') });
  } finally { session.close(); }
}

function assertSection(page: AutopilotPage, section: import('./autopilot-document.mts').AutopilotSection,
  read: Set<string>, attempts: number, supported: boolean): void {
  if (!supported || isResearchSearchPage(page.url) || attempts >= 4 || read.has(section.id)
    || !page.sections?.some(candidate => JSON.stringify(candidate) === JSON.stringify(section))) {
    throw new Error('The selected document section is unavailable or already read.');
  }
}

function assertAssessment(value: unknown): asserts value is NonNullable<import('./autopilot-model.mts').AutopilotDecision['assessment']> {
  const entry = value as Record<string, unknown> | undefined;
  if (!entry || !['official', 'external', 'unknown'].includes(String(entry.role))
    || !['supports', 'challenges', 'context'].includes(String(entry.relation))
    || (entry.sufficient !== true && entry.sufficient !== false)) throw new TypeError('Jev returned an invalid evidence assessment.');
}
