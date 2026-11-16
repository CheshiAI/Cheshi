import type { DesktopUI } from '../scripts/renderer-session.mts';

/** Self-contained: this function is serialized into the selected Electron main process. */
export default async function editorMaximize(ui: DesktopUI) {
  const key = JSON.stringify(ui.key);
  // Register before collecting a snapshot so every later failure has a restoration path.
  ui.cleanup(`(async () => {
    const saved = globalThis[${key}];
    if (!saved) return;
    try {
      const restore = [...document.querySelectorAll('[data-editor-pane] button[aria-label="Restore pane size"]')]
        .find(button => !button.closest('[hidden]'));
      if (restore) restore.click();
      const deadline = Date.now() + 2000;
      while (!saved.geometryRestored() && Date.now() < deadline) await new Promise(r => setTimeout(r, 40));
      if (!saved.geometryRestored()) throw Error('Original pane layout was not restored');
      for (const pane of saved.panes) {
        if (!pane.node.isConnected || pane.view.state.doc.toString() !== pane.content) throw Error('Editor identity or document changed during review');
        pane.view.dispatch({selection:pane.selection});
        pane.view.scrollDOM.scrollTop = pane.scrollTop;
        pane.view.scrollDOM.scrollLeft = pane.scrollLeft;
      }
      saved.focus?.focus({preventScroll:true});
    } finally { delete globalThis[${key}]; }
  })()`);
  const initial = await ui.evaluate<{ ids: string[]; width: number; height: number }>(`(async () => {
    const visible = selector => [...document.querySelectorAll(selector)].filter(el => !el.closest('[hidden]') && el.getBoundingClientRect().width > 0);
    const panes = visible('[data-editor-pane]');
    if (panes.length < 2) throw Error('Open at least two split text editor panes before this scenario');
    if (visible('button[aria-label="Restore pane size"]').length) throw Error('Restore the workspace before this scenario');
    const {EditorView} = await import('/node_modules/.vite/deps/@codemirror_view.js');
    const outer = visible('[data-workspace-pane]');
    if (!outer.length) throw Error('Workspace pane hosts not found');
    const snapshot = elements => elements.map(el => ({
      selector: el.hasAttribute('data-editor-pane') ? '[data-editor-pane="'+el.dataset.editorPane+'"]' : '[data-workspace-pane="'+el.dataset.workspacePane+'"]',
      host:el.firstElementChild, rect:el.getBoundingClientRect().toJSON(),
    }));
    const geometry = snapshot([...outer, ...panes]);
    const geometryRestored = () => geometry.every(saved => {
      const el=document.querySelector(saved.selector);
      if (!el || el.closest('[hidden]') || el.firstElementChild !== saved.host) return false;
      const r=el.getBoundingClientRect();
      return ['x','y','width','height'].every(key => Math.abs(r[key]-saved.rect[key]) < 1);
    });
    const savedPanes = panes.map(el => {
      const node=el.querySelector('.cm-editor');
      if (!node) throw Error('Scenario requires text editors');
      const view=EditorView.findFromDOM(node);
      return {id:el.dataset.editorPane,node,view,content:view.state.doc.toString(),selection:view.state.selection,
        scrollTop:view.scrollDOM.scrollTop,scrollLeft:view.scrollDOM.scrollLeft};
    });
    globalThis[${key}] = {panes:savedPanes,geometryRestored,focus:document.activeElement};
    const rects=outer.map(el=>el.getBoundingClientRect());
    return {ids:savedPanes.map(p=>p.id),width:Math.max(...rects.map(r=>r.right))-Math.min(...rects.map(r=>r.left)),
      height:Math.max(...rects.map(r=>r.bottom))-Math.min(...rects.map(r=>r.top))};
  })()`);
  const checks: { pane: string; fullWorkspace: boolean; restored: boolean }[] = [];
  for (const id of initial.ids) {
    const selector = `[data-editor-pane=${JSON.stringify(id)}]`;
    await ui.click(`${selector} button[aria-label="Maximize pane"]`);
    await ui.waitFor(`(() => {
      const outer=[...document.querySelectorAll('[data-workspace-pane]')].filter(p=>!p.closest('[hidden]'));
      const panes=[...document.querySelectorAll('[data-editor-pane]')].filter(p=>!p.closest('[hidden]'));
      if(outer.length!==1 || outer[0].dataset.workspacePane!=='editor' || panes.length!==1 || panes[0].dataset.editorPane!==${JSON.stringify(id)}) return false;
      const r=panes[0].getBoundingClientRect();
      return Math.abs(r.width-${initial.width})<1 && Math.abs(r.height-${initial.height})<1;
    })()`);
    await ui.click(`${selector} button[aria-label="Restore pane size"]`);
    await ui.waitFor(`globalThis[${key}].geometryRestored()`);
    const preserved = await ui.evaluate<boolean>(`globalThis[${key}].panes.every(p=>p.node.isConnected &&
      p.view.state.doc.toString()===p.content && JSON.stringify(p.view.state.selection.toJSON())===JSON.stringify(p.selection))`);
    if (!preserved) throw new Error('Editor document or selection changed');
    checks.push({ pane: id, fullWorkspace: true, restored: true });
  }
  return { scenario: 'editor-maximize', workspaceWidth: initial.width, checks };
}
