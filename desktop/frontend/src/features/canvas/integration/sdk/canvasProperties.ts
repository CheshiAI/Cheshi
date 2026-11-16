import type { SceneNode } from '@open-pencil/scene-graph';

const canvasDimensions = ['x', 'y', 'width', 'height', 'rotation', 'cornerRadius'] as const;

/** A manually sized text box must not snap back to its content's natural width. */
export function canvasDimensionChanges(node: SceneNode, field: typeof canvasDimensions[number], value: number): Partial<SceneNode> {
  const changes: Partial<SceneNode> = { [field]: value };
  if (node.type === 'TEXT' && field === 'height') changes.textAutoResize = 'NONE';
  if (node.type === 'TEXT' && field === 'width') {
    changes.textAutoResize = node.textAutoResize === 'NONE' ? 'NONE' : 'HEIGHT';
  }
  return changes;
}
