import { expect, test } from 'bun:test';
import { harness, styleSheet } from './showcase-page-theme-harness.ts';

test('themes white, black and tinted neutral page containers and keeps text readable', () => {
  const h = harness();
  const light = h.add('MAIN', 'rgb(255, 255, 255)');
  const heading = h.add('H1', undefined, light);
  const dark = h.add('DIV', 'rgb(0, 0, 0)');
  dark.style.color = 'rgb(255, 255, 255)';
  const neutral = h.add('HEADER', 'rgb(30, 32, 37)');
  h.install('#1E2025');
  expect([h.html, h.body, light, dark, neutral].every(element => element.background)).toBe(true);
  expect(heading.foreground).toBe('light');
  expect(dark.foreground).toBeUndefined();
  h.install('#FFFFFF');
  expect(heading.foreground).toBeUndefined();
  expect(dark.foreground).toBe('dark');
});

test('preserves control branches, artwork and colored content surfaces', () => {
  const h = harness();
  const button = h.add('BUTTON', 'rgb(255, 255, 255)');
  button.protected = true;
  const buttonIcon = h.add('DIV', 'rgb(0, 0, 0)', button);
  const artwork = h.add('SECTION', 'rgb(0, 0, 0)');
  artwork.style.backgroundImage = 'url(image.png)';
  const overlay = h.add('SPAN', undefined, artwork);
  const accent = h.add('ASIDE', 'rgb(20, 80, 160)');
  const translucent = h.add('DIV', 'rgba(0, 0, 0, 0.5)');
  h.install('#1E2025');
  for (const element of [button, buttonIcon, artwork, overlay, accent]) {
    expect(element.background).toBe(false);
  }
  for (const element of [button, artwork, accent]) {
    expect(element.foreground).toBe('original');
    expect(element.properties.get('--cheshi-page-original-color')).toBe('rgb(0, 0, 0)');
  }
  for (const element of [buttonIcon, overlay]) expect(element.foreground).toBeUndefined();
  expect(translucent.background).toBe(false);
  h.install(null);
  expect(h.elements.every(element => element.properties.size === 0)).toBe(true);
});

test('batches dynamic content updates and removes obsolete marks and listeners', () => {
  const h = harness();
  h.install('#1E2025');
  const banner = h.add('DIV', 'rgb(40, 40, 40)');
  h.mutate(); h.mutate();
  expect(h.timers.size).toBe(1);
  h.flush();
  expect(banner.background).toBe(true);
  banner.style.backgroundImage = 'url(new-artwork.png)';
  h.mutate(); h.flush();
  expect(banner.background).toBe(false);
  h.mutate();
  h.install(null);
  expect(h.timers.size).toBe(0);
  expect(h.listeners.size).toBe(0);
  expect(h.elements.every(element => !element.background && !element.foreground)).toBe(true);
  h.mutate();
  expect(h.timers.size).toBe(0);
});

test('applies the initial theme immediately and limits repeated mutations to one scan per interval', () => {
  const h = harness();
  h.install('#1E2025');
  expect(h.html.background).toBe(true);
  expect(h.styleReads).toBe(h.elements.length);
  expect(h.timers.size).toBe(0);
  const banner = h.add('DIV', 'rgb(40, 40, 40)');
  const initialReads = h.styleReads;
  for (let index = 0; index < 100; index += 1) h.mutate();
  h.advance(249);
  expect(h.styleReads).toBe(initialReads);
  expect(banner.background).toBe(false);
  h.mutate();
  h.advance(1);
  expect(banner.background).toBe(true);
  expect(h.styleReads).toBe(initialReads + h.elements.length);
  expect(h.timers.size).toBe(0);
  h.advance(1_000);
  expect(h.styleReads).toBe(initialReads + h.elements.length);
});

test('defers hidden page changes and applies the latest content after becoming visible', () => {
  const h = harness();
  h.install('#1E2025');
  const initialReads = h.styleReads;
  h.setHidden(true);
  const banner = h.add('DIV', 'rgb(40, 40, 40)');
  for (let index = 0; index < 100; index += 1) h.mutate();
  h.advance(1_000);
  expect(h.styleReads).toBe(initialReads);
  expect(banner.background).toBe(false);
  expect(h.timers.size).toBe(0);
  h.setHidden(false);
  h.advance(249);
  expect(banner.background).toBe(false);
  h.advance(1);
  expect(banner.background).toBe(true);
  expect(h.styleReads).toBe(initialReads + h.elements.length);
});

test('prepares the initial theme even while the native view is hidden behind its loader', () => {
  const h = harness();
  h.setHidden(true);
  h.install('#1E2025');
  expect(h.html.background).toBe(true);
  expect(h.body.background).toBe(true);
  expect(h.styleReads).toBe(h.elements.length);
  expect(h.timers.size).toBe(0);
});

test('does not run a pending scan after the page becomes hidden or the theme is removed', () => {
  const h = harness();
  h.install('#1E2025');
  const initialReads = h.styleReads;
  h.mutate();
  expect(h.timers.size).toBe(1);
  h.setHidden(true);
  h.advance(250);
  expect(h.styleReads).toBe(initialReads);
  h.setHidden(false);
  expect(h.timers.size).toBe(1);
  h.install(null);
  h.advance(250);
  expect(h.styleReads).toBe(initialReads);
  expect(h.timers.size).toBe(0);
  expect(h.listeners.size).toBe(0);
});

