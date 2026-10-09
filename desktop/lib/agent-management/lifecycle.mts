import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentRuntimeState } from '../../shared/agent-runtime.ts';
import type { Binding } from '../agent-orchestration/mailbox.mts';
import type { CollaborationConnection } from '../agent-orchestration/service.mts';
import { agentRecord, parseAgentDetails, parseWorkerStopReason, type AgentDetails, type ManagedAgent, type WorkerLifecycleDisplay } from '../../shared/agent-management.ts';

export type WorkerPhase = 'starting' | 'running' | 'draining' | 'sleeping' | 'disabled' | 'error';
type Entry = { startAttempted?: true; stopReason?: WorkerLifecycleDisplay['stopReason']; binding: Binding; phase: WorkerPhase; details: AgentDetails | null; nextWakeAt: number | null;
  failures: number; retryAt: number; error: string | null };
type Live = { externalBusy?: boolean; connection: CollaborationConnection; details: AgentDetails };
interface Options {
  filename: string; now?(): number; idleMs?: number;
  inspect(binding: Binding): Promise<Live | null>;
  start(binding: Binding): Promise<Live>;
  stopped(binding: Binding, containerId: string): Promise<boolean>;
  control(connection: CollaborationConnection, action: string, body?: unknown): Promise<unknown>;
  demand(binding: Binding): boolean;
  changed?(binding: Binding): void;
  maintenance?(binding: Binding): void;
}

