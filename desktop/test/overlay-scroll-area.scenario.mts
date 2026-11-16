import type { DesktopUI } from '../../.agents/skills/desktop-ui-check/scripts/renderer-session.mts';

/** Run with the desktop-ui-check runner against a visible, overflowing Explorer. */
export default async function overlayScrollArea(ui: DesktopUI) {
  const key = JSON.stringify(ui.key);
  ui.cleanup(`(() => {
    const saved = globalThis[${key}];
    if (!saved) return;
    try {
      saved.root.scrollTop = 0;
      saved.viewport.scrollTop = saved.scrollTop;
      saved.scrollbar.scrollTop = saved.viewport.scrollTop;
      for (const entry of saved.ancestors) {
        entry.node.scrollTop = entry.top;
        entry.node.scrollLeft = entry.left;
      }
      saved.focus?.focus({preventScroll:true});
    } finally { delete globalThis[${key}]; }
  })()`);
  await ui.evaluate(`(() => {
    const tab = document.querySelector('[role="tab"][id$="-tab-files"]');
    if (tab?.getAttribute('aria-selected') !== 'true') throw Error('Select the Explorer tab before checking scrolling');
    const viewport = document.querySelector('[aria-label="Workspace projects"]');
    if (!viewport || viewport.getBoundingClientRect().height <= 0 || viewport.closest('[hidden]')) {
      throw Error('Open Explorer before checking scrolling');
    }
    if (viewport.scrollHeight <= viewport.clientHeight) throw Error('Explorer must have overflowing content');
    const root = viewport.parentElement;
    const scrollbar = viewport.nextElementSibling;
    const projects = [...viewport.querySelectorAll('section[aria-label]')];
    if (projects.length < 2 || scrollbar?.getAttribute('aria-hidden') !== 'true') {
      throw Error('Expected multiple projects and an overlay scrollbar');
    }
    const ancestors = [];
    for (let node = root.parentElement; node; node = node.parentElement) {
      ancestors.push({node,top:node.scrollTop,left:node.scrollLeft});
    }
    const saved = {viewport,root,scrollbar,projects,ancestors,focus:document.activeElement,
      scrollTop:viewport.scrollTop + root.scrollTop};
    saved.measure = () => {
      const outer = root.getBoundingClientRect(), inner = viewport.getBoundingClientRect();
      if (root.scrollTop !== 0 || Math.abs(outer.top - inner.top) > 1 || Math.abs(outer.bottom - inner.bottom) > 1) {
        throw Error('Outer wrapper scrolled or left a blank strip below Explorer');
      }
      const moved = ancestors.find(entry => entry.node.scrollTop !== entry.top || entry.node.scrollLeft !== entry.left);
      if (moved) {
        throw Error('Scrolling Explorer moved an ancestor: ' + JSON.stringify({className:moved.node.className,
          before:moved.top,after:moved.node.scrollTop,leftBefore:moved.left,leftAfter:moved.node.scrollLeft}));
      }
      return {outerScrollTop:root.scrollTop,viewportScrollTop:viewport.scrollTop,
        bottomGap:outer.bottom-inner.bottom,height:inner.height};
    };
    globalThis[${key}] = saved;
    root.scrollTop = 185;
    saved.measure();
  })()`);
  const positions = [];
  for (const index of [0, -1, 0, -1]) {
    positions.push(await ui.evaluate(`(() => {
      const saved = globalThis[${key}];
      const target = saved.projects.at(${index}).querySelector('button');
      target.scrollIntoView({block:'center'});
      target.focus();
      return saved.measure();
    })()`));
  }
  await ui.waitFor(`(() => {
    const saved = globalThis[${key}];
    return saved.scrollbar.scrollTop === saved.viewport.scrollTop;
  })()`);
  const wheel = await ui.evaluate<{ x: number; y: number; before: number }>(`(() => {
    const saved = globalThis[${key}], rect = saved.viewport.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,before:saved.viewport.scrollTop};
  })()`);
  await ui.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheel.x, y: wheel.y, deltaX: 0, deltaY: -160 });
  await ui.waitFor(`(() => {
    const saved = globalThis[${key}];
    return saved.viewport.scrollTop < ${wheel.before} && saved.scrollbar.scrollTop === saved.viewport.scrollTop;
  })()`);
  const afterWheel = await ui.evaluate(`globalThis[${key}].measure()`);
  return { scenario: 'overlay-scroll-area', positions, afterWheel, wheelAndScrollbarSynchronized: true };
}
