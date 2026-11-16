import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import { WorkspaceLayoutControls } from '../frontend/src/features/shell/WorkspaceLayoutControls';
import type { SplitLayoutNode } from '../frontend/src/shared/ui/splitPaneModel';
import '../frontend/src/shared/styles/tokens.css';
import '../frontend/src/shared/styles/controls.tokens.css';

declare global {
  interface Window { paneCanvasFixture: { loads: number } }
}
window.paneCanvasFixture = { loads: 0 };
const primary: SplitLayoutNode = { type: 'pane', paneId: 'primary' };
const editor: SplitLayoutNode = { type: 'pane', paneId: 'editor' };
const split: SplitLayoutNode = { type: 'split', id: 'canvas-editor', axis: 'columns', ratio: .6, first: primary, second: editor };
const layouts: Record<string, SplitLayoutNode> = {
  canvas: primary,
  explorer: editor,
  split,
  swapped: { ...split, first: editor, second: primary },
  nested: { type: 'split', id: 'nested', axis: 'rows', ratio: .6, first: split, second: { type: 'pane', paneId: 'terminal' } },
};

function Fixture() {
  const [layout, setLayout] = useState<SplitLayoutNode>(primary);
  const [mounted, setMounted] = useState(true);
  const entry = new URLSearchParams(location.search).get('editor')!;
  return <>
    <nav>{Object.entries(layouts).map(([name, value]) =>
      <button key={name} data-layout={name} onClick={() => setLayout(value)}>{name}</button>)}
      <button data-unmount onClick={() => setMounted(false)}>Unmount</button>
    </nav>
    {mounted && <WorkspaceEditorSplit mode="primary" layout={layout} onLayoutChange={setLayout}
      editor={<section data-editor><WorkspaceLayoutControls /><textarea defaultValue="Explorer draft" /></section>}
      terminal={<p>Terminal fixture</p>}>
      <div data-canvas-controls><WorkspaceLayoutControls /></div>
      <iframe title="Retained Canvas" src={entry} style={{ flex: 1, minHeight: 0, width: '100%', border: 0 }}
        onLoad={() => { window.paneCanvasFixture.loads++; }} />
    </WorkspaceEditorSplit>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
