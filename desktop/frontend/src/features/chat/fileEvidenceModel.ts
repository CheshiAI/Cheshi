export interface FileEvidenceEntry {
  file: string;
  sha256: string;
  path?: string;
}

function isFilePath(value: string): boolean {
  return /^(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.[\p{L}\p{N}_-]+$/u.test(value)
    && !value.split('/').some(part => part === '.' || part === '..');
}

/** Recognize only complete file/hash pairs; never interpret arbitrary code as evidence. */
export function fileEvidence(value: string, language: string | undefined, context: string): FileEvidenceEntry[] | null {
  if (language && !['text', 'plaintext'].includes(language)) return null;
  const lines = value.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length % 2 !== 0) return null;
  const files: FileEvidenceEntry[] = [];
  // Only standalone path tokens from the associated request can resolve a basename.
  const paths = [...new Set(context.split(/[\s`<>()[\]"',;]+/).filter(isFilePath))];
  for (let index = 0; index < lines.length; index += 2) {
    const file = lines[index]!, sha256 = lines[index + 1]!;
    if (!isFilePath(file) || !/^[a-f\d]{64}$/i.test(sha256)) return null;
    const matches = paths.filter(path => path === file || (!file.includes('/') && path.split('/').at(-1) === file));
    files.push({ file, sha256, ...(matches.length === 1 ? { path: matches[0] } : {}) });
  }
  return files;
}
