import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import { CalendarDateTimeField } from '../frontend/src/features/calendar/CalendarDateTimeField';
import { Modal } from '../frontend/src/shared/ui/Modal';

async function withPicker(run: (h: {
  document: Document; changes: string[]; button: (label: string) => HTMLButtonElement;
  click: (label: string) => Promise<void>; input: (label: string, value: string) => Promise<void>;
  key: (key: string, shift?: boolean) => Promise<void>; render: (allDay?: boolean, disabled?: boolean) => Promise<void>;
  submissions: () => number; closes: () => number;
}) => Promise<void>, initial = '2026-09-30T10:00') {
  const window = new Window();
  const document = window.document as unknown as Document;
  const globals = { window, document, navigator: window.navigator, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  let submissions = 0; let closes = 0;
  function Fixture({ allDay = false, disabled = false }) {
    const [value, setValue] = useState(initial);
    return <Modal title="EVENT" onClose={() => { closes++; }}><form onSubmit={event => { event.preventDefault(); submissions++; }}>
      <CalendarDateTimeField label="Start" value={allDay ? value.slice(0, 10) : value} allDay={allDay} disabled={disabled}
        onChange={next => { changes.push(next); setValue(next); }} />
      <button type="button" aria-label="Outside">Outside</button>
    </form></Modal>;
  }
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
  const render = async (allDay = false, disabled = false) => { await act(async () => root.render(<Fixture allDay={allDay} disabled={disabled} />)); };
  try {
    await render();
    await run({ document, changes, button, render,
      click: async label => { await act(async () => button(label).click()); },
      input: async (label, value) => { await act(async () => {
        const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
      }); },
      key: async (key, shift = false) => { await act(async () => document.activeElement!.dispatchEvent(
        new globalThis.window.KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }))); },
      submissions: () => submissions, closes: () => closes,
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('date picker stays in the modal blur context and applies the selected date without shifting local time', async () => {
  await withPicker(async h => {
    expect(h.document.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(h.button('Start date and time').textContent).toBe('Sep 30, 2026 · 10:00 AM');
    expect(h.document.querySelectorAll('[aria-haspopup="dialog"]')).toHaveLength(1);
    await h.click('Start date and time');
    const popup = h.document.querySelector('[role="dialog"]')!;
    expect(popup.closest('dialog')).not.toBeNull();
    expect(popup.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(popup.closest('dialog')?.querySelector(':scope > div')?.contains(popup)).toBe(false);
    expect(h.document.activeElement?.getAttribute('data-date')).toBe('2026-09-30');
    await h.click('2026-10-01');
    expect(h.changes).toEqual([]);
    await h.click('Done');
    expect(h.changes).toEqual(['2026-10-01T10:00']);
    expect(h.submissions()).toBe(0);
    expect(h.document.activeElement).toBe(h.button('Start date and time'));
    expect(h.document.querySelector('[role="dialog"]')).toBeNull();
  });
});

test.each([['12', 'AM', '00'], ['12', 'PM', '12'], ['1', 'PM', '13']] as const)(
  'time entry converts %s %s to hour %s and Enter never submits the event', async (hour, period, expected) => {
    await withPicker(async h => {
      await h.click('Start date and time');
      h.document.querySelector<HTMLInputElement>('[aria-label="Hour"]')!.focus();
      await h.input('Hour', hour); await h.input('Minute', '5'); await h.click(period);
      h.document.querySelector<HTMLInputElement>('[aria-label="Minute"]')!.focus();
      await h.key('Enter');
      expect(h.changes).toEqual([`2026-09-30T${expected}:05`]);
      expect(h.submissions()).toBe(0);
    });
  });

test('invalid time cannot be applied; escape and outside click discard pending edits', async () => {
  await withPicker(async h => {
    await h.click('Start date and time');
    await h.input('Hour', '0'); await h.input('Minute', '60');
    expect(h.button('Done').disabled).toBe(true);
    expect(h.document.querySelector('[role="alert"]')).not.toBeNull();
    h.document.querySelector<HTMLInputElement>('[aria-label="Minute"]')!.focus();
    await h.key('Enter'); expect(h.changes).toEqual([]);
    await h.key('Escape');
    expect(h.closes()).toBe(0);
    expect(h.document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.document.activeElement).toBe(h.button('Start date and time'));
    await h.click('Start date and time'); await h.click('2026-10-02');
    await act(async () => h.button('Outside').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
    expect(h.changes).toEqual([]);
    expect(h.document.querySelector('[role="dialog"]')).toBeNull();
  });
});

test('keyboard date movement crosses month boundaries, clamps leap months and traps tab within the picker', async () => {
  await withPicker(async h => {
    await h.click('Start date and time');
    await h.key('PageDown');
    expect(h.document.activeElement?.getAttribute('data-date')).toBe('2024-02-29');
    await h.key('ArrowRight');
    expect(h.document.activeElement?.getAttribute('data-date')).toBe('2024-03-01');
    h.button('Done').focus(); await h.key('Tab');
    expect(h.document.activeElement).toBe(h.button('Previous month'));
    await h.key('Tab', true);
    expect(h.document.activeElement).toBe(h.button('Done'));
    await h.click('Done');
    expect(h.changes).toEqual(['2024-03-01T10:00']);
  }, '2024-01-31T10:00');
});

test('all-day mode commits only a date and disabled fields cannot open the picker', async () => {
  await withPicker(async h => {
    await h.render(true);
    expect(h.document.querySelector('[aria-label="Start time"]')).toBeNull();
    await h.click('Start date');
    expect(h.document.querySelector('[aria-label="Hour"]')).toBeNull();
    await h.click('2026-10-01'); await h.click('Done');
    expect(h.changes).toEqual(['2026-10-01']);
    await h.render(true, true);
    expect(h.button('Start date').disabled).toBe(true);
    await h.click('Start date');
    expect(h.document.querySelector('[role="dialog"]')).toBeNull();
  });
});
