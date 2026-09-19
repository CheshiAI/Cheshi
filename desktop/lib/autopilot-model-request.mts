import { autopilotRecord } from '../shared/autopilot.ts';
import type { AutopilotDecisionInput, AutopilotFetch } from './autopilot-model.mts';

export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
type Questions = Record<string, ChoiceQuestion>;

// Count UTF-8 bytes, not characters: multilingual menus can be much larger than English text.
// This deliberately leaves headroom below the provider's approximately 32k-token context.
export const AUTOPILOT_REQUEST_BYTES = 28_000;
const STATE_BYTES = 18_000;
const ERROR_BYTES = 16_384;

export function autopilotChoice(value: unknown, criteria: Record<string, string>): { choice: string; confidence: number } {
  const answer = autopilotRecord(value);
  if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(criteria, answer.choice)
    || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
    || answer.confidence < 0 || answer.confidence > 1) throw new Error('TypeSafe returned an invalid choice.');
  return { choice: answer.choice, confidence: answer.confidence };
}

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

function preview(value: string, maximum: number): string {
  if (Buffer.byteLength(value) <= maximum) return value;
  const buffer = Buffer.from(value);
  let end = maximum - 3;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8') + '…';
}

function modelState(input: AutopilotDecisionInput, selectedEvidence: string) {
  const page = input.page;
  const controls = [...(page.controls ?? [])].sort((left, right) => Number(right.kind === 'input') - Number(left.kind === 'input'));
  const state = { goal: input.goal, question: input.question, officialDomains: input.officialDomains, selectedEvidence,
    searchText: input.searchText ?? '', contextIsPartial: true,
    history: (input.history ?? []).slice(-12).map(value => preview(value, 512)),
    currentPage: { url: preview(page.url, 2048), title: preview(page.title, 500), text: preview(page.text, 8000),
      // DOM paths, signatures, form hashes and duplicate surrounding text are execution guards, not model context.
      controls: controls.slice(0, 64).map(control => ({ id: control.id, kind: control.kind, label: preview(control.label, 300),
        value: preview(control.value, 500), role: control.role, search: control.search, autocomplete: control.autocomplete,
        owner: control.owner, submit: control.submit })),
      controlCount: controls.length, section: page.section ? { id: page.section.id, title: preview(page.section.title, 500), kind: page.section.kind } : undefined },
    visited: input.visited.slice(-20).map(url => preview(url, 512)),
    collectedEvidence: (input.collectedEvidence ?? []).slice(-10).map(value => preview(value, 1600)),
    outcomes: (input.outcomes ?? []).slice(-20).map(outcome => ({ action: preview(outcome.action, 512), status: outcome.status,
      url: preview(outcome.url, 512), resultUrl: outcome.resultUrl ? preview(outcome.resultUrl, 512) : undefined, pageChanged: outcome.pageChanged })) };
  // Only shrink supplementary context. Keep the goal, exact search text and selected evidence intact.
  while (bytes(state) > STATE_BYTES) {
    const before = bytes(state);
    state.currentPage.controls = state.currentPage.controls.slice(0, Math.floor(state.currentPage.controls.length / 2));
    state.currentPage.text = preview(state.currentPage.text, Math.max(128, Math.floor(Buffer.byteLength(state.currentPage.text) / 2)));
    state.history = state.history.slice(Math.ceil(state.history.length / 2));
    state.visited = state.visited.slice(Math.ceil(state.visited.length / 2));
    state.collectedEvidence = state.collectedEvidence.slice(Math.ceil(state.collectedEvidence.length / 2));
    state.outcomes = state.outcomes.slice(Math.ceil(state.outcomes.length / 2));
    if (bytes(state) >= before) throw new Error('The Autopilot goal and research context are too large. Use a more specific goal.');
  }
  return state;
}