test('only reads the changed sibling group and coalesces overlapping dirty branches', () => {
  const h = harness();
  const section = h.add('SECTION');
  const group = h.add('DIV', undefined, section);
  const active = h.add('SPAN', undefined, group);
  const sibling = h.add('DIV', 'rgb(40, 40, 40)', group);
  const unrelated = h.add('SECTION', 'rgb(0, 0, 0)');
  h.add('SPAN', undefined, unrelated);
  h.install('#1E2025');
  const before = h.styleReads;
  // A class selector on the active element can alter its following sibling.
  sibling.style.backgroundColor = 'rgb(20, 80, 160)';
  h.mutate([{ type: 'attributes', target: active, attributeName: 'class' },
    { type: 'attributes', target: sibling, attributeName: 'class' }]);
  h.flush();
  expect(h.readElements.slice(before)).toEqual([group, active, sibling]);
  expect(sibling.background).toBe(false);
  expect(unrelated.background).toBe(true);
});

test('partial checks measure original ancestor text and avoid rewriting unchanged marks', () => {
  const h = harness();
  const section = h.add('SECTION');
  const group = h.add('DIV', undefined, section);
  const text = h.add('SPAN', undefined, group);
  h.install('#1E2025');
  expect(section.foreground).toBe('light');
  expect(text.foreground).toBe('light');
  const writes = [group.writes, text.writes];
  h.mutate([{ type: 'attributes', target: text, attributeName: 'class' }]);
  h.flush();
  expect(text.foreground).toBe('light');
  expect([group.writes, text.writes]).toEqual(writes);
  expect(h.html.hasAttribute('data-cheshi-page-measuring')).toBe(false);
});

test('updates inherited paint when an ancestor becomes a colored surface', () => {
  const h = harness();
  const section = h.add('SECTION');
  const group = h.add('DIV', undefined, section);
  const text = h.add('SPAN', undefined, group);
  h.install('#1E2025');
  expect(text.foreground).toBe('light');
  group.style.backgroundColor = 'rgb(20, 80, 160)';
  h.mutate([{ type: 'attributes', target: group, attributeName: 'class' }]);
  h.flush();
  expect(group.foreground).toBe('original');
  expect(text.foreground).toBeUndefined();
});

test('skips protected descendants on first paint and removes stale marks after moving into a control', () => {
  const h = harness();
  const section = h.add('SECTION');
  const text = h.add('SPAN', undefined, section);
  const button = h.add('BUTTON', undefined, section);
  const icon = h.add('SPAN', undefined, button);
  h.install('#1E2025');
  expect(h.readElements).not.toContain(icon);
  expect(text.foreground).toBe('light');
  button.append(text);
  h.mutate([{ type: 'childList', target: section, removedNodes: [text] },
    { type: 'childList', target: button, addedNodes: [text] }]);
  h.flush();
  expect(text.foreground).toBeUndefined();
  expect(text.background).toBe(false);
});

test('restores removed elements and themes them using their new parent when reinserted', () => {
  const h = harness();
  const section = h.add('SECTION');
  const artwork = h.add('SECTION', 'rgb(20, 80, 160)', section);
  artwork.properties.set('--cheshi-page-original-color', 'pink');
  artwork.priorities.set('--cheshi-page-original-color', 'important');
  h.install('#1E2025');
  expect(artwork.foreground).toBe('original');
  artwork.remove();
  h.mutate([{ type: 'childList', target: section, removedNodes: [artwork] }]);
  h.flush();
  expect(artwork.foreground).toBeUndefined();
  expect(artwork.properties.get('--cheshi-page-original-color')).toBe('pink');
  expect(artwork.priorities.get('--cheshi-page-original-color')).toBe('important');
  section.append(artwork);
  h.mutate([{ type: 'childList', target: section, addedNodes: [artwork] }]);
  h.flush();
  expect(artwork.foreground).toBe('original');
  h.install(null);
  expect(artwork.properties.get('--cheshi-page-original-color')).toBe('pink');
});

test('keeps moved protected descendants unthemed during subsequent nested mutations', () => {
  const h = harness();
  const section = h.add('SECTION');
  const group = h.add('DIV', undefined, section);
  const nested = h.add('DIV', undefined, group);
  const text = h.add('SPAN', undefined, nested);
  const button = h.add('BUTTON', undefined, section);
  h.install('#1E2025');
  expect(text.foreground).toBe('light');
  button.append(group);
  h.mutate([{ type: 'childList', target: section, removedNodes: [group] },
    { type: 'childList', target: button, addedNodes: [group] }]);
  h.flush();
  expect(text.foreground).toBeUndefined();
  h.mutate([{ type: 'attributes', target: text, attributeName: 'class' }]);
  h.flush();
  expect(text.foreground).toBeUndefined();
  expect(nested.background).toBe(false);
});

