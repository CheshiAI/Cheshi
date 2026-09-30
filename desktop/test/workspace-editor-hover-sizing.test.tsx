import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { fitWorkspaceEditorHover } from '../frontend/src/features/editor/workspaceEditorHoverSizing';

async function withHover(run: (fixture: {
  host: HTMLElement;
  content: HTMLElement;
  layout: { availableWidth: number; lineWidths: number[] };
}) => void) {
  const window = new Window();
  const document = window.document as unknown as Document;
  document.body.innerHTML = '<div class="cm-tooltip-hover" style="border: 1px solid">'
    + '<div class="cm-tooltip-section workspace-editor-symbol-hover" style="padding: 6px 10px">'
    + '<pre>module "/long/path/to/the/module"</pre></div></div>';
  const host = document.querySelector<HTMLElement>('.cm-tooltip-hover')!;
  const content = host.firstElementChild as HTMLElement;
  const layout = { availableWidth: 720, lineWidths: [597.7, 590] };
  Object.defineProperty(host, 'getBoundingClientRect', {
    value: () => new window.DOMRect(20, 20, layout.availableWidth, 50),
  });
  Object.defineProperty(window.Range.prototype, 'getClientRects', {
    value: () => layout.lineWidths.map((width, index) => new window.DOMRect(31, 29 + index * 18, width, 14)),
  });
  try {
    run({ host, content, layout });
  } finally {
    await window.happyDOM.close();
  }
}

test('hover background fits the longest wrapped line and retains padding and full content', async () => {
  await withHover(({ host, content }) => {
    const text = content.textContent;
    fitWorkspaceEditorHover(content);
    expect(host.style.width).toBe('620px');
    expect(content.textContent).toBe(text);
  });
});

test('hover sizing follows a narrower viewport and grows again when space returns', async () => {
  await withHover(({ host, content, layout }) => {
    fitWorkspaceEditorHover(content);
    layout.availableWidth = 332;
    layout.lineWidths = [309.7, 220];
    fitWorkspaceEditorHover(content);
    expect(host.style.width).toBe('332px');
    layout.availableWidth = 720;
    layout.lineWidths = [597.7, 590];
    fitWorkspaceEditorHover(content);
    expect(host.style.width).toBe('620px');
  });
});

test('unmeasurable or unrelated hover sections retain their existing width', async () => {
  await withHover(({ host, content, layout }) => {
    host.style.width = '400px';
    layout.lineWidths = [];
    fitWorkspaceEditorHover(content);
    expect(host.style.width).toBe('400px');
    layout.lineWidths = [200];
    const diagnostic = host.ownerDocument.createElement('div');
    diagnostic.className = 'cm-tooltip-section';
    host.append(diagnostic);
    fitWorkspaceEditorHover(content);
    expect(host.style.width).toBe('400px');
  });
});
