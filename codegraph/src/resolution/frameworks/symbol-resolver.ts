import type { ResolutionContext } from '../types';

export function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  const kindFiltered = candidates.filter((node) => kinds.has(node.kind));
  if (kindFiltered.length === 0) return null;

  const preferred = kindFiltered.filter((node) =>
    preferredDirPatterns.some((directory) => node.filePath.includes(directory))
  );
  return preferred[0]?.id ?? kindFiltered[0]!.id;
}
