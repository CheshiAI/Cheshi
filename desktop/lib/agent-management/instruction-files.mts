import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseInstructionFilePath } from '../../shared/agent-registry.ts';
import type { SpecialistProfile, SpecialistAssignment } from '../../shared/agent-registry.ts';

const MAX_FILE_BYTES = 256 * 1024;
function assertReadableFile(isFile: boolean, size: number): void {
  if (!isFile) throw new Error('Not a regular file.');
  if (size > MAX_FILE_BYTES) throw new Error('File exceeds 256 KiB.');
}
function decode(bytes: Uint8Array): string {
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (content.includes('\0')) throw new Error('File contains binary data.');
  return content;
}
export async function readInstructionFile(filename: string): Promise<{ path: string; content: string }> {
  parseInstructionFilePath(filename);
  if (!isAbsolute(filename)) throw new Error('An absolute instruction file path is required.');
  try {
    const path = await realpath(filename);
    // Nonblocking open allows us to reject special files without waiting on a pipe.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      assertReadableFile(info.isFile(), info.size);
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      assertReadableFile(true, length);
      return { path, content: decode(buffer.subarray(0, length)) };
    } finally { await file.close(); }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown read error.';
    throw new Error(`Cannot read instruction file "${filename}": ${reason}`);
  }
}

export function assertFileManagedInstructions(profile: Pick<SpecialistProfile, 'instructionFiles'>, assignment?: Pick<SpecialistAssignment, 'instructions' | 'instructionFiles'>): void {
  if (profile.instructionFiles?.length || assignment?.instructionFiles?.length || assignment?.instructions.trim()) {
    throw new Error('Legacy instruction overrides need migration to the Homie instructions.md and project AGENTS.md. Saved values are preserved; move them to files and clear the legacy settings before applying or starting.');
  }
}

export async function readProjectInstructions(workspace: string): Promise<string | null> {
  const root = await realpath(workspace), filename = join(root, 'AGENTS.md');
  let info;
  try { info = await lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink()) throw new Error('AGENTS.md must be a regular file inside the project, without symbolic links.');
  const file = await readInstructionFile(filename);
  if (file.path !== filename) throw new Error('AGENTS.md changed location while being read.');
  return file.content;
}

/** Read file sources before worker changes; legacy overrides never run invisibly. */
export async function resolveAgentInstructions(profile: SpecialistProfile, assignment: SpecialistAssignment, project?: string | null): Promise<string> {
  assertFileManagedInstructions(profile, assignment);
  const content = project === undefined ? await readProjectInstructions(assignment.workspaceRoot) : project;
  return content === null ? profile.instructions : `${profile.instructions}\n\nProject instructions (AGENTS.md):\n${content}`;
}
