import { inferLocalReceiverType } from './name-match-receivers';
import { hasWebReceiverBinding } from './web-receiver-shadowing';
import type { ResolutionContext, UnresolvedRef } from './types';

/** A visible module singleton carries type evidence; its spelling alone does not. */
export function inferWebReceiverType(receiver: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const local = inferLocalReceiverType(receiver, ref, context);
  if (local || !/^[$\w]+$/.test(receiver)) return local;
  const values = context.getNodesByName(receiver).filter(node => node.filePath === ref.filePath
    && (node.kind === 'constant' || node.kind === 'variable'));
  if (values.length !== 1) return null;
  const value = values[0]!;
  const type = value.signature?.match(/^=\s*new\s+([$\w]+)\s*[<(]/)?.[1];
  if (!type) return null;

  // Ignore the module singleton itself, but reject a nearer lexical binding.
  if (hasWebReceiverBinding(receiver, ref, context, false)) return null;
  return type;
}