/** Pack independent questions together, split oversized choices, then compare their winners. No candidate is dropped. */
export async function evaluateAutopilotQuestions(apiKey: string, input: AutopilotDecisionInput, questions: Questions,
  request: AutopilotFetch, selectedEvidence = ''): Promise<Record<string, unknown>> {
  const state = modelState(input, selectedEvidence);
  const serialize = (questions: Questions) => JSON.stringify({ model: 'jev-latest', state, questions });
  const fits = (questions: Questions) => Buffer.byteLength(serialize(questions)) <= AUTOPILOT_REQUEST_BYTES;
  const { signal } = input;
  const send = async (questions: Questions): Promise<Record<string, unknown>> => {
    signal.throwIfAborted();
    const body = serialize(questions);
    if (!fits(questions)) throw new Error('An Autopilot choice is too large. Use a more specific start page.');
    let response: Response;
    try {
      response = await request('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body,
      });
    } catch {
      signal.throwIfAborted();
      throw new Error('Could not reach TypeSafe. Check your connection and try again.');
    }
    signal.throwIfAborted();
    await assertResponse(response, apiKey, signal);
    const result = autopilotRecord(await response.json());
    signal.throwIfAborted();
    return autopilotRecord(result.answers);
  };
  const evaluate = async (pending: Questions): Promise<Record<string, unknown>> => {
    const expanded: Questions = {};
    const parts = new Map<string, string[]>();
    for (const [id, question] of Object.entries(pending)) {
      if (Object.keys(question.criteria).length <= 255 && fits({ [id]: question })) { expanded[id] = question; continue; }
      const fallback: Record<string, string> = Object.hasOwn(question.criteria, 'none') ? { none: question.criteria.none! } : {};
      let criteria: Record<string, string> = { ...fallback };
      const ids: string[] = [];
      const partId = () => `${id}__part_${ids.length}`;
      const add = () => { const name = partId(); expanded[name] = { ...question, criteria }; ids.push(name); criteria = { ...fallback }; };
      for (const [key, value] of Object.entries(question.criteria)) {
        if (key === 'none' && 'none' in fallback) continue;
        const next = { ...criteria, [key]: value };
        if (Object.keys(criteria).length > Object.keys(fallback).length
          && (Object.keys(next).length > 255 || !fits({ [partId()]: { ...question, criteria: next } }))) add();
        criteria[key] = value;
        if (!fits({ [partId()]: { ...question, criteria } })) throw new Error('An Autopilot choice is too large. Use a more specific start page.');
      }
      if (Object.keys(criteria).length) add();
      parts.set(id, ids);
    }
    const answers: Record<string, unknown> = {};
    let batch: Questions = {};
    const flush = async () => {
      if (!Object.keys(batch).length) return;
      const received = await send(batch);
      for (const id of Object.keys(batch)) answers[id] = received[id];
      batch = {};
    };
    for (const [id, question] of Object.entries(expanded)) {
      if (!fits({ ...batch, [id]: question })) await flush();
      batch[id] = question;
    }
    await flush();
    for (const [id, ids] of parts) {
      const question = pending[id]!;
      const winners = [...new Map(ids.map(part => {
        const winner = autopilotChoice(answers[part], expanded[part]!.criteria);
        return [winner.choice, winner] as const;
      })).values()];
      if (winners.length === 1) answers[id] = { type: 'choice', ...winners[0] };
      else {
        // A choice that cannot fit two options cannot make progress by reduction.
        const criteria = { ...(Object.hasOwn(question.criteria, 'none') ? { none: question.criteria.none! } : {}),
          ...Object.fromEntries(winners.map(winner => [winner.choice, question.criteria[winner.choice]!] )) };
        if (Object.keys(criteria).length >= Object.keys(question.criteria).length) throw new Error('Autopilot choices are too large to compare. Use a more specific start page.');
        answers[id] = (await evaluate({ [id]: { ...question, criteria } }))[id];
      }
      for (const part of ids) delete answers[part];
    }
    return answers;
  };
  return evaluate(questions);
}

async function assertResponse(response: Response, apiKey: string, signal: AbortSignal): Promise<void> {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) throw new Error('TypeSafe rejected the API key or model access.');
  if (response.status === 429) throw new Error('TypeSafe usage limit reached. Try again later.');
  const detail = await errorDetail(response, apiKey, signal);
  signal.throwIfAborted();
  throw new Error(`TypeSafe request failed (${response.status}).${detail ? ` ${detail}` : ''}`);
}

async function errorDetail(response: Response, apiKey: string, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (size <= ERROR_BYTES) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ERROR_BYTES) return '';
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let details: string[];
    try { details = diagnosticFields(JSON.parse(raw)); }
    catch { details = /^\s*</.test(raw) ? [] : [raw]; }
    // Never forward echoed request objects/headers, and redact credentials before truncation.
    return details.join('; ').split(apiKey).join('[redacted]').split(encodeURIComponent(apiKey)).join('[redacted]')
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, '[redacted authorization]')
      .replace(/\b(?:api[_ -]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^\s,;"'<>]+/gi, '[redacted credential]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1200);
  } catch { return ''; }
  finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function diagnosticFields(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.slice(0, 8).flatMap(entry => diagnosticFields(entry, depth + 1));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return ['error_type', 'code', 'message', 'msg', 'detail', 'error'].flatMap(key => diagnosticFields(record[key], depth + 1));
}
