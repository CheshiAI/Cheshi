import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { assertWorkRequest, workSnapshotText } from './work-contract.ts';
import { readWorkFile, WorkFiles, workDigest } from './work-files.ts';
import { sourceSpec, verificationSource, type VerificationSource } from './verification-source-contract.ts';

export function assertVerificationSource(source: VerificationSource): void {
  assertWorkRequest(sourceSpec(verificationSource(source)), workDigest);
}
export function captureVerificationSource(workspace: string, paths: string[]): VerificationSource {
  const files = paths.map(path => readWorkFile(workspace, path));
  const source = verificationSource({ files, hash: workDigest(workSnapshotText(files)) });
  if (files.some(file => readWorkFile(workspace, file.path).sha256 !== file.sha256)) throw new Error('Verification source changed while capturing. Retry with a new round.');
  return source;
}
export function verificationSourceDirectory(directory: string, requestId: string): string {
  if (!/^[a-f0-9]{64}$/.test(requestId)) throw new Error('Invalid verification source identity.');
  return join(realpathSync(directory), 'verification-sources', requestId);
}
export function verificationSourceFiles(directory: string, requestId: string, source: VerificationSource, existing: boolean): WorkFiles {
  assertVerificationSource(source);
  const target = verificationSourceDirectory(directory, requestId), parent = join(realpathSync(directory), 'verification-sources');
  if (!existing && !existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) throw new Error('Invalid verification source storage.');
  const files = new WorkFiles(parent, requestId, sourceSpec(source), existing);
  if (files.directory !== target || source.files.some(file => files.read(file.path).sha256 !== file.sha256)) throw new Error('Verification source changed. Request a new round.');
  return files;
}
