import { safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotLink, AutopilotPage } from './autopilot-model.mts';

export interface AutopilotControl {
  id: string;
  kind: 'input' | 'button';
  label: string;
  signature: string;
  value: string;
  identity?: string;
  role?: string;
  context?: string;
  formState?: string;
  autocomplete?: boolean;
  search?: boolean;
  owner?: string;
  submit?: boolean;
}
export type AutopilotInteraction =
  | { kind: 'fill'; control: AutopilotControl; text: string }
  | { kind: 'click'; control: AutopilotControl };
export type AutopilotAction = AutopilotInteraction | { kind: 'navigate'; link: AutopilotLink };

export function autopilotActionLabel(action: AutopilotAction): string {
  if (action.kind === 'navigate') return `Open: ${action.link.label}`;
  if (action.kind === 'fill') return action.text && action.text === action.control.value
    ? `Already set: ${action.control.label}` : action.text ? `Type: ${action.text}` : `Enter text: ${action.control.label}`;
  return `Click: ${action.control.label}`;
}

export function autopilotActions(page: AutopilotPage, visited: string[], searchText = '', completedInteractions: string[] = [], fieldTextAvailable = false): AutopilotAction[] {
  const links: AutopilotAction[] = page.links.filter(link => safeAutopilotUrl(link.url) && !visited.includes(link.url))
    .map(link => ({ kind: 'navigate', link }));
  // Without explicit search text or a text provider, preserve link-only navigation.
  if (!searchText && !fieldTextAvailable) return links;
  const awaitingSuggestion = (page.controls ?? []).some(control => control.autocomplete === true && control.value
    && !isAutopilotSearchControl(control) && page.controls?.some(option => option.role === 'option' && option.owner === control.id));
  const controls: AutopilotAction[] = (page.controls ?? []).flatMap<AutopilotAction>(control => {
    if (control.kind === 'button') return control.submit === true && awaitingSuggestion ? [] : [{ kind: 'click', control }];
    const text = isAutopilotSearchControl(control) ? searchText : '';
    if (!text && !fieldTextAvailable) return [];
    return text && control.value === text ? [] : [{ kind: 'fill', control, text }];
  });
  return [...controls.filter(action => action.kind === 'navigate'
    || (!completedInteractions.includes(autopilotInteractionKey(page.url, action))
      && !(action.kind === 'fill' && completedInteractions.includes(autopilotInteractionKey(page.url, { ...action, text: '' })))
      && !(action.kind === 'fill' && !action.text && action.control.value
        && completedInteractions.includes(autopilotInteractionKey(page.url, { ...action, text: action.control.value }))))), ...links];
}

export function autopilotActionId(action: AutopilotAction): string {
  return action.kind === 'navigate' ? action.link.id : `${action.kind}_${action.control.id}`;
}

export function sameAutopilotInteraction(left: AutopilotInteraction, right: AutopilotInteraction): boolean {
  return left.kind === right.kind && left.control.id === right.control.id
    && left.control.signature === right.control.signature && left.control.value === right.control.value
    && (left.kind !== 'fill' || (right.kind === 'fill' && left.text === right.text));
}

export function autopilotPageFingerprint(page: AutopilotPage): string {
  return JSON.stringify([page.url, page.title, page.text, page.links.map(link => [link.url, link.label]),
    (page.controls ?? []).map(control => [control.kind, control.signature, control.value])]);
}

/** Ignore ephemeral DOM IDs and toggle state so a recreated button cannot restart a loop. */
export function autopilotInteractionKey(url: string, action: AutopilotInteraction): string {
  return JSON.stringify([url, action.kind, action.control.identity ?? action.control.signature,
    action.kind === 'fill' ? action.text : action.control.formState ?? '']);
}

export const AUTOPILOT_SEARCH_LABEL = /^(search(?: (?:the )?(?:site|web|articles|docs|documentation|products))?|query|검색(?:어)?|사이트 검색|문서 검색)$/i;

export function isAutopilotSearchControl(control: AutopilotControl): boolean {
  if (control.search !== undefined) return control.search === true;
  return AUTOPILOT_SEARCH_LABEL.test(control.label.trim());
}

export function availableAutopilotInteraction(action: AutopilotInteraction, page: AutopilotPage,
  searchText: string | undefined, completed: string[], fieldTextAvailable = false): boolean {
  if (completed.includes(autopilotInteractionKey(page.url, action))) return false;
  return autopilotActions(page, [], searchText, completed, fieldTextAvailable).some(candidate => {
    if (candidate.kind === 'navigate') return false;
    if (candidate.kind === 'fill' && action.kind === 'fill' && !candidate.text && fieldTextAvailable) {
      return action.text.length > 0 && action.text.length <= 2000
        && sameAutopilotInteraction({ ...candidate, text: action.text }, action);
    }
    return sameAutopilotInteraction(candidate, action);
  });
}
