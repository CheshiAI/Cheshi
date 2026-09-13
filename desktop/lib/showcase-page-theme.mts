/** Serialized into an isolated world; keep every browser dependency inside this function. */
function installPageTheme(background: string | null) {
  const state = globalThis as typeof globalThis & { __cheshiPageTheme?: () => void };
  state.__cheshiPageTheme?.();
  if (!background || location.protocol !== 'https:') return;
  const backgroundAttribute = 'data-cheshi-page-background';
  const foregroundAttribute = 'data-cheshi-page-foreground';
  const measuringAttribute = 'data-cheshi-page-measuring';
  const originalColorProperty = '--cheshi-page-original-color';
  type Paint = { color: number[] | null; themed: boolean; protected: boolean };
  type Mark = { original?: { value: string; priority: string } };
  type Change = { element: Element; background: boolean; foreground: string | null; originalColor: string };
  const marked = new Map<Element, Mark>();
  const painted = new WeakMap<Element, Paint>();
  const pending = new Set<Element>();
  const removed = new Set<Element>();
  const surfaces = new Set(['HTML', 'BODY', 'DIV', 'MAIN', 'HEADER', 'FOOTER', 'SECTION', 'NAV', 'ASIDE', 'ARTICLE']);
  const protectedContent = 'button, input, textarea, select, option, pre, code, svg, canvas, video, img, iframe, '
    + '[contenteditable]:not([contenteditable="false"]), [role="button"], [role="switch"], [role="textbox"]';
  const canvas = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16));
  let timer = 0;
  let fullScan = true;
  let stylesChanged = true;
  let globalSelectors: string[] | null = [];

  function rgb(value: string): number[] | null {
    const match = value.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
    if (!match || (match[4] !== undefined && Number(match[4]) !== 1)) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  function luminance(channels: number[]): number {
    return channels.reduce((sum, channel, index) => {
      const value = channel / 255;
      const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
    }, 0);
  }
  const canvasLuminance = luminance(canvas);

  // Relational selectors can change an ancestor outside a mutation's subtree.
  // Unreadable sheets are conservative too; never guess their dependency scope.
  function collectGlobalSelectors(): string[] | null {
    const selectors = new Set<string>();
    // Split selector lists without breaking functional pseudos or attribute values.
    function splitSelectors(value: string): string[] {
      const result: string[] = [];
      let start = 0, depth = 0, quote = '';
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index]!;
        if (character === '\\') { index += 1; continue; }
        if (quote) { if (character === quote) quote = ''; continue; }
        if (character === '"' || character === "'") { quote = character; continue; }
        if (character === '(' || character === '[') depth += 1;
        else if (character === ')' || character === ']') depth -= 1;
        else if (character === ',' && depth === 0) { result.push(value.slice(start, index)); start = index + 1; }
      }
      result.push(value.slice(start));
      return result;
    }
    function collect(selector: string): boolean {
      for (const part of splitSelectors(selector)) {
        if (!part.includes(':has(') || /::?(?:before|after)\s*$/.test(part)) continue;
        // The prefix is a conservative candidate anchor, even when :has stops
        // matching after a removal. Complex/nested selectors fall back globally.
        const prefix = part.slice(0, part.indexOf(':has(')).trim();
        if (!prefix) return true;
        try { document.documentElement.matches(prefix); } catch { return true; }
        selectors.add(prefix);
        if (part.slice(part.indexOf(':has(') + 5).includes(':has(')) return true;
      }
      return false;
    }
    const visited = new Set<CSSStyleSheet>();
    function sheet(value: CSSStyleSheet): boolean {
      if (visited.has(value)) return false;
      visited.add(value);
      return rules(value.cssRules);
    }
    function rules(values: CSSRuleList, relational = false): boolean {
      for (const rule of Array.from(values)) {
        const selector = 'selectorText' in rule ? String(rule.selectorText) : '';
        const dependsOnDescendants = relational || selector.includes(':has(');
        if (dependsOnDescendants && 'style' in rule) {
          const style = rule.style as CSSStyleDeclaration;
          for (const property of Array.from(style)) {
            if (property.startsWith('--') || /^(all|color|background(?:-.+)?)$/.test(property)) {
              if (relational || collect(selector)) return true;
              break;
            }
          }
        }
        if ('cssRules' in rule && rules(rule.cssRules as CSSRuleList, dependsOnDescendants)) return true;
        if ('styleSheet' in rule && rule.styleSheet && sheet(rule.styleSheet as CSSStyleSheet)) return true;
      }
      return false;
    }
    try {
      return [...Array.from(document.styleSheets), ...document.adoptedStyleSheets].some(sheet) ? null : [...selectors];
    } catch { return null; }
  }

  function restoreColor(element: Element, mark: Mark) {
    if (!mark.original || !(element instanceof HTMLElement)) return;
    if (mark.original.value) element.style.setProperty(originalColorProperty, mark.original.value, mark.original.priority);
    else element.style.removeProperty(originalColorProperty);
    delete mark.original;
  }
  function removeMark(element: Element, mark: Mark) {
    if (element.hasAttribute(backgroundAttribute)) element.removeAttribute(backgroundAttribute);
    if (element.hasAttribute(foregroundAttribute)) element.removeAttribute(foregroundAttribute);
    restoreColor(element, mark);
    marked.delete(element);
  }
  function clearBranch(root: Element, includeRoot = true) {
    if (!marked.size) return;
    if (includeRoot) {
      const mark = marked.get(root);
      if (mark) removeMark(root, mark);
    }
    for (const element of root.querySelectorAll(`[${backgroundAttribute}], [${foregroundAttribute}]`)) {
      const mark = marked.get(element);
      if (mark) removeMark(element, mark);
    }
  }
  function setMark(element: Element, name: string, value: string | null) {
    if (value === null) {
      if (element.hasAttribute(name)) element.removeAttribute(name);
    } else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }
  function apply(change: Change) {
    const { element, foreground } = change;
    const mark = marked.get(element) ?? {};
    setMark(element, backgroundAttribute, change.background ? '' : null);
    if (foreground === 'original' && element instanceof HTMLElement) {
      const style = element.style;
      mark.original ??= { value: style.getPropertyValue(originalColorProperty), priority: style.getPropertyPriority(originalColorProperty) };
      if (style.getPropertyValue(originalColorProperty) !== change.originalColor) {
        style.setProperty(originalColorProperty, change.originalColor);
      }
    } else restoreColor(element, mark);
    setMark(element, foregroundAttribute, foreground);
    if (change.background || foreground) marked.set(element, mark);
    else marked.delete(element);
  }

  function readBranch(root: Element, changes: Change[]) {
    const stack = [root];
    while (stack.length) {
      const element = stack.pop()!;
      if (element.tagName === 'HEAD') continue;
      const inherited = element.parentElement && painted.get(element.parentElement);
      // Controls and SVG internals already inherit their protected root's original
      // color. Reading every icon path or editor child cannot add a themed surface.
      if (inherited?.protected) { clearBranch(element); continue; }
      const style = getComputedStyle(element);
      const original = rgb(style.backgroundColor);
      const protectedElement = element.matches(protectedContent);
      const artwork = style.backgroundImage !== 'none';
      const pageRoot = element === document.documentElement || element === document.body;
      const neutral = original !== null && Math.max(...original) - Math.min(...original) <= 24;
      const themed = !protectedElement && !artwork && surfaces.has(element.tagName) && (pageRoot || neutral);
      let paint: Paint = inherited || { color: canvas, themed: true, protected: false };
      if (protectedElement) paint = { color: null, themed: false, protected: true };
      else if (artwork) paint = { color: null, themed: false, protected: false };
      else if (themed) paint = { color: canvas, themed: true, protected: false };
      else if (original) paint = { color: original, themed: false, protected: false };
      painted.set(element, paint);
      let foreground: string | null = null;
      const text = rgb(style.color);
      if (paint.themed && paint.color && text) {
        const a = luminance(text);
        const b = canvasLuminance;
        if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 4.5) foreground = b > 0.179 ? 'dark' : 'light';
      } else if (inherited?.themed && !paint.themed && text && element instanceof HTMLElement) foreground = 'original';
      changes.push({ element, background: themed, foreground, originalColor: style.color });
      if (protectedElement) clearBranch(element, false);
      else {
        for (let index = element.children.length - 1; index >= 0; index -= 1) stack.push(element.children[index]!);
      }
    }
  }
  function queue(root: Element) {
    if (!root.isConnected || fullScan) return;
    // A subtree moved into an existing control can still have old paint snapshots.
    // Always enter through the outer protected root rather than trusting those.
    let protectedRoot = root.closest(protectedContent);
    while (protectedRoot) {
      root = protectedRoot;
      protectedRoot = root.parentElement?.closest(protectedContent) ?? null;
    }
    // A moved/new subtree may not yet have an ancestor paint snapshot.
    while (root.parentElement && !painted.has(root.parentElement)) root = root.parentElement;
    for (const existing of pending) {
      if (existing.contains(root)) return;
      if (root.contains(existing)) pending.delete(existing);
    }
    pending.add(root);
  }
  function update() {
    timer = 0;
    observer.disconnect();
    try {
      // A full pass already covers every dependency. Defer CSSOM analysis until
      // it is actually needed to decide the scope of a subsequent partial pass.
      if (!fullScan && stylesChanged) { globalSelectors = collectGlobalSelectors(); stylesChanged = false; }
      // Bundled CSS often contains :has utilities unused by this page. They only
      // widen the scan when a potential anchor exists, checked on every update.
      const globalImpact = !fullScan && (globalSelectors === null || globalSelectors.some(selector => document.querySelector(selector)));
      const roots = fullScan || globalImpact ? [document.documentElement] : [...pending].filter(root => root.isConnected);
      fullScan = false;
      pending.clear();
      for (const root of removed) {
        if (!root.isConnected) clearBranch(root);
      }
      removed.clear();
      if (!roots.length) return;
      const changes: Change[] = [];
      // Disable only our CSS while reading original inherited colors. Keep existing
      // marks in place and apply differences afterwards instead of rewriting them all.
      document.documentElement.setAttribute(measuringAttribute, '');
      for (const root of roots) readBranch(root, changes);
      for (const change of changes) apply(change);
    } finally {
      document.documentElement.removeAttribute(measuringAttribute);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    }
  }
  function schedule() {
    if (timer || document.hidden) return;
    timer = window.setTimeout(() => {
      timer = 0;
      if (state.__cheshiPageTheme === cleanup && !document.hidden) update();
    }, 250);
  }
  function invalidateAll() { fullScan = true; stylesChanged = true; pending.clear(); schedule(); }
  function containsStyles(node: Node): boolean {
    return node instanceof Element && (node.matches('style, link') || !!node.querySelector('style, link'));
  }
  function onMutations(records: MutationRecord[]) {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target) continue;
      let stylesheetMutation = !!target.closest('head, style, link');
      if (record.type === 'childList') {
        for (const node of record.removedNodes) if (node instanceof Element) removed.add(node);
        stylesheetMutation ||= [...record.addedNodes, ...record.removedNodes].some(containsStyles);
      }
      if (stylesheetMutation || target === document.documentElement || target === document.body) {
        fullScan = true;
        stylesChanged = true;
        pending.clear();
        continue;
      }
      // Include siblings: class/attribute and child-list changes can affect sibling
      // combinators and positional selectors, not just the changed element itself.
      queue(target.parentElement ?? target);
    }
    schedule();
  }
  function onVisibilityChange() {
    if (!document.hidden && (fullScan || pending.size)) schedule();
  }
  const observer = new MutationObserver(onMutations);
  function cleanup() {
    observer.disconnect();
    window.clearTimeout(timer);
    window.removeEventListener('resize', invalidateAll);
    document.removeEventListener('load', invalidateAll, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    for (const [element, mark] of marked) removeMark(element, mark);
    pending.clear();
    removed.clear();
    delete state.__cheshiPageTheme;
  }
  state.__cheshiPageTheme = cleanup;
  window.addEventListener('resize', invalidateAll);
  document.addEventListener('load', invalidateAll, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  update();
}

export function pageBackgroundScript(color: string | null): string {
  return `(${installPageTheme.toString()})(${JSON.stringify(color)})`;
}

export function pageBackgroundCss(color: string): string {
  const enabled = ':root:not([data-cheshi-page-measuring])';
  const foreground = (value: string) => `${enabled}[data-cheshi-page-foreground="${value}"], ${enabled} [data-cheshi-page-foreground="${value}"]`;
  return `${enabled}, ${enabled} body, ${enabled} [data-cheshi-page-background] { background-color: ${color} !important; }
    ${foreground('light')} { color: #ffffff !important; }
    ${foreground('dark')} { color: #000000 !important; }
    ${foreground('original')} { color: var(--cheshi-page-original-color) !important; }`;
}
