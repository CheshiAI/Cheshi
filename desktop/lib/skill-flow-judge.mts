import { recordValue } from './codex-service-utils.mts';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface SkillFlowQuestion {
  state: string | JsonValue[] | { [key: string]: JsonValue };
  condition: string;
}
export const SKILL_FLOW_REQUEST_BYTES = 28_000;
export type SkillFlowJudgeError = 'missing_key' | 'key_unavailable' | 'invalid_input'
  | 'network' | 'http' | 'timeout' | 'canceled' | 'invalid_response' | 'fallback_failed';
interface JudgmentMetadata {
  provider?: 'jev' | 'luna';
  attempts?: SkillFlowAttempt[];
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
}
export interface SkillFlowAttempt {
  provider: 'jev' | 'luna';
  status: 'decided' | 'error';
  choice: 'yes' | 'no' | null;
  reason?: SkillFlowJudgeError;
  httpStatus?: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
}
export type SkillFlowJudgment = JudgmentMetadata & (
  | { status: 'decided'; value: boolean; choice: 'yes' | 'no' }
  | { status: 'error'; value: null; choice: null; reason: SkillFlowJudgeError; httpStatus?: number }
);
export type SkillFlowJudge = (question: SkillFlowQuestion, signal?: AbortSignal) => Promise<SkillFlowJudgment>;
export type SkillFlowFetch = (url: string, init: RequestInit) => Promise<Response>;

function assertQuestion(question: SkillFlowQuestion): void {
  if (typeof question.condition !== 'string' || !question.condition.trim()) {
    throw new TypeError('A non-empty condition is required.');
  }
  if (typeof question.state !== 'string' && (question.state === null || typeof question.state !== 'object')) {
    throw new TypeError('State must be a string, object, or array.');
  }
}

function assertRequestSize(body: string): void {
  if (Buffer.byteLength(body) > SKILL_FLOW_REQUEST_BYTES) throw new RangeError('Skill flow input is too large.');
}

/** Shared serialization keeps preflight checks identical to the actual provider request. */
export function skillFlowRequestBody(question: SkillFlowQuestion, model = 'jev-latest'): string {
  assertQuestion(question);
  const body = JSON.stringify({ model, state: question.state, questions: {
    condition: { type: 'choice', instructions: question.condition, criteria: {
      yes: '조건이 충족됩니다.', no: '조건이 충족되지 않습니다.',
    } },
  } });
  assertRequestSize(body);
  return body;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Follow Jev's selected option; probability and confidence fields are not consumed. */
export function createSkillFlowJudge(options: {
  getKey(): string | null;
  request?: SkillFlowFetch;
  model?: string;
  timeoutMs?: number;
}): SkillFlowJudge {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('Skill flow timeout must be between 1 and 120000 ms.');
  }
  const model = options.model ?? 'jev-latest';
  if (!model.trim()) throw new TypeError('A model is required.');

  return async (question, signal) => {
    const started = performance.now();
    let raw: unknown;
    const metadata = (): JudgmentMetadata => {
      const response = recordValue(raw), usage = recordValue(response?.usage);
      return {
        model: typeof response?.model === 'string' ? response.model : null,
        inputTokens: tokenCount(usage?.input_tokens), outputTokens: tokenCount(usage?.output_tokens),
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      };
    };
    const error = (reason: SkillFlowJudgeError, httpStatus?: number): SkillFlowJudgment => ({
      ...metadata(), status: 'error', value: null, choice: null, reason,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
    if (signal?.aborted) return error('canceled');
    let body: string;
    try {
      body = skillFlowRequestBody(question, model);
    } catch { return error('invalid_input'); }

    let key: string | null;
    try { key = options.getKey()?.trim() ?? null; }
    catch { return error('key_unavailable'); }
    if (!key) return error('missing_key');
    if (/[^\x21-\x7e]/.test(key)) return error('key_unavailable');

    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const interrupted = (): SkillFlowJudgeError | null => signal?.aborted ? 'canceled'
      : timeout.aborted ? 'timeout' : null;
    let response: Response;
    try {
      response = await (options.request ?? fetch)('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
      });
    } catch { return error(interrupted() ?? 'network'); }
    if (interrupted() || !response.ok) {
      // Provider bodies can contain private data; never include them in a report.
      try { await response.body?.cancel(); } catch { /* Cancellation is best effort. */ }
      return error(interrupted() ?? 'http', response.ok ? undefined : response.status);
    }
    try { raw = await response.json(); }
    catch { return error(interrupted() ?? 'invalid_response'); }
    const interruption = interrupted();
    if (interruption) return error(interruption);
    const answer = recordValue(recordValue(recordValue(raw)?.answers)?.condition);
    const choice = answer?.choice;
    if (answer?.type !== 'choice' || (choice !== 'yes' && choice !== 'no')) return error('invalid_response');
    return { ...metadata(), status: 'decided', value: choice === 'yes', choice };
  };
}
