import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
export async function withDOM(run: (ui: { render(node: ReactNode): Promise<void>; click(label: string): Promise<void>; type(label: string, text: string): Promise<void> }) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node, HTMLElement: window.HTMLElement,
    HTMLDialogElement: window.HTMLDialogElement, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div'); document.body.append(container);
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container);
  try { await run({ render: async node => { await act(async () => root.render(node)); }, click: async label => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label);
    if (!button) throw new Error(`Missing button ${label}`); await act(async () => button.click());
  }, type: async (label, text) => {
    const input = document.querySelector(`[aria-label="${label}"]`) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, text); input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    });
  } }); } finally {
    await act(async () => root.unmount()); await window.happyDOM.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
