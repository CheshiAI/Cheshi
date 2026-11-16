import { expect, test } from 'bun:test';
import { SceneGraph } from '@open-pencil/scene-graph';
import { exportFigFile, parseFigFile } from '@open-pencil/core/io/formats/fig';
import { canvasDimensionChanges } from '../frontend/src/features/canvas/integration/sdk/canvasProperties';

test('manual text dimensions and wrapping mode survive native file round trips', async () => {
  const graph = new SceneGraph();
  const node = graph.createNode('TEXT', graph.getPages()[0]!.id, {
    text: '체시 캔버스 검증', width: 100, height: 18, textAutoResize: 'WIDTH_AND_HEIGHT',
  });
  graph.updateNode(node.id, canvasDimensionChanges(node, 'width', 240));
  const bytes = await exportFigFile(graph);
  const reopened = await parseFigFile(new Uint8Array(bytes).buffer, { populate: 'all' });
  const text = [...reopened.getAllNodes()].find(value => value.type === 'TEXT');
  expect(text?.text).toBe('체시 캔버스 검증');
  expect(text?.width).toBe(240);
  expect(text?.textAutoResize).toBe('HEIGHT');
});

test('manual height fixes text dimensions and ordinary shapes retain their layout mode', () => {
  const graph = new SceneGraph();
  const page = graph.getPages()[0]!;
  const text = graph.createNode('TEXT', page.id, { width: 100, height: 18 });
  graph.updateNode(text.id, canvasDimensionChanges(text, 'height', 60));
  graph.updateNode(text.id, canvasDimensionChanges(text, 'width', 240));
  expect(text.textAutoResize).toBe('NONE');
  expect(text.height).toBe(60);
  expect(text.width).toBe(240);
  const rectangle = graph.createNode('RECTANGLE', page.id, { width: 100, height: 100 });
  expect(canvasDimensionChanges(rectangle, 'width', 240)).toEqual({ width: 240 });
});
