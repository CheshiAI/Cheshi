export type SplitPreviewDirection = 'right' | 'down';

export function splitPreviewSizeIssue(
  bounds: { width: number; height: number },
  direction: SplitPreviewDirection,
  minimumTargetWidth = 560,
): string | null {
  const width = direction === 'right' ? minimumTargetWidth : 280;
  const height = direction === 'right' ? 240 : 400;
  if (bounds.width >= width && bounds.height >= height) return null;
  return `Split pane ${direction} requires an area at least ${width}px wide and ${height}px high.`;
}
