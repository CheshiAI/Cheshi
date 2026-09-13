import type { Edge } from '../types';
import type { MaybeYield } from './cooperative-yield';
import type { ResolutionContext } from './types';

/**
 * Delphi form code-behind: a form unit `UFRMAbout.pas` owns its visual form
 * definition `UFRMAbout.dfm` (VCL) / `.fmx` (FireMonkey) — paired by basename in
 * the same directory, wired by the `{$R *.dfm}` directive rather than a `uses`
 * clause. Link the unit → its form so a `.dfm`/`.fmx` used only as a form
 * definition isn't orphaned, and editing the form surfaces its code-behind unit.
 */
export async function pascalFormEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  let scannedFiles = 0;
  const edges: Edge[] = [];
  const allFiles = new Set(ctx.getAllFiles());
  for (const file of allFiles) {
    if ((++scannedFiles & 255) === 0) await onYield();
    if (!/\.(dfm|fmx)$/i.test(file)) continue;
    const pasFile = file.replace(/\.(dfm|fmx)$/i, '.pas');
    if (!allFiles.has(pasFile)) continue;
    const formNode = ctx.getNodesInFile(file).find((n) => n.kind === 'file');
    const unitNode = ctx.getNodesInFile(pasFile).find((n) => n.kind === 'file');
    if (!formNode || !unitNode) continue;
    edges.push({
      source: unitNode.id,
      target: formNode.id,
      kind: 'references',
      line: unitNode.startLine,
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'pascal-form', registeredAt: pasFile },
    });
  }
  return edges;
}
