export const SKILL_FLOW_TIMEOUT_MS = 300_000;
export const SKILL_FLOW_MAX_JUDGMENTS = 64;
export interface SkillFlowLimits { timeoutMs?: number; maxJudgments?: number }

export class SkillFlowLimitError extends Error {
  readonly reason: 'timeout' | 'call_limit';
  constructor(reason: 'timeout' | 'call_limit') {
    super(`Skill execution stopped: ${reason}`);
    this.reason = reason;
  }
}

export function skillFlowLimits(options: SkillFlowLimits = {}) {
  const timeoutMs = options.timeoutMs ?? SKILL_FLOW_TIMEOUT_MS;
  const maxJudgments = options.maxJudgments ?? SKILL_FLOW_MAX_JUDGMENTS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000
    || !Number.isSafeInteger(maxJudgments) || maxJudgments < 1 || maxJudgments > 1000) {
    throw new TypeError('Invalid skill execution limits.');
  }
  return { timeoutMs, maxJudgments };
}

/** Bounds waiting and prevents further judgment calls; arbitrary in-process side effects are not rolled back. */
export function createSkillFlowScope(options: SkillFlowLimits & { signal?: AbortSignal }) {
  const limits = skillFlowLimits(options);
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new SkillFlowLimitError('timeout')), limits.timeoutMs);
  let calls = 0;
  return {
    signal,
    consumeJudgment() {
      signal.throwIfAborted();
      if (calls >= limits.maxJudgments) controller.abort(new SkillFlowLimitError('call_limit'));
      signal.throwIfAborted();
      calls++;
    },
    async wait<T>(operation: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      let interrupt: () => void = () => {};
      const canceled = new Promise<never>((_resolve, reject) => {
        interrupt = () => reject(signal.reason);
        signal.addEventListener('abort', interrupt, { once: true });
      });
      try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), canceled]); }
      finally { signal.removeEventListener('abort', interrupt); }
    },
    close() {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      controller.abort(new Error('Skill execution closed.'));
    },
  };
}
