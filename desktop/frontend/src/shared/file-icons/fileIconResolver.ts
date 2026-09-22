import fileIconRules from './fileIconRules.json';

export interface ResolvedFileIcon {
  icon: string;
}

// Preserve upstream priority order, case-insensitive full matches, and path rules.
const rules = fileIconRules.map(([pattern = '', icon = '']) => ({
  pattern: new RegExp(`^(?:${pattern})$`, 'i'),
  usesPath: pattern.includes('/'),
  icon,
}));
const cache = new Map<string, ResolvedFileIcon | null>();
const cacheLimit = 4096;

export function resolveFileIcon(path: string, name: string): ResolvedFileIcon | null {
  // Keep these extensions recognizable even when upstream has a tool-specific icon.
  if (/\.(?:mts|cts|jts)$/i.test(name)) return { icon: 'typeScript' };

  const normalizedPath = path.replaceAll('\\', '/');
  const key = `${normalizedPath}\0${name}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const rule = rules.find(({ pattern, usesPath }) => pattern.test(usesPath ? normalizedPath : name));
  const resolved = rule ? { icon: rule.icon } : null;
  if (cache.size >= cacheLimit) cache.clear();
  cache.set(key, resolved);
  return resolved;
}
