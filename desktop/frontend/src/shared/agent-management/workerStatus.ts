import type { AgentDetails, ManagedAgent, WorkerStatusObservation } from '../../../../shared/agent-management';

// Three normal polls; expiry only invalidates evidence and never changes worker policy.
export const WORKER_STATUS_MAX_AGE_MS = 30_000;
export type WorkerStatus = 'sleeping' | 'starting' | 'busy' | 'idle' | 'manual' | 'error' | 'unknown';
const labels: Record<WorkerStatus, string> = {
  sleeping: '수면 중(작업이 오면 자동 시작)', starting: '시작 중', busy: '작업 중', idle: '대기 중',
  manual: '수동 중지', error: '오류', unknown: '상태 확인 필요',
};
function fresh(observation: WorkerStatusObservation | undefined, now: number): observation is WorkerStatusObservation {
  return !!observation && Number.isFinite(observation.observedAt) && observation.observedAt <= now
    && now - observation.observedAt < WORKER_STATUS_MAX_AGE_MS;
}
export function sameWorkerExecution(a: ManagedAgent, b: ManagedAgent): boolean {
  return a.id === b.id && a.startedAt === b.startedAt && a.state === b.state;
}
export function workerStatus(agent: ManagedAgent, details: AgentDetails | null, now: number, unavailable = false): WorkerStatus {
  if (unavailable || agent.pendingDeletion || !agent.startedAt || !Number.isFinite(Date.parse(agent.startedAt))
    || Date.parse(agent.startedAt) <= 0 || !fresh(agent.status, now)) return 'unknown';
  // Selected-worker details must agree with the list. Failed or stale details cannot confirm its status.
  if (details && (!sameWorkerExecution(agent, details.agent) || !fresh(details.agent.status, now))) return 'unknown';
  if (details && JSON.stringify(agent.status.lifecycle) !== JSON.stringify(details.agent.status?.lifecycle)) return 'unknown';
  const observation = details?.agent.status ?? agent.status;
  const lifecycle = observation.lifecycle, health = observation.health;
  if (agent.state === 'exited') {
    if (lifecycle?.phase === 'sleeping' && lifecycle.stopReason === 'sleep' && lifecycle.error === null) return 'sleeping';
    if (lifecycle?.phase === 'disabled' && lifecycle.stopReason === 'manual') return 'manual';
    if (lifecycle?.phase === 'disabled' && lifecycle.stopReason === 'unexpected') return 'error';
    if (lifecycle?.phase === 'error' && lifecycle.error) return 'error';
    return 'unknown';
  }
  if (agent.state !== 'running') return 'unknown';
  if (lifecycle && !['running', 'starting'].includes(lifecycle.phase)) return 'unknown';
  if (lifecycle?.error) return 'unknown';
  if (health?.error) return 'error';
  if (health?.ready === true && (health.busy === true || health.busy === false)) {
    if (lifecycle?.phase === 'starting') return 'unknown';
    return health.busy ? 'busy' : 'idle';
  }
  // ready=false also covers non-startup situations. Only an observed starting phase proves startup.
  if (lifecycle?.phase === 'starting' && health?.busy !== true) return 'starting';
  return 'unknown';
}
export function workerStatusLabel(agent: ManagedAgent, details: AgentDetails | null, now: number, unavailable = false): string {
  return labels[workerStatus(agent, details, now, unavailable)];
}
