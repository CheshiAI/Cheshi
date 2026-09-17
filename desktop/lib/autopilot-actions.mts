import { safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotLink, AutopilotPage } from './autopilot-model.mts';

export interface AutopilotControl {
  id: string;
  kind: 'input' | 'button';
  label: string;
  signature: string;
  value: string;
}
export type AutopilotInteraction =
  | { kind: 'fill'; control: AutopilotControl; text: string }
  | { kind: 'click'; control: AutopilotControl };
export type AutopilotAction = AutopilotInteraction | { kind: 'navigate'; link: AutopilotLink };

export function autopilotActionLabel(action: AutopilotAction): string {
  if (action.kind === 'navigate') return `Open: ${action.link.label}`;
  if (action.kind === 'fill') return `Type: ${action.text}`;
  return `Click: ${action.control.label}`;
}

export function autopilotActions(page: AutopilotPage, visited: string[], searchText = ''): AutopilotAction[] {
  const links: AutopilotAction[] = page.links.filter(link => safeAutopilotUrl(link.url) && !visited.includes(link.url))
    .map(link => ({ kind: 'navigate', link }));
  // Leaving Search text empty preserves the original link-only mode.
  if (!searchText) return links;
  const controls: AutopilotAction[] = (page.controls ?? []).flatMap<AutopilotAction>(control => {
    if (control.kind === 'button') return [{ kind: 'click', control }];
    return control.value === searchText ? [] : [{ kind: 'fill', control, text: searchText }];
  });
  return [...controls, ...links];
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
