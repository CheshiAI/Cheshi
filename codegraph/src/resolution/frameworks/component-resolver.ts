import type { ResolutionContext } from '../types';

export function isPascalCaseName(value: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(value);
}

export function resolveComponentByName(
  name: string,
  fromFile: string,
  context: ResolutionContext,
): string | null {
  const components = context.getNodesByName(name).filter((node) => node.kind === 'component');
  if (components.length === 0) return null;

  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = components.filter((node) => node.filePath.startsWith(fromDir));
  if (sameDir.length > 0) return sameDir[0]!.id;

  return components.length === 1 ? components[0]!.id : null;
}
