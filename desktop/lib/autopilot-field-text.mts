import type { ResearchCoordinator, ResearchSession } from './autopilot-codex.mts';
import type { AutopilotDecision, AutopilotDecisionInput } from './autopilot-model.mts';
import { autopilotActions, sameAutopilotInteraction } from './autopilot-actions.mts';

export interface AutopilotFieldContext {
  goal: string;
  url: string;
  title: string;
  text: string;
  field: { identity: string; label: string; role: string; value: string; context: string };
  history: string[];
  searchText?: string;
}

export function parseAutopilotFieldText(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid field text response.');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 1 || typeof object.text !== 'string' || !object.text.trim()
    || object.text.length > 2000) throw new Error('No valid value was supplied for this field. Nothing was typed.');
  return object.text;
}

/** Resolve text only for the selected observed field, and reuse only an identical context. */
export function createAutopilotTextResolver(coordinator?: ResearchCoordinator, contextId?: string, shared?: ResearchSession) {
  let owned: ResearchSession | undefined;
  let closed = false;
  const cache = new Map<string, string>();
  return {
    available: shared ? !!shared.fieldText : !!coordinator,
    async resolve(decision: AutopilotDecision, input: AutopilotDecisionInput): Promise<AutopilotDecision> {
      const action = decision.interaction;
      if (!action || action.kind !== 'fill' || decision.completed) return decision;
      const candidate = autopilotActions(input.page, [], input.searchText, input.completedInteractions, true)
        .find(candidate => candidate.kind === 'fill' && sameAutopilotInteraction({ ...candidate, text: action.text }, action));
      if (!candidate || candidate.kind !== 'fill') throw new Error('The selected input is no longer available.');
      // Explicit search text remains authoritative; a model cannot substitute its own value.
      if (candidate.text) {
        if (action.text !== candidate.text) throw new Error('The selected input changed the requested search text.');
        return decision;
      }
      input.signal.throwIfAborted();
      if (closed) throw new Error('The input session is closed.');
      if (!shared && !owned && coordinator) {
        owned = await coordinator.open(contextId, input.signal);
        if (closed || input.signal.aborted) { owned.close(); owned = undefined; input.signal.throwIfAborted(); }
      }
      const session = shared ?? owned;
      if (!session?.fieldText || closed) throw new Error('Select a Codex model to determine this field value.');
      const context: AutopilotFieldContext = { goal: input.goal, url: input.page.url, title: input.page.title,
        text: input.page.text.slice(0, 6000), history: (input.history ?? []).slice(-10), searchText: input.searchText,
        field: { identity: action.control.identity ?? action.control.signature, label: action.control.label,
          role: action.control.role ?? 'textbox', value: action.control.value, context: action.control.context ?? '' } };
      const key = JSON.stringify(context);
      const text = cache.get(key) ?? parseAutopilotFieldText({ text: await session.fieldText(context, input.signal) });
      input.signal.throwIfAborted();
      if (closed) throw new Error('The input session is closed.');
      cache.set(key, text);
      return { ...decision, interaction: { ...action, text } };
    },
    close() { closed = true; owned?.close(); owned = undefined; cache.clear(); },
  };
}
