import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkFiles, workDigest } from './work-files.ts';
import { assertCandidate, candidateSpec, type CandidateSnapshot } from './candidate-verification-contract.ts';

/** The immutable, per-verification input survives worker restarts. Models never receive write access. */
export function verificationCandidateFiles(directory: string, requestId: string, candidate: CandidateSnapshot, existing = true): WorkFiles {
  assertCandidate(candidate, workDigest);
  const root = join(directory, 'verification-candidates');
  if (!existing && !existsSync(root)) mkdirSync(root, { mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('Invalid verification candidate storage.');
  const files = new WorkFiles(root, requestId, candidateSpec(candidate), existing);
  if (candidate.files.some(file => files.read(file.path).sha256 !== file.sha256)) throw new Error('Verification candidate changed. Request a new round.');
  return files;
}
