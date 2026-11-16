/** Portable text assets. Absolute paths, symlinks and arbitrary install commands are never accepted. */
export interface HomiePackFile { path: string; content: string }
export interface HomiePackResources { files: HomiePackFile[]; programs: string[] }
export const HOMIE_PACK_BYTES = 8 * 1024 * 1024;
export function parseHomiePackResources(value: unknown): HomiePackResources {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Homie pack resources.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== 'files' && key !== 'programs') || !Array.isArray(data.files) || !Array.isArray(data.programs)) {
    throw new TypeError('Expected pack files and Linux programs.');
  }
  const paths = new Set<string>();
  let bytes = 0;
  const files = data.files.map((raw): HomiePackFile => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid pack file.');
    const file = raw as Record<string, unknown>;
    if (Object.keys(file).some(key => key !== 'path' && key !== 'content') || typeof file.path !== 'string'
      || !/^(skills|scripts|resources)\/[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
      || file.path.length > 240 || typeof file.content !== 'string' || file.content.includes('\0')) throw new TypeError('Use a relative path under skills/, scripts/ or resources/.');
    if (paths.has(file.path.toLowerCase())) throw new TypeError('Duplicate pack file path.');
    paths.add(file.path.toLowerCase());
    bytes += new TextEncoder().encode(file.content).length;
    if (bytes > HOMIE_PACK_BYTES) throw new TypeError('Pack text assets exceed 8 MiB.');
    return { path: file.path, content: file.content };
  });
  const exactPaths = new Set(files.map(file => file.path));
  for (const file of files) {
    const ancestors = file.path.toLowerCase().split('/');
    for (let end = 1; end < ancestors.length; end++) {
      if (paths.has(ancestors.slice(0, end).join('/'))) throw new TypeError('Pack file conflicts with a directory.');
    }
    if (file.path.startsWith('skills/')) {
      const parts = file.path.split('/');
      if (parts.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(parts[1]!) || !exactPaths.has(`skills/${parts[1]}/SKILL.md`)) throw new TypeError('Each skill needs skills/<name>/SKILL.md.');
    }
  }
  const programs = data.programs.map(raw => {
    if (typeof raw !== 'string' || raw.length > 160 || !/^[a-z0-9][a-z0-9+.-]*(?:=[a-zA-Z0-9.+:~_-]+)?$/.test(raw)) {
      throw new TypeError('Use Debian package names, optionally name=version.');
    }
    return raw;
  });
  return { files, programs: [...new Set(programs)] };
}