/** Main-process owner. The inbox owns demand; this journal owns only worker power state. */
export class WorkerLifecycle {
  private readonly options: Options;
  private entries: Record<string, Entry> | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly terminals = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly nextProbe = new Map<string, number>();
  private readonly idle = new Map<string, number>();
  private readonly reconciled = new Set<string>();
  constructor(options: Options) { this.options = options; }
  private now() { return this.options.now?.() ?? Date.now(); }
  private load() {
    if (this.entries) return this.entries;
    const raw = existsSync(this.options.filename) ? agentRecord(JSON.parse(readFileSync(this.options.filename, 'utf8'))) : {};
    const entries: Record<string, Entry> = {};
    for (const [id, value] of Object.entries(raw)) {
      const e = agentRecord(value), b = agentRecord(e.binding);
      if ((e.startAttempted !== undefined && e.startAttempted !== true) || !['starting', 'running', 'draining', 'sleeping', 'disabled', 'error'].includes(String(e.phase))
        || b.id !== id || !['id', 'scope', 'workspace', 'engineId', 'agentId', 'accountId'].every(k => typeof b[k] === 'string')
        || !(e.nextWakeAt === null || typeof e.nextWakeAt === 'number' && Number.isFinite(e.nextWakeAt))
        || !Number.isSafeInteger(e.failures) || Number(e.failures) < 0 || typeof e.retryAt !== 'number' || !Number.isFinite(e.retryAt)
        || !(e.error === null || typeof e.error === 'string')) throw new Error('Invalid worker lifecycle journal.');
      entries[id] = { stopReason: parseWorkerStopReason(e.stopReason), ...(e.startAttempted === true ? { startAttempted: true as const } : {}), binding: b as unknown as Binding, phase: e.phase as WorkerPhase,
        details: e.details === null ? null : parseAgentDetails(e.details), nextWakeAt: e.nextWakeAt as number | null,
        failures: Number(e.failures), retryAt: e.retryAt, error: e.error as string | null };
    }
    this.entries = entries; return entries;
  }
  private save(binding: Binding, patch: Partial<Entry>) {
    const previous = this.entry(binding);
    const next: Record<string, Entry> = { ...this.load(), [binding.id]: { binding, phase: 'running', details: null, nextWakeAt: null,
      failures: 0, retryAt: 0, error: null, ...previous, ...patch } };
    if (JSON.stringify(next) === JSON.stringify(this.load())) return;
    mkdirSync(dirname(this.options.filename), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.options.filename}.tmp`, JSON.stringify(next), { mode: 0o600, flush: true });
    renameSync(`${this.options.filename}.tmp`, this.options.filename); this.entries = next;
    this.options.changed?.(binding);
  }
  nextCheck(binding: Binding): number | null {
    const e = this.entry(binding);
    if (!e || e.phase === 'disabled' || e.failures >= 3) return null;
    if (e.failures > 0) return e.retryAt;
    if (e.phase === 'sleeping') return !this.reconciled.has(binding.id) && this.nextProbe.has(binding.id) ? this.nextProbe.get(binding.id)! : e.nextWakeAt;
    return this.nextProbe.get(binding.id) ?? null;
  }
  activity(binding: Binding) { this.nextProbe.delete(binding.id); }
  private entry(binding: Binding) {
    const entry = this.load()[binding.id];
    if (entry && JSON.stringify(entry.binding) !== JSON.stringify(binding)) throw new Error('Worker lifecycle identity changed.');
    return entry;
  }
  demand(binding: Binding) {
    this.generations.set(binding.id, (this.generations.get(binding.id) ?? 0) + 1);
    this.idle.delete(binding.id);
  }
  async exclusive<T>(binding: Binding, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(binding.id) ?? Promise.resolve();
    const flight = previous.catch(() => {}).then(operation);
    this.locks.set(binding.id, flight);
    try { return await flight; } finally { if (this.locks.get(binding.id) === flight) this.locks.delete(binding.id); }
  }
  state(binding: Binding): AgentRuntimeState['lifecycle'] {
    const e = this.entry(binding);
    return e ? { phase: e.phase === 'sleeping' && !this.reconciled.has(binding.id) ? 'draining' : e.phase, error: e.error } : undefined;
  }
  /** Display only: no reconciliation, persistence, activity or wake side effects. */
  project(engineId: string, agent: ManagedAgent): WorkerLifecycleDisplay | undefined {
    if (!agent.startedAt || !Number.isFinite(Date.parse(agent.startedAt)) || Date.parse(agent.startedAt) <= 0) return;
    const entries = Object.values(this.load()).filter(e => e.binding.engineId === engineId && e.details?.agent.id === agent.id);
    if (entries.length !== 1) return;
    const e = entries[0]!;
    if (e.details?.agent.startedAt !== agent.startedAt) return;
    // Persisted startup intent is not evidence that this host is still starting the worker.
    if (e.phase === 'starting' && !this.reconciled.has(e.binding.id)) return;
    return Object.freeze({ phase: e.phase === 'sleeping' && !this.reconciled.has(e.binding.id) ? 'draining' : e.phase,
      error: e.error, ...(e.stopReason ? { stopReason: e.stopReason } : {}) });
  }
  private savedDetails(details: AgentDetails): AgentDetails {
    const { status: _status, ...agent } = details.agent;
    return { ...structuredClone(details), agent: structuredClone(agent), logs: '' };
  }
  cached(binding: Binding): AgentRuntimeState | null {
    const e = this.entry(binding);
    if (e?.phase === 'sleeping' && !this.reconciled.has(binding.id)) return null;
    if (!e || !['sleeping', 'disabled', 'starting', 'error'].includes(e.phase)) return null;
    return { details: e.details ? { ...structuredClone(e.details), ready: false, busy: false,
      agent: { ...e.details.agent, state: e.phase === 'sleeping' ? 'exited' : e.details.agent.state } } : null,
      lifecycle: { phase: e.phase, error: e.error } };
  }
  adopt(binding: Binding, details: AgentDetails) {
    this.save(binding, { phase: 'running', stopReason: undefined, details: this.savedDetails(details), nextWakeAt: null, failures: 0, retryAt: 0, error: null });
    this.reconciled.add(binding.id); this.idle.delete(binding.id);
  }
  private remember(binding: Binding, details: AgentDetails, retryRecovered = false) {
    this.save(binding, { details: this.savedDetails(details),
      ...(retryRecovered ? { failures: 0, retryAt: 0, error: null } : {}) });
  }
  private assertContainer(details: AgentDetails, containerId: string) {
    if (details.agent.id !== containerId) throw new Error('Worker identity changed. Refresh before controlling it.');
  }
  private assertRetryRecovered(details: AgentDetails) {
    if (details.error !== null) throw new Error(details.error);
  }
  disable(binding: Binding) { this.save(binding, { phase: 'disabled', stopReason: 'unexpected', error: 'Worker stopped. Start it explicitly in Agents.' }); }
  permitsStoppedWake(binding: Binding) { const e = this.entry(binding); return !!e && (['sleeping', 'starting'].includes(e.phase) || e.phase === 'error' && e.startAttempted === true); }
  retry(binding: Binding) {
    const entry = this.entry(binding);
    if (entry?.phase === 'disabled') throw new Error('Worker manually stopped. Start it explicitly in Agents.');
    if (entry) this.save(binding, { failures: 0, retryAt: 0, error: null });
  }
  async connection(binding: Binding, demand: boolean): Promise<CollaborationConnection | null> {
    try { return await this.connect(binding, demand); }
    catch (error) {
      const entry = this.entry(binding);
      if (entry?.phase !== 'disabled' && (!entry || this.now() >= entry.retryAt)) {
        const failures = (entry?.failures ?? 0) + 1;
        this.save(binding, { phase: entry?.phase ?? 'error', failures, retryAt: this.now() + 30_000 * 2 ** Math.min(failures - 1, 4),
          error: error instanceof Error ? error.message : 'Worker unavailable.' });
      }
      throw error;
    }
  }
  private async connect(binding: Binding, demand: boolean): Promise<CollaborationConnection | null> {
    let e = this.entry(binding);
    if (e?.phase === 'disabled') {
      if (demand) throw new Error('Worker is manually stopped. Start it explicitly to enable automatic wake.');
      return null;
    }
    const due = e?.nextWakeAt != null && e.nextWakeAt <= this.now();
    if (e && (e.failures >= 3 || this.now() < e.retryAt)) {
      if (demand) throw new Error(e.error ?? 'Worker could not start. Retry explicitly.');
      return null;
    }
    if (!e && !demand && this.reconciled.has(binding.id)) return null;
    if (e?.phase === 'sleeping' && !demand && !due && this.reconciled.has(binding.id)) return null;
    const live = await this.options.inspect(binding);
    if (e && live && e.details && e.details.agent.id !== live.details.agent.id) throw new Error('Worker identity changed. Start it explicitly.');
    if (live) {
      if (e?.failures) this.assertRetryRecovered(live.details);
      if (e?.phase === 'draining' || e?.phase === 'sleeping') {
        // A crash between prepare and commit must release the admission lease before delivery.
        await this.options.control(live.connection, 'resume');
      }
      if (e?.phase !== 'running') this.adopt(binding, live.details);
      // Recover inspection retries without resetting the existing idle deadline.
      else if (live.details.error === null) this.remember(binding, live.details, e.failures > 0);
      this.reconciled.add(binding.id);
      if (demand || due) this.demand(binding);
      return live.connection;
    }
    if (e?.phase === 'sleeping' && e.details && !await this.options.stopped(binding, e.details.agent.id)) throw new Error('Worker sleep is not confirmed. Inspect its container.');
    this.reconciled.add(binding.id);
    if (e?.phase === 'running' || e?.phase === 'draining') {
      this.save(binding, { phase: 'disabled', stopReason: 'unexpected', error: 'Worker stopped unexpectedly. Inspect and start it explicitly.' });
      if (demand) throw new Error('Worker stopped unexpectedly. Inspect and start it explicitly.');
      return null;
    }
    if (!demand && !due) return null;
    this.demand(binding);
    this.save(binding, { phase: 'starting', stopReason: undefined, startAttempted: true, error: null });
    try {
      const started = await this.options.start(binding);
      this.adopt(binding, started.details);
      return started.connection;
    } catch (error) {
      e = this.entry(binding);
      const failures = (e?.failures ?? 0) + 1;
      this.save(binding, { phase: 'error', failures, retryAt: this.now() + 30_000 * 2 ** Math.min(failures - 1, 4),
        error: error instanceof Error ? error.message : 'Worker could not start.' });
      throw error;
    }
  }
  async rest(binding: Binding, connection: CollaborationConnection, historyBusy: boolean) {
    try { await this.prepareRest(binding, connection, historyBusy); }
    catch (error) {
      this.save(binding, { error: error instanceof Error ? error.message : 'Safe idle could not be confirmed.' });
      // Failure to prove idleness must leave the worker running, not block task delivery.
      this.idle.delete(binding.id);
      this.nextProbe.set(binding.id, this.now() + 120_000);
    }
  }
  private async prepareRest(binding: Binding, connection: CollaborationConnection, historyBusy: boolean) {
    if (historyBusy || this.options.demand(binding) || this.terminalOpen(binding)) { this.idle.delete(binding.id); this.nextProbe.delete(binding.id); return; }
    if (this.now() < (this.nextProbe.get(binding.id) ?? 0)) return;
    this.nextProbe.set(binding.id, this.now() + 120_000);
    const p = agentRecord(await this.options.control(connection, 'status'));
    if (p.protocol !== 1 || p.idle !== true || !(p.nextWakeAt === null || typeof p.nextWakeAt === 'number' && Number.isFinite(p.nextWakeAt))) {
      this.idle.delete(binding.id); this.nextProbe.delete(binding.id); return;
    }
    const now = this.now(), since = this.idle.get(binding.id) ?? now;
    this.idle.set(binding.id, since);
    this.nextProbe.set(binding.id, since + (this.options.idleMs ?? 300_000));
    if (now - since < (this.options.idleMs ?? 300_000)) return;
    const generation = this.generations.get(binding.id) ?? 0;
    const prepared = agentRecord(await this.options.control(connection, 'prepare'));
    if (prepared.protocol !== 1 || prepared.idle !== true || typeof prepared.lease !== 'string'
      || !(prepared.nextWakeAt === null || typeof prepared.nextWakeAt === 'number' && Number.isFinite(prepared.nextWakeAt))) throw new Error('Invalid worker sleep receipt.');
    this.save(binding, { phase: 'draining', error: null });
    const live = await this.options.inspect(binding);
    if (!live || live.externalBusy === true || live.details.busy || this.terminalOpen(binding, live.details.agent.id) || generation !== (this.generations.get(binding.id) ?? 0) || this.options.demand(binding)) {
      await this.options.control(connection, 'resume');
      this.save(binding, { phase: 'running' }); this.idle.delete(binding.id);
      this.nextProbe.set(binding.id, this.now() + (this.options.idleMs ?? 300_000)); return;
    }
    // Persist intent before commit. A restart reconciles Docker before treating it as asleep.
    this.save(binding, { phase: 'sleeping', stopReason: 'sleep', details: this.savedDetails(live.details), nextWakeAt: prepared.nextWakeAt as number | null });
    this.reconciled.delete(binding.id);
    await this.options.control(connection, 'commit', { lease: prepared.lease });
    if (!await this.options.stopped(binding, live.details.agent.id)) throw new Error('Worker sleep is not confirmed.');
    this.reconciled.add(binding.id); this.idle.delete(binding.id); this.options.changed?.(binding);
  }
  hold(engineId: string, containerId: string): () => void {
    const entry = Object.values(this.load()).find(e => e.binding.engineId === engineId && e.details?.agent.id === containerId);
    if (entry && entry.phase !== 'running') throw new Error('Start this worker before opening its terminal.');
    if (entry) this.demand(entry.binding);
    const key = `${engineId}/${containerId}`;
    this.terminals.set(key, (this.terminals.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.terminals.get(key) ?? 1) - 1;
      if (count) this.terminals.set(key, count); else this.terminals.delete(key);
      if (entry) { this.nextProbe.delete(entry.binding.id); this.options.maintenance?.(entry.binding); }
    };
  }
  private terminalOpen(binding: Binding, containerId?: string) {
    const id = containerId ?? this.entry(binding)?.details?.agent.id;
    return !!id && (this.terminals.get(`${binding.engineId}/${id}`) ?? 0) > 0;
  }
  async manual<T>(engineId: string, containerId: string, action: string, operation: () => Promise<T>, readDetails?: () => Promise<AgentDetails>) {
    const entry = Object.values(this.load()).find(e => e.binding.engineId === engineId && e.details?.agent.id === containerId);
    if (!entry) return operation();
    this.demand(entry.binding);
    return this.exclusive(entry.binding, async () => {
      // Capture activity while the API is still available; stopped workers cannot serve it.
      const latest = readDetails ? await readDetails() : (await this.options.inspect(entry.binding))?.details;
      if (latest) {
        this.assertContainer(latest, containerId);
        if (latest.agent.state === 'running') {
          if (latest.error) throw new Error('Could not preserve the latest worker details. Refresh before controlling it.');
          this.remember(entry.binding, latest);
        }
      }
      // Persist stop intent before issuing Docker control, even if its acknowledgement is lost.
      const saved = this.entry(entry.binding)!.details;
      this.save(entry.binding, { phase: 'disabled', stopReason: undefined, error: 'Worker stop is not confirmed. Refresh or start it explicitly.',
        details: saved ? { ...saved, ready: false, busy: false, execution: null, agent: { ...saved.agent, state: 'unknown' } } : null });
      const result = await operation();
      if (action === 'stop') {
        if (!await this.options.stopped(entry.binding, containerId)) throw new Error('Worker stop is not confirmed. Inspect its container.');
        const details = this.entry(entry.binding)!.details;
        this.save(entry.binding, { stopReason: 'manual', error: 'Worker manually stopped.',
          details: details ? { ...details, agent: { ...details.agent, state: 'exited' } } : null });
      } else this.save(entry.binding, { phase: 'starting', stopReason: undefined, error: null, failures: 0, retryAt: 0 });
      return result;
    });
  }
  async settled() { await Promise.allSettled([...this.locks.values()]); }
}
