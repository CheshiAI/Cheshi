import type { VerificationScenario } from '../scripts/verification.mts';

/** Copy and adapt all five parts together. This example opens Saved turns and presses Escape. */
export default {
  name: 'saved-turns-escape',
  requiredChecks: ['panel opened', 'Escape closed panel', 'focus returned to opener'],
  precondition: `document.querySelector('.app-layout')?.dataset.activeView === 'chat'
    && document.querySelector('button[aria-label="Saved turns"]')?.getAttribute('aria-expanded') === 'false'
    && !document.querySelector('button[aria-label="Saved turns"]')?.closest('[hidden], [inert]')
    && document.querySelector('button[aria-label="Saved turns"]')?.getBoundingClientRect().width > 0
    && !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')`,
  snapshot: `({
    focus: document.activeElement,
    drafts: [...document.querySelectorAll('textarea')].map(node => ({node, value: node.value})),
    scrolls: [...document.querySelectorAll('*')].filter(node =>
      node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth
    ).map(node => ({node, top: node.scrollTop, left: node.scrollLeft}))
  })`,
  restore: `(async () => {
    const opener = document.querySelector('button[aria-label="Saved turns"]');
    if (opener?.getAttribute('aria-expanded') === 'true') opener.click();
    const deadline = Date.now() + 1500;
    while (opener?.getAttribute('aria-expanded') === 'true' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (snapshot.focus === document.body) document.activeElement?.blur();
    else if (snapshot.focus?.isConnected) snapshot.focus.focus({preventScroll: true});
    for (const item of snapshot.scrolls) {
      if (item.node.isConnected) { item.node.scrollTop = item.top; item.node.scrollLeft = item.left; }
    }
  })()`,
  restored: `document.querySelector('button[aria-label="Saved turns"]')?.getAttribute('aria-expanded') === 'false'
    && document.activeElement === snapshot.focus
    && snapshot.drafts.every(item => item.node.isConnected && item.node.value === item.value)
    && snapshot.scrolls.every(item => item.node.isConnected
      && Math.abs(item.node.scrollTop - item.top) < 1 && Math.abs(item.node.scrollLeft - item.left) < 1)`,
  run: async function verify(ui) {
    await ui.click('button[aria-label="Saved turns"]');
    await ui.waitFor(`document.querySelector('button[aria-label="Saved turns"]')?.getAttribute('aria-expanded') === 'true'`);
    await ui.check('panel opened', `document.querySelector('button[aria-label="Saved turns"]')?.getAttribute('aria-expanded') === 'true'`);
    await ui.key('Escape');
    await ui.waitFor(`document.querySelector('button[aria-label="Saved turns"]')?.getAttribute('aria-expanded') === 'false'`);
    await ui.check('Escape closed panel', `document.querySelector('button[aria-label="Saved turns"]')?.getAttribute('aria-expanded') === 'false'`);
    await ui.check('focus returned to opener', `document.activeElement === document.querySelector('button[aria-label="Saved turns"]')`);
  },
} satisfies VerificationScenario;
