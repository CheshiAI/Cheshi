import { createContext, runInContext } from 'node:vm';
import { pageBackgroundScript } from '../lib/showcase-page-theme.mts';

export class TestElement {
  tagName: string;
  parentElement: TestElement | null = null;
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  protected = false;
  properties = new Map<string, string>();
  priorities = new Map<string, string>();
  writes = 0;
  style = { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', color: '',
    getPropertyValue: (name: string) => this.properties.get(name) ?? '',
    getPropertyPriority: (name: string) => this.priorities.get(name) ?? '',
    setProperty: (name: string, value: string, priority = '') => {
      this.writes += 1; this.properties.set(name, value); this.priorities.set(name, priority);
    },
    removeProperty: (name: string) => {
      this.writes += 1; this.properties.delete(name); this.priorities.delete(name);
    },
  };
  constructor(tagName: string, parent: TestElement | null, backgroundColor?: string) {
    this.tagName = tagName;
    if (parent) parent.append(this);
    if (backgroundColor) this.style.backgroundColor = backgroundColor;
  }
  get isConnected(): boolean { return this.tagName === 'HTML' || !!this.parentElement?.isConnected; }
  append(element: TestElement) {
    element.remove(); element.parentElement = this; this.children.push(element);
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
  }
  contains(element: TestElement): boolean {
    return element === this || this.children.some(child => child.contains(element));
  }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (/^[a-z]+$/i.test(value)) return value.toUpperCase() === this.tagName;
      if (/^\.[\w-]+$/.test(value)) return (this.attributes.get('class') ?? '').split(/\s+/).includes(value.slice(1));
      if (/^#[\w-]+$/.test(value)) return this.attributes.get('id') === value.slice(1);
      if (value.startsWith('[contenteditable]')) {
        return this.attributes.has('contenteditable') && this.attributes.get('contenteditable') !== 'false';
      }
      const role = value.match(/^\[role="([^"]+)"\]$/);
      if (role) return this.attributes.get('role') === role[1];
      const attribute = value.match(/^\[([^=\]]+)\]$/);
      return !!attribute && this.attributes.has(attribute[1]!);
    }) || (this.protected && selector.includes('button'));
  }
  querySelectorAll(selector: string): TestElement[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): TestElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): TestElement | null {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null;
  }
  setAttribute(name: string, value: string) { this.writes += 1; this.attributes.set(name, value); }
  removeAttribute(name: string) { this.writes += 1; this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  get background() { return this.attributes.has('data-cheshi-page-background'); }
  get foreground() { return this.attributes.get('data-cheshi-page-foreground'); }
}

type RecordInput = { type: string; target: TestElement; attributeName?: string;
  addedNodes?: TestElement[]; removedNodes?: TestElement[] };
type Listener = (event?: { target: TestElement }) => void;
export function styleSheet(selectorText: string, declarations: Record<string, string>) {
  const properties = Object.keys(declarations);
  const style = { ...declarations, length: properties.length,
    cssText: properties.map(name => `${name}: ${declarations[name]}`).join(';'),
    getPropertyValue: (name: string) => declarations[name] ?? '',
    item: (index: number) => properties[index] ?? '',
    [Symbol.iterator]: () => properties[Symbol.iterator](),
  };
  Object.assign(style, properties);
  return { cssRules: [{ selectorText, style, cssText: `${selectorText} { ${style.cssText} }` }] };
}

export function harness() {
  const html = new TestElement('HTML', null, 'rgb(255, 255, 255)');
  const body = new TestElement('BODY', html);
  const elements = [html, body];
  const readElements: TestElement[] = [];
  const timers = new Map<number, { callback: () => void; due: number }>();
  const listeners = new Map<string, Listener>();
  let sequence = 0;
  let now = 0;
  let mutation!: (records: RecordInput[]) => void;
  let observing = false;
  let themeEnabled = false;
  const events = {
    addEventListener: (name: string, callback: Listener) => { listeners.set(name, callback); },
    removeEventListener: (name: string) => { listeners.delete(name); },
  };
  const document = { ...events, documentElement: html, body, hidden: false,
    styleSheets: [] as Array<{ cssRules: unknown[] }>,
    adoptedStyleSheets: [] as Array<{ cssRules: unknown[] }>,
    querySelector: (selector: string) => html.matches(selector) ? html : html.querySelector(selector),
    querySelectorAll: (selector: string) => selector.startsWith('[')
      ? elements.filter(element => element.isConnected && (element.background || element.foreground))
      : elements.filter(element => element.isConnected),
  };
  const clock = {
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++sequence, { callback, due: now + delay }); return sequence;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  function computedColor(element: TestElement): string {
    if (themeEnabled && !html.hasAttribute('data-cheshi-page-measuring')) {
      if (element.foreground === 'light') return 'rgb(255, 255, 255)';
      if (element.foreground === 'dark') return 'rgb(0, 0, 0)';
      if (element.foreground === 'original') return element.properties.get('--cheshi-page-original-color')!;
    }
    return element.style.color && element.style.color !== 'inherit' ? element.style.color
      : element.parentElement ? computedColor(element.parentElement) : 'rgb(0, 0, 0)';
  }
  const context = createContext({
    HTMLElement: TestElement, Element: TestElement,
    location: { protocol: 'https:' }, window: { ...events, ...clock }, document, ...clock,
    getComputedStyle: (element: TestElement) => {
      readElements.push(element); return { ...element.style, color: computedColor(element) };
    },
    MutationObserver: class {
      constructor(callback: typeof mutation) { mutation = callback; }
      observe() { observing = true; }
      disconnect() { observing = false; }
    },
  });
  const advance = (milliseconds: number): void => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now) { timers.delete(id); timer.callback(); }
    }
  };
  return { html, body, elements, timers, listeners, advance, document, readElements,
    get styleReads() { return readElements.length; },
    setHidden(hidden: boolean) { document.hidden = hidden; listeners.get('visibilitychange')?.(); },
    install(color: string | null) {
      const result = runInContext(pageBackgroundScript(color), context); themeEnabled = color !== null; return result;
    },
    add(tag: string, background?: string, parent = body) {
      const element = new TestElement(tag, parent, background); elements.push(element); return element;
    },
    mutate(records: RecordInput[] = [{ type: 'childList', target: body }]) {
      if (observing) mutation(records.map(record => ({ addedNodes: [], removedNodes: [], ...record })));
    },
    flush: () => advance(250),
  };
}
