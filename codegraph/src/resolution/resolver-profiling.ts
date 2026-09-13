import {
  dumpNameMatcherProfile
} from './name-matcher';
import type { ResolverState } from './resolver-state';
import {
  ResolvedRef,
  UnresolvedRef
} from './types';


export function stageAdd(this: ResolverState, stage: string, ref: UnresolvedRef, hit: boolean, t0: bigint): void {
  if (!this.resolveProfile) return;
  const dt = process.hrtime.bigint() - t0;
  const key = `stage:${stage}|${ref.referenceKind}|${hit ? 'hit' : 'miss'}`;
  const slot = this.resolveProfile.get(key);
  if (slot) {
    slot.n++;
    slot.ns += dt;
  } else {
    this.resolveProfile.set(key, { n: 1, ns: dt });
  }
}

export function resolveOneTimed(this: ResolverState, ref: UnresolvedRef): ResolvedRef | null {
  if (!this.resolveProfile) return this.owner.resolveOne(ref);
  const t0 = process.hrtime.bigint();
  const result = this.owner.resolveOne(ref);
  const dt = process.hrtime.bigint() - t0;
  const key = result ? result.resolvedBy : `fail:${ref.referenceKind}`;
  const slot = this.resolveProfile.get(key);
  if (slot) {
    slot.n++;
    slot.ns += dt;
  } else {
    this.resolveProfile.set(key, { n: 1, ns: dt });
  }
  return result;
}

/** Dump the CODEGRAPH_RESOLVE_PROFILE histogram to stderr (no-op when off). */
export function dumpResolveProfile(this: ResolverState, label: string): void {
  if (!this.resolveProfile || this.resolveProfile.size === 0) return;
  const rows = [...this.resolveProfile.entries()]
    .map(([k, v]) => ({ k, n: v.n, ms: Number(v.ns / 1_000_000n) }))
    .sort((a, b) => b.ms - a.ms);
  for (const r of rows) {
    console.error(
      `[resolve-profile] ${label} ${r.k}: n=${r.n} total=${(r.ms / 1000).toFixed(1)}s avg=${((r.ms * 1000) / Math.max(1, r.n)).toFixed(0)}µs`
    );
  }
  // =2 only: this thread's matchReference sub-stage table rides along.
  dumpNameMatcherProfile(label);
}
