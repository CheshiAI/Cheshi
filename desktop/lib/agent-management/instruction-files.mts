import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseInstructionFilePath } from '../../shared/agent-registry.ts';
import type { SpecialistProfile, SpecialistAssignment } from '../../shared/agent-registry.ts';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
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

/** Resolve a fresh snapshot before changing any running worker. Never rewrite the source files. */
export async function resolveAgentInstructions(profile: SpecialistProfile, assignment: SpecialistAssignment): Promise<string> {
  const seen = new Set<string>();
  let bytes = 0;
  const sections = [profile.instructions];
  const append = async (paths: string[] = []) => {
    for (const filename of paths) {
      const file = await readInstructionFile(filename);
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      bytes += Buffer.byteLength(file.content);
      if (bytes > MAX_TOTAL_BYTES) throw new Error('Linked instruction files exceed 1 MiB in total.');
      sections.push(`Instruction file: ${filename}\n${file.content}`);
    }
  };
  await append(profile.instructionFiles);
  sections.push(`Project instructions:\n${assignment.instructions}`);
  await append(assignment.instructionFiles);
  return sections.join('\n\n');
}
