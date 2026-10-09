import { parseWorkRequest, type WorkFile, type WorkRequest } from './work-contract.ts';

/** Explicit source bytes captured by the owner, independent of the reviewer's project checkout. */
export interface VerificationSource { files: WorkFile[]; hash: string }
export function sourceSpec(source: VerificationSource): WorkRequest {
  return parseWorkRequest({ version: 1, objective: 'Review the requested source snapshot', criteria: ['Verify the requested artifacts'],
    files: source.files, snapshot: source.hash, writePaths: [source.files[0]?.path], previousRequestId: null });
}
export function verificationSource(value: unknown): VerificationSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid verification source.');
  const raw = value as VerificationSource;
  const spec = sourceSpec(raw);
  if (spec.files.length > 16 || spec.files.some(file => file.content !== null && new TextEncoder().encode(file.content).byteLength > 65_536)) {
    throw new Error('Verification supports 1-16 source files up to 64 KiB each.');
  }
  return { files: spec.files, hash: spec.snapshot };
}
