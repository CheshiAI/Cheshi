import { workPath } from './work-contract.ts';

export const APPLICATION_STATES = ['applying', 'applied', 'interrupted', 'conflict', 'aborted'] as const;
export interface ApplicationReceipt {
  id: string; candidateId: string; hash: string; verificationId: string;
  lockReleased?: true;
  status: typeof APPLICATION_STATES[number]; updatedAt: string;
  files: { path: string; before: string | null; after: string | null; phase: 'pending' | 'writing' | 'written'; observed?: 'before' | 'after' | 'changed' | 'unavailable' }[];
}
export function parseApplication(value: unknown): ApplicationReceipt {
  if (!value || typeof value !== 'object') throw new Error('Invalid application receipt.');
  const v = value as Record<string, unknown>;
  const hash = (item: unknown): string => {
    if (typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)) throw new Error('Invalid application identity.');
    return item;
  };
  if (!APPLICATION_STATES.some(s => s === v.status) || typeof v.updatedAt !== 'string' || !Number.isFinite(Date.parse(v.updatedAt))
    || !Array.isArray(v.files) || v.files.length > 32) throw new Error('Invalid application state.');
  if (v.lockReleased !== undefined && (v.lockReleased !== true || !['applied', 'aborted'].includes(String(v.status)))) throw new Error('Invalid lock release receipt.');
  const files = v.files.map(raw => {
    const f = raw as Record<string, unknown>;
    if (!f || !['pending', 'writing', 'written'].includes(String(f.phase))
      || (f.observed !== undefined && !['before', 'after', 'changed', 'unavailable'].includes(String(f.observed)))) throw new Error('Invalid application file state.');
    const before = f.before === null ? null : hash(f.before), after = f.after === null ? null : hash(f.after);
    if (before === after) throw new Error('Application file must contain a change.');
    return { path: workPath(f.path), before, after, phase: f.phase as ApplicationReceipt['files'][number]['phase'],
      ...(f.observed === undefined ? {} : { observed: f.observed as ApplicationReceipt['files'][number]['observed'] }) };
  });
  if (new Set(files.map(f => f.path)).size !== files.length || (v.status === 'applied' && files.some(f => f.phase !== 'written'))) throw new Error('Inconsistent application receipt.');
  return { ...(v.lockReleased === true ? { lockReleased: true as const } : {}), id: hash(v.id), candidateId: hash(v.candidateId), hash: hash(v.hash), verificationId: hash(v.verificationId),
    status: v.status as ApplicationReceipt['status'], updatedAt: v.updatedAt, files };
}
