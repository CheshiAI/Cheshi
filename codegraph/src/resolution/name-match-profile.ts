import { ResolvedRef, UnresolvedRef } from './types';

/**
 * CODEGRAPH_RESOLVE_PROFILE=2 sub-stage attribution for matchReference's
 * strategy pipeline (`nm:<stage>|<refKind>|hit/miss`). Module-global because
 * the matcher is a free function; each thread (main + every pool worker) has
 * its own module instance, and dumpNameMatcherProfile is invoked from
 * ReferenceResolver.dumpResolveProfile so worker tables surface too.
 */
const NM_PROFILE: Map<string, { n: number; ns: bigint }> | null =
  process.env.CODEGRAPH_RESOLVE_PROFILE === '2' ? new Map() : null;

export function nmTimedT<T>(stage: string, ref: UnresolvedRef, fn: () => T): T {
  if (!NM_PROFILE) return fn();
  const t0 = process.hrtime.bigint();
  const r = fn();
  const dt = process.hrtime.bigint() - t0;
  const key = `nm:${stage}|${ref.referenceKind}|${r ? 'hit' : 'miss'}`;
  const slot = NM_PROFILE.get(key);
  if (slot) {
    slot.n++;
    slot.ns += dt;
  } else {
    NM_PROFILE.set(key, { n: 1, ns: dt });
  }
  return r;
}

export function nmTimed(stage: string, ref: UnresolvedRef, fn: () => ResolvedRef | null): ResolvedRef | null {
  return nmTimedT(stage, ref, fn);
}

/** Dump this thread's matchReference sub-stage table to stderr (no-op unless =2). */
export function dumpNameMatcherProfile(label: string): void {
  if (!NM_PROFILE || NM_PROFILE.size === 0) return;
  const rows = [...NM_PROFILE.entries()]
    .map(([k, v]) => ({ k, n: v.n, ms: Number(v.ns / 1_000_000n) }))
    .sort((a, b) => b.ms - a.ms);
  for (const r of rows) {
    console.error(
      `[resolve-profile] ${label} ${r.k}: n=${r.n} total=${(r.ms / 1000).toFixed(1)}s avg=${((r.ms * 1000) / Math.max(1, r.n)).toFixed(0)}µs`
    );
  }
}