test('uses a full pass when relational selectors can change paint outside the dirty branch', () => {
  const h = harness();
  const group = h.add('SECTION');
  const text = h.add('SPAN', undefined, group);
  const sibling = h.add('SECTION', 'rgb(40, 40, 40)');
  h.document.styleSheets.push(styleSheet('body:has(.active) .sibling', { 'background-color': 'blue' }));
  h.install('#1E2025');
  const before = h.styleReads;
  sibling.style.backgroundColor = 'rgb(20, 80, 160)';
  h.mutate([{ type: 'attributes', target: text, attributeName: 'class' }]);
  h.flush();
  expect(h.readElements.slice(before)).toContain(sibling);
  expect(sibling.background).toBe(false);
});

test('uses a full pass when stylesheet rules cannot be inspected', () => {
  const h = harness();
  const group = h.add('SECTION');
  const text = h.add('SPAN', undefined, group);
  const sibling = h.add('SECTION');
  h.document.styleSheets.push({ get cssRules(): unknown[] { throw new Error('Cross-origin stylesheet'); } });
  h.install('#1E2025');
  const before = h.styleReads;
  h.mutate([{ type: 'attributes', target: text, attributeName: 'class' }]);
  h.flush();
  expect(h.readElements.slice(before)).toContain(sibling);
});

test('rechecks stylesheet dependencies when a style node is inserted inside page content', () => {
  const h = harness();
  const section = h.add('SECTION');
  const group = h.add('DIV', undefined, section);
  const sibling = h.add('SECTION', 'rgb(40, 40, 40)');
  h.install('#1E2025');
  const before = h.styleReads;
  const style = h.add('STYLE', undefined, group);
  h.document.styleSheets.push(styleSheet('body:has(.active) .sibling', { 'background-color': 'blue' }));
  sibling.style.backgroundColor = 'rgb(20, 80, 160)';
  h.mutate([{ type: 'childList', target: group, addedNodes: [style] }]);
  h.flush();
  expect(h.readElements.slice(before).includes(sibling)).toBe(true);
  expect(sibling.background).toBe(false);
});

test('unused relational utilities stay scoped until their candidate anchor enters the document', () => {
  const h = harness();
  const section = h.add('SECTION');
  const group = h.add('DIV', undefined, section);
  const text = h.add('SPAN', undefined, group);
  const unrelated = h.add('SECTION');
  h.document.styleSheets.push(styleSheet('.unused:has(.active)', { color: 'red' }));
  h.install('#1E2025');
  let before = h.styleReads;
  h.mutate([{ type: 'attributes', target: text, attributeName: 'class' }]);
  h.flush();
  expect(h.readElements.slice(before).includes(unrelated)).toBe(false);
  const anchor = h.add('DIV', undefined, group);
  anchor.setAttribute('class', 'unused');
  before = h.styleReads;
  h.mutate([{ type: 'childList', target: group, addedNodes: [anchor] }]);
  h.flush();
  expect(h.readElements.slice(before).includes(unrelated)).toBe(true);
  anchor.remove();
  before = h.styleReads;
  h.mutate([{ type: 'childList', target: group, removedNodes: [anchor] }]);
  h.flush();
  expect(h.readElements.slice(before).includes(unrelated)).toBe(false);
});

test('ignores pseudo-element-only paint while retaining actual element selectors in the same list', () => {
  const h = harness();
  const group = h.add('SECTION');
  const text = h.add('SPAN', undefined, group);
  const unrelated = h.add('SECTION');
  h.document.styleSheets.push(styleSheet('body:has(:is(.active, .ready))::before, body:has(.active)::after', {
    'background-color': 'blue',
  }));
  h.install('#1E2025');
  let before = h.styleReads;
  h.mutate([{ type: 'attributes', target: text, attributeName: 'class' }]);
  h.flush();
  // The conservative parent scope is BODY here; use the root to distinguish full passes.
  expect(h.readElements.slice(before).includes(h.html)).toBe(false);
  h.document.styleSheets.push(styleSheet('body:has(.active)::before, body:has(.active) section', { color: 'red' }));
  h.listeners.get('load')?.();
  h.flush();
  before = h.styleReads;
  h.mutate([{ type: 'attributes', target: text, attributeName: 'class' }]);
  h.flush();
  expect(h.readElements.slice(before).includes(h.html)).toBe(true);
  expect(h.readElements.slice(before).includes(unrelated)).toBe(true);
});

test('defers stylesheet dependency analysis until the first partial update', () => {
  const h = harness();
  const group = h.add('SECTION');
  const leaf = h.add('SPAN', undefined, group);
  const sheet = styleSheet('aside:has(.active)', { color: 'red' });
  const rules = sheet.cssRules;
  let stylesheetReads = 0;
  Object.defineProperty(sheet, 'cssRules', { get: () => { stylesheetReads += 1; return rules; } });
  h.document.styleSheets.push(sheet);
  h.install('#1E2025');
  expect(stylesheetReads).toBe(0);
  expect(h.html.background).toBe(true);
  h.mutate([{ type: 'attributes', target: leaf, attributeName: 'class' }]);
  h.flush();
  expect(stylesheetReads).toBe(1);
});
