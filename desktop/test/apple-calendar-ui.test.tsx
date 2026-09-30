import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { CalendarBrowser } from '../frontend/src/features/calendar/CalendarView';
import { CalendarEventDialog } from '../frontend/src/features/calendar/CalendarEventDialog';
import { CalendarEventList } from '../frontend/src/features/calendar/CalendarEventList';
import { calendarApiFixture, createCalendarDeferred, calendarEventFixture as event } from './apple-calendar-fixtures';
import { calendarFailure, type AppleCalendar, type CalendarAccess, type CalendarReply } from '../shared/apple-calendar';
import { addDays, localDay } from '../frontend/src/features/calendar/calendarDates';

async function withCalendarDOM(run: (render: (node: ReactNode) => Promise<void>, document: Document) => Promise<void>) {
  const window = new Window();
  const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = globalThis.document.createElement('div');
  globalThis.document.body.append(container);
  const root = createRoot(container);
  try { await run(async node => { await act(async () => root.render(node)); }, globalThis.document); }
  finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

async function enterEventSearch(document: Document, value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search events"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function calendarRefreshGesture(document: Document) {
  const viewport = () => document.querySelector<HTMLElement>('[aria-label="Event list"]')!;
  return {
    viewport,
    pointer: async (type: string, y: number) => { await act(async () => {
      const event = new window.PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: 10, clientY: y, button: 0, bubbles: true, cancelable: true });
      (type === 'pointerdown' ? viewport() : window).dispatchEvent(event);
    }); },
    wheel: async (deltaY: number) => { await act(async () => {
      viewport().dispatchEvent(new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    }); },
    idle: async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); }); },
  };
}

test('calendar pull refresh starts on release and keeps one 36px indicator below search until completion', async () => {
  let pending: ReturnType<typeof createCalendarDeferred<CalendarReply<typeof event[]>>> | null = null;
  let reads = 0;
  const api = calendarApiFixture({ events: async () => { reads++; return pending ? pending.promise : { ok: true, value: [] }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const gesture = calendarRefreshGesture(document);
    pending = createCalendarDeferred<CalendarReply<typeof event[]>>();
    await gesture.pointer('pointerdown', 10);
    await gesture.pointer('pointermove', 40);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Pull to refresh');
    await gesture.pointer('pointermove', 110);
    const status = document.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toBe('Release to refresh');
    expect(status.style.height).toBe('36px');
    expect(status.previousElementSibling?.querySelector('[aria-label="Search events"]')).not.toBeNull();
    expect(reads).toBe(1);
    await gesture.pointer('pointerup', 110);
    expect(reads).toBe(2);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.querySelector('[role="status"]')).toBe(status);
    const refresh = document.querySelector<HTMLButtonElement>('[aria-label="Refresh calendars"]')!;
    expect(refresh.disabled).toBe(true);
    await act(async () => refresh.click());
    await gesture.pointer('pointerdown', 10);
    await gesture.pointer('pointermove', 110);
    await gesture.pointer('pointerup', 110);
    expect(reads).toBe(2);
    await act(async () => pending!.resolve({ ok: true, value: [] }));
    expect(status.isConnected).toBe(false);
    expect(refresh.disabled).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No events.');
  });
});

test('calendar ignores short and scrolled pulls, handles trackpad refresh failure and allows retry', async () => {
  let reads = 0;
  let failing = false;
  const api = calendarApiFixture({ events: async () => { reads++; return failing ? calendarFailure('unavailable') : { ok: true, value: [] }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const gesture = calendarRefreshGesture(document);
    await gesture.pointer('pointerdown', 10);
    await gesture.pointer('pointermove', 35);
    await gesture.pointer('pointerup', 35);
    expect(reads).toBe(1);
    gesture.viewport().scrollTop = 100;
    await gesture.pointer('pointerdown', 10);
    await gesture.pointer('pointermove', 110);
    await gesture.pointer('pointerup', 110);
    await gesture.wheel(-80);
    gesture.viewport().scrollTop = 0;
    await gesture.wheel(-80);
    await gesture.idle();
    expect(reads).toBe(1);
    failing = true;
    await gesture.wheel(-80);
    await gesture.idle();
    expect(reads).toBe(2);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Could not load events.');
    failing = false;
    await gesture.wheel(-80);
    await gesture.idle();
    expect(reads).toBe(3);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No events.');
  });
});

test('pull refresh preserves the calendar search and reloads its annual results', async () => {
  let reads = 0;
  const api = calendarApiFixture({ events: async () => { reads++; return { ok: true, value: [event] }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await enterEventSearch(document, 'meeting');
    expect(reads).toBe(7);
    const gesture = calendarRefreshGesture(document);
    await gesture.pointer('pointerdown', 10);
    await gesture.pointer('pointermove', 110);
    await gesture.pointer('pointerup', 110);
    expect(reads).toBe(14);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Search events"]')?.value).toBe('meeting');
    expect(document.querySelector('[aria-label="Event search results"] [role="status"]')?.textContent).toBe('1 result');
  });
});

test('event list tracks overflow on viewport and content resize, restores the last line and cleans up observers', async () => {
  const callbacks = new Set<() => void>();
  const observed = new Set<Element>();
  let disconnected = 0;
  await withCalendarDOM(async (render, document) => {
    class TestResizeObserver {
      private readonly notify: () => void;
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this);
        callbacks.add(this.notify);
      }
      observe(target: Element) { observed.add(target); }
      unobserve(target: Element) { observed.delete(target); }
      disconnect() { callbacks.delete(this.notify); ++disconnected; }
    }
    Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: TestResizeObserver });
    let opened = '';
    const list = (events: typeof event[]) => <CalendarEventList events={events} calendars={[]} searching={false}
      onOpen={item => { opened = item.id; }} />;
    await render(list([event]));
    const viewport = document.querySelector<HTMLElement>('[aria-label="Event list"]')!;
    let contentHeight = 101;
    let viewportHeight = 100;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => contentHeight },
      clientHeight: { configurable: true, get: () => viewportHeight },
    });
    const resize = () => { callbacks.forEach(callback => callback()); };
    expect(observed.has(viewport)).toBe(true);
    expect(observed.has(viewport.firstElementChild!)).toBe(true);
    expect(viewport.getAttribute('data-auto-hide-scrollbars')).toBe('true');
    resize();
    expect(viewport.dataset.overflowing).toBe('true');
    // Repeat the measurement at the one-pixel boundary; hiding the line must not toggle the state.
    resize();
    expect(viewport.dataset.overflowing).toBe('true');
    viewportHeight = 101;
    resize();
    expect(viewport.dataset.overflowing).toBe('false');
    contentHeight = 220;
    resize();
    expect(viewport.dataset.overflowing).toBe('true');
    await act(async () => viewport.querySelector('button')!.click());
    expect(opened).toBe(event.id);
    contentHeight = 0;
    await render(list([]));
    expect(viewport.dataset.overflowing).toBe('false');
    expect(viewport.querySelector('button')).toBeNull();
    expect(disconnected).toBe(1);
  });
  expect(callbacks.size).toBe(0);
  expect(disconnected).toBe(2);
});

test('annual search finds another month, reuses loaded events, opens details and clears back to the selected day', async () => {
  const today = localDay(new Date());
  const year = Number(today.slice(0, 4));
  const otherDay = `${year}-${today.slice(5, 7) === '12' ? '01' : '12'}-15`;
  const events = [{ ...event, id: 'today', title: 'Today meeting', allDay: true, start: today, end: addDays(today, 1) },
    { ...event, id: 'other-month', title: 'Budget review', location: 'Seoul', notes: '분기 계획', allDay: true,
      start: otherDay, end: addDays(otherDay, 1) }];
  let reads = 0;
  const api = calendarApiFixture({ events: async query => {
    ++reads;
    return { ok: true, value: events.filter(item => {
      const start = new Date(`${item.start}T00:00`).getTime();
      return start >= Date.parse(query.start) && start < Date.parse(query.end);
    }) };
  } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    expect(reads).toBe(1);
    expect(document.querySelector('[aria-label="Events for selected date"]')?.textContent).toContain('Today meeting');
    await enterEventSearch(document, 'budget');
    const results = () => document.querySelector('[aria-label="Event search results"]')!;
    expect(results().textContent).toContain(`Jan 1 – Dec 31, ${year}`);
    expect(results().textContent).toContain('Budget review');
    expect(results().textContent).not.toContain('Today meeting');
    expect(results().querySelector('[role="status"]')?.textContent).toBe('1 result');
    expect(reads).toBe(7);
    await enterEventSearch(document, 'seoul 계획');
    expect(results().textContent).toContain('Budget review');
    expect(reads).toBe(7);
    await act(async () => [...results().querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.querySelector('strong')?.textContent === 'Budget review')!.click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="Event title"]')?.value).toBe('Budget review');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Close')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Clear event search"]')!.click());
    expect(document.querySelector('[aria-label="Event search results"]')).toBeNull();
    expect(document.querySelector('[aria-label="Events for selected date"]')?.textContent).toContain('Today meeting');
    expect(document.querySelector(`[aria-label="${today}, 1 events"]`)?.getAttribute('aria-pressed')).toBe('true');
    expect(reads).toBe(7);
  });
});

test('search year navigation and the calendar selector change the search scope; Escape restores the agenda', async () => {
  const queries: { start: string; calendarId: string }[] = [];
  const api = calendarApiFixture({ events: async query => { queries.push(query); return { ok: true, value: [] }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await enterEventSearch(document, 'meeting');
    const year = new Date().getFullYear();
    expect(queries).toHaveLength(7);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next search year"]')!.click());
    expect(queries).toHaveLength(13);
    expect(queries[7]?.start).toBe(new Date(year + 1, 0, 1).toISOString());
    expect(document.querySelector('[aria-label="Event search results"]')?.textContent).toContain(`Search results · ${year + 1}`);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Displayed calendar"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(button => button.textContent === 'iCloud / Work')!.click());
    expect(queries.slice(-6).every(query => query.calendarId === 'calendar-1')).toBe(true);
    expect(document.querySelector('[aria-label="Event search results"]')?.textContent).toContain('Selected calendar');
    expect(document.querySelector('[aria-label="Event search results"] [role="status"]')?.textContent).toBe('No matching events.');
    await act(async () => document.querySelector('[aria-label="Search events"]')!
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[aria-label="Events for selected date"]')).not.toBeNull();
  });
});

test('search errors offer retry and never present incomplete results as no matches', async () => {
  let failed = true;
  const api = calendarApiFixture({ events: async query => {
    const searchWindow = Date.parse(query.end) - Date.parse(query.start) > 50 * 86400_000;
    return searchWindow && failed ? calendarFailure('unavailable') : { ok: true, value: [] };
  } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await enterEventSearch(document, 'meeting');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not connect');
    expect(document.body.textContent).not.toContain('No matching events.');
    failed = false;
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry search')!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('No matching events.');
  });
});

test('calendar requests access only after connecting and exposes month navigation and read-only calendar state', async () => {
  let granted = false;
  let connects = 0;
  const queries: string[] = [];
  const api = calendarApiFixture({ status: async () => ({ ok: true, value: granted ? 'full' : 'not-determined' }),
    connect: async () => { granted = true; ++connects; return { ok: true, value: 'full' }; },
    calendars: async () => ({ ok: true, value: [{ id: 'readonly', title: 'Subscribed', source: 'iCloud', writable: false, isDefault: false }] }),
    events: async query => { queries.push(query.start); return { ok: true, value: [] }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    expect(connects).toBe(0); expect(queries).toEqual([]);
    const connect = [...document.querySelectorAll('button')].find(button => button.textContent === 'Connect Apple Calendar');
    expect(connect).toBeDefined();
    await act(async () => connect!.click());
    expect(connects).toBe(1); expect(queries).toHaveLength(1);
    expect(document.querySelectorAll('button[aria-pressed]')).toHaveLength(43);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="New event"]')?.disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Displayed calendar"]')!.click());
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Read only');
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    expect(queries).toHaveLength(2); expect(queries[0]).not.toBe(queries[1]);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh calendars"]')!.click());
    expect(queries).toHaveLength(3); expect(queries[1]).toBe(queries[2]);
  });
});

function deletionDialog(document: Document) {
  return [...document.querySelectorAll('dialog')].find(dialog => dialog.querySelector('h2')?.textContent === 'DELETE EVENT')!;
}

test.each([0, 1])('creating, updating and deleting an event restores agenda counts with %i remaining events', async remaining => {
  const today = localDay(new Date());
  let events = Array.from({ length: remaining }, (_, index) => ({ ...event, id: `remaining-${index}`,
    title: 'Remaining event', allDay: true, start: today, end: addDays(today, 1) }));
  const api = calendarApiFixture({
    events: async () => ({ ok: true, value: events }),
    create: async input => {
      const created = { ...event, ...input };
      events = [...events, created];
      return { ok: true, value: created };
    },
    update: async input => {
      const updated = { ...event, ...input.event };
      events = events.map(item => item.id === input.target.id ? updated : item);
      return { ok: true, value: updated };
    },
    delete: async target => {
      events = events.filter(item => item.id !== target.id);
      return { ok: true, value: target };
    },
  });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const agenda = document.querySelector('[aria-label="Events for selected date"]')!;
    const assertCount = (count: number) => {
      expect(agenda.querySelector('[role="status"]')?.textContent).toBe(count ? `${count} events` : 'No events.');
      expect(document.querySelector(`[aria-label="${today}, ${count} events"]`)).not.toBeNull();
      expect(document.querySelector('dialog')).toBeNull();
    };
    const enterTitle = async (value: string) => { await act(async () => {
      const title = document.querySelector<HTMLInputElement>('[aria-label="Event title"]')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, value);
      title.dispatchEvent(new window.Event('input', { bubbles: true }));
    }); };
    const submit = async () => { await act(async () => document.querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))); };
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="New event"]')!.click());
    await enterTitle('Created event');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="All day"]')!.click());
    await submit();
    assertCount(remaining + 1);
    await act(async () => [...agenda.querySelectorAll('button')]
      .find(button => button.querySelector('strong')?.textContent === 'Created event')!.click());
    await enterTitle('Updated event');
    await submit();
    assertCount(remaining + 1);
    await act(async () => [...agenda.querySelectorAll('button')]
      .find(button => button.querySelector('strong')?.textContent === 'Updated event')!.click());
    await act(async () => [...document.querySelector('dialog')!.querySelectorAll('button')]
      .find(button => button.textContent === 'Delete')!.click());
    await act(async () => deletionDialog(document).querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assertCount(remaining);
    expect(agenda.textContent).not.toContain('Updated event');
  });
});

test('deletion confirmation preserves edits on cancel and Escape, guards pending writes and closes after acknowledgement', async () => {
  const pending = createCalendarDeferred<CalendarReply<{ id: string; revision: string }>>();
  let deleted = 0;
  let saved = 0;
  let closed = 0;
  const api = calendarApiFixture({ delete: async () => { ++deleted; return pending.promise; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarEventDialog api={api} event={event} day="2026-09-22" calendarId="calendar-1"
      calendars={[{ id: 'calendar-1', title: 'Work', source: 'iCloud', writable: true, isDefault: true }]}
      onClose={() => { ++closed; }} onChanged={() => { ++saved; }} />);
    const editDialog = document.querySelector('dialog')!;
    const originalDelete = [...editDialog.querySelectorAll('button')].find(button => button.textContent === 'Delete')!;
    const title = document.querySelector<HTMLInputElement>('[aria-label="Event title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'Unsaved draft');
      title.dispatchEvent(new window.Event('input', { bubbles: true }));
      originalDelete.focus();
      originalDelete.click();
    });
    expect(deleted).toBe(0);
    expect(document.querySelectorAll('dialog')).toHaveLength(2);
    expect(deletionDialog(document).textContent).toContain(event.title);
    expect(deletionDialog(document).textContent).toContain('Delete this event from Apple Calendar?');
    expect(editDialog.textContent).not.toContain('Delete this event from Apple Calendar?');
    const cancel = [...deletionDialog(document).querySelectorAll('button')].find(button => button.textContent === 'Cancel')!;
    expect(document.activeElement === cancel).toBe(true);
    await act(async () => cancel.click());
    expect(document.querySelectorAll('dialog')).toHaveLength(1);
    expect(title.value).toBe('Unsaved draft');
    expect(document.activeElement === originalDelete).toBe(true);
    await act(async () => originalDelete.click());
    await act(async () => deletionDialog(document).dispatchEvent(new window.Event('cancel', { cancelable: true })));
    expect(document.querySelectorAll('dialog')).toHaveLength(1);
    expect(title.value).toBe('Unsaved draft');
    expect(closed).toBe(0);
    await act(async () => originalDelete.click());
    const confirmation = deletionDialog(document);
    const submit = () => confirmation.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => { submit(); submit(); });
    expect(deleted).toBe(1);
    expect(saved).toBe(0);
    expect(confirmation.textContent).toContain('Deleting…');
    expect([...confirmation.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    await act(async () => confirmation.dispatchEvent(new window.Event('cancel', { cancelable: true })));
    expect(document.querySelectorAll('dialog')).toHaveLength(2);
    await act(async () => pending.resolve({ ok: true, value: { id: event.id, revision: event.revision } }));
    expect(deleted).toBe(1); expect(saved).toBe(1); expect(closed).toBe(0);
    expect(document.querySelectorAll('dialog')).toHaveLength(1);
  });
});

test.each(['unavailable', 'write-unknown'] as const)('deletion error %s stays in the confirmation and respects retry safety', async code => {
  let deletions = 0;
  let updates = 0;
  let saved = 0;
  const api = calendarApiFixture({
    delete: async target => ++deletions === 1 ? calendarFailure(code) : { ok: true, value: target },
    update: async () => { ++updates; return { ok: true, value: event }; },
  });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarEventDialog api={api} event={event} day="2026-09-22" calendarId="calendar-1"
      calendars={[]} onClose={() => {}} onChanged={() => { ++saved; }} />);
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Delete')!.click());
    const confirmation = deletionDialog(document);
    const submit = () => confirmation.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => submit());
    expect(confirmation.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(saved).toBe(0);
    const remove = confirmation.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(remove.disabled).toBe(code === 'write-unknown');
    await act(async () => submit());
    expect(deletions).toBe(code === 'write-unknown' ? 1 : 2);
    expect(saved).toBe(code === 'write-unknown' ? 0 : 1);
    expect(updates).toBe(0);
    if (code === 'write-unknown') {
      await act(async () => [...confirmation.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click());
      expect(document.querySelectorAll('dialog')).toHaveLength(1);
    }
  });
});

test('recurring events expose their details with no save or delete actions', async () => {
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarEventDialog api={calendarApiFixture()} event={{ ...event, recurring: true, readOnly: true }}
      day="2026-09-22" calendarId="calendar-1" calendars={[]} onClose={() => {}} onChanged={() => {}} />);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Event title"]')?.disabled).toBe(true);
    const labels = [...document.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).not.toContain('Save'); expect(labels).not.toContain('Delete');
    expect(document.body.textContent).toContain('Recurring events');
  });
});

test('calendar initial load, refresh and search show one shared loader directly below the search field', async () => {
  let pending = createCalendarDeferred<CalendarReply<typeof event[]>>();
  const api = calendarApiFixture({ events: () => pending.promise });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const assertLoading = (searching = false, retained = false) => {
      const panel = document.querySelector(searching ? '[aria-label="Event search results"]' : '[aria-label="Events for selected date"]')!;
      const statuses = panel.querySelectorAll('[role="status"]');
      expect(statuses).toHaveLength(1);
      const indicator = statuses[0]!;
      expect(indicator.getAttribute('aria-label')).toBe(searching ? 'Searching events…' : 'Loading events…');
      expect(indicator.firstElementChild?.children).toHaveLength(9);
      expect(indicator.previousElementSibling?.querySelector('[aria-label="Search events"]')).not.toBeNull();
      if (!retained) {
        expect(panel.textContent).not.toContain('No events.');
        expect(panel.textContent).not.toContain('No matching events.');
      }
    };
    assertLoading();
    await act(async () => pending.resolve({ ok: true, value: [] }));
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No events.');
    pending = createCalendarDeferred<CalendarReply<typeof event[]>>();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh calendars"]')!.click());
    assertLoading(false, true);
    await act(async () => pending.resolve(calendarFailure('unavailable')));
    expect(document.querySelector('[aria-label="Loading events…"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Could not load events.');
    pending = createCalendarDeferred<CalendarReply<typeof event[]>>();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh calendars"]')!.click());
    await act(async () => pending.resolve({ ok: true, value: [] }));
    pending = createCalendarDeferred<CalendarReply<typeof event[]>>();
    await enterEventSearch(document, 'meeting');
    assertLoading(true);
    await act(async () => pending.resolve({ ok: true, value: [] }));
    expect(document.querySelector('[aria-label="Searching events…"]')).toBeNull();
    expect(document.querySelector('[aria-label="Event search results"] [role="status"]')?.textContent).toBe('No matching events.');
  });
});

test.each(['button', 'pull'] as const)('calendar %s refresh retains event rows, month labels and counts until replacement data arrives', async trigger => {
  const today = localDay(new Date());
  const original = { ...event, title: 'Retained meeting', allDay: true, start: today, end: addDays(today, 1) };
  const replacement = { ...original, title: 'Updated meeting' };
  let pending: ReturnType<typeof createCalendarDeferred<CalendarReply<typeof event[]>>> | null = null;
  const api = calendarApiFixture({ events: async () => pending ? pending.promise : { ok: true, value: [original] } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const panel = document.querySelector('[aria-label="Events for selected date"]')!;
    const row = panel.querySelector('[aria-label="Event list"] button')!;
    const count = panel.querySelector('[role="status"]')!;
    const day = document.querySelector(`[aria-label="${today}, 1 events"]`)!;
    const title = [...day.querySelectorAll('span')].find(node => node.textContent === original.title)!;
    const viewport = panel.querySelector<HTMLElement>('[aria-label="Event list"]')!;
    const assertRetained = () => {
      expect(panel.querySelector('[aria-label="Event list"] button')).toBe(row);
      expect(row.textContent).toContain(original.title);
      expect(title.isConnected).toBe(true);
      expect(title.textContent).toBe(original.title);
      expect(day.getAttribute('aria-label')).toBe(`${today}, 1 events`);
      expect(count.isConnected).toBe(true);
      expect(count.textContent).toBe('1 events');
    };
    pending = createCalendarDeferred<CalendarReply<typeof event[]>>();
    if (trigger === 'button') {
      viewport.scrollTop = 40;
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh calendars"]')!.click());
      expect(viewport.scrollTop).toBe(40);
    } else {
      const gesture = calendarRefreshGesture(document);
      await gesture.pointer('pointerdown', 10);
      await gesture.pointer('pointermove', 110);
      await gesture.pointer('pointerup', 110);
    }
    assertRetained();
    expect(panel.querySelectorAll('[role="status"]')).toHaveLength(1);
    await act(async () => pending!.resolve({ ok: true, value: [replacement] }));
    expect(panel.querySelector('[aria-label="Event list"] button')).toBe(row);
    expect(row.textContent).toContain(replacement.title);
    expect(title.isConnected).toBe(true);
    expect(title.textContent).toBe(replacement.title);
    expect(count.isConnected).toBe(true);
    expect(count.getAttribute('role')).toBe('status');
  });
});

test('refresh preserves search rows through the month request and every annual search window', async () => {
  let reads = 0;
  const month = createCalendarDeferred<CalendarReply<typeof event[]>>();
  const annual = createCalendarDeferred<CalendarReply<typeof event[]>>();
  const api = calendarApiFixture({ events: async () => {
    reads++;
    return reads <= 7 ? { ok: true, value: [event] } : reads === 8 ? month.promise : annual.promise;
  } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await enterEventSearch(document, 'meeting');
    const panel = document.querySelector('[aria-label="Event search results"]')!;
    const row = panel.querySelector('[aria-label="Event list"] button')!;
    const count = panel.querySelector('[role="status"]')!;
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh calendars"]')!.click());
    expect(panel.querySelector('[aria-label="Event list"] button')).toBe(row);
    expect(count.isConnected).toBe(true);
    expect(count.textContent).toBe('1 result');
    await act(async () => month.resolve({ ok: true, value: [event] }));
    expect(reads).toBe(9);
    expect(panel.querySelector('[aria-label="Event list"] button')).toBe(row);
    expect(count.isConnected).toBe(true);
    await act(async () => annual.resolve({ ok: true, value: [{ ...event, title: 'Meeting updated' }] }));
    expect(reads).toBe(14);
    expect(panel.querySelector('[aria-label="Event list"] button')).toBe(row);
    expect(row.textContent).toContain('Meeting updated');
  });
});

test('event load failure does not claim an empty agenda and refreshing can recover', async () => {
  let failing = true;
  const api = calendarApiFixture({ events: async () => failing ? calendarFailure('unavailable') : { ok: true, value: [] } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Could not load events.');
    expect(document.body.textContent).not.toContain('No events.');
    expect(document.querySelector('[aria-label$="0 events"]')).toBeNull();
    expect(document.querySelector('[aria-label="Displayed calendar"]')?.textContent).toContain('All calendars');
    failing = false;
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh calendars"]')!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No events.');
  });
});

test('pending access displays loading without offering connection or claiming an empty calendar', async () => {
  const pending = createCalendarDeferred<CalendarReply<CalendarAccess>>();
  let connects = 0;
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={calendarApiFixture({ status: () => pending.promise,
      connect: async () => { connects++; return { ok: true, value: 'full' }; } })}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    expect(document.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Checking calendar access…');
    expect(document.querySelector('[aria-label="Calendar access"]')).toBeNull();
    expect(document.body.textContent).not.toContain('No events.');
    expect(document.querySelector('[aria-label="New event"]')).toBeNull();
    await act(async () => pending.resolve({ ok: true, value: 'not-determined' }));
    expect(document.querySelector('[aria-label="Calendar access"] h2')?.textContent).toBe('Connect Apple Calendar');
    expect(connects).toBe(0);
  });
});

test.each(['denied', 'restricted', 'write-only'] as const)('access state %s explains the restriction and uses the appropriate recovery', async access => {
  let statuses = 0;
  let connects = 0;
  let reads = 0;
  const api = calendarApiFixture({ status: async () => { statuses++; return { ok: true, value: access }; },
    connect: async () => { connects++; return { ok: true, value: 'full' }; },
    events: async () => { reads++; return { ok: true, value: [] }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const panel = document.querySelector('[aria-label="Calendar access"]')!;
    const titles = { denied: 'Calendar access denied', restricted: 'Calendar access restricted', 'write-only': 'Full calendar access required' };
    expect(panel.querySelector('h2')?.textContent).toBe(titles[access]);
    expect(reads).toBe(0);
    expect(connects).toBe(0);
    await act(async () => panel.querySelector<HTMLButtonElement>('button')!.click());
    expect(connects).toBe(access === 'write-only' ? 1 : 0);
    expect(statuses).toBe(access === 'write-only' ? 1 : 2);
    expect(reads).toBe(access === 'write-only' ? 1 : 0);
  });
});

test('status failure offers retry without requesting permission and recovers to the calendar', async () => {
  let failing = true;
  let connects = 0;
  const api = calendarApiFixture({ status: async () => failing ? calendarFailure('unavailable') : { ok: true, value: 'full' },
    connect: async () => { connects++; return { ok: true, value: 'full' }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const panel = document.querySelector('[aria-label="Calendar access"]')!;
    expect(panel.querySelector('h2')?.textContent).toBe('Could not load Apple Calendar');
    expect(panel.querySelector('[role="alert"]')).not.toBeNull();
    const retry = panel.querySelector<HTMLButtonElement>('button')!;
    expect(retry.textContent).toBe('Retry');
    failing = false;
    await act(async () => retry.click());
    expect(connects).toBe(0);
    expect(document.querySelector('[aria-label="Calendar access"]')).toBeNull();
    expect(document.querySelector('[aria-label="Monthly calendar"]')).not.toBeNull();
  });
});

test('shared calendar menu selects a filter and queries only the selected calendar', async () => {
  const filters: string[] = [];
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={calendarApiFixture({ events: async query => { filters.push(query.calendarId); return { ok: true, value: [] }; } })}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Displayed calendar"]')!.click());
    const work = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === 'iCloud / Work')!;
    await act(async () => work.click());
    expect(filters).toEqual(['', 'calendar-1']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[aria-label="Displayed calendar"]')?.textContent).toBe('iCloud / Work');
    const agenda = document.querySelector('[aria-label="Events for selected date"]')!;
    const options = agenda.querySelector('[aria-label="Calendar options"]')!;
    expect(options.textContent).toContain('OPTION');
    expect(options.contains(document.querySelector('[aria-label="Displayed calendar"]'))).toBe(true);
    expect(options.contains(document.querySelector('[aria-label="Refresh calendars"]'))).toBe(true);
    expect(options.compareDocumentPosition(agenda.querySelector('[aria-label="Search events"]')!) & 4).toBe(4);
    await act(async () => options.querySelector<HTMLButtonElement>('[aria-label="New event"]')!.click());
    expect(document.querySelector('[aria-label="Event title"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Event calendar"]')?.textContent).toBe('iCloud / Work');
  });
});

test('holiday policy updates month counts, agenda and a previously selected calendar after refresh', async () => {
  const google: AppleCalendar = { id: 'google', title: '대한민국의 휴일', source: 'Google@Test',
    writable: false, isDefault: false, kind: 'caldav', isSubscribed: false };
  const apple: AppleCalendar = { id: 'apple', title: '대한민국 공휴일', source: 'Subscribed Calendars',
    writable: false, isDefault: false, kind: 'subscription', isSubscribed: true };
  let calendars = [google];
  const day = localDay(new Date());
  const api = calendarApiFixture({ calendars: async () => ({ ok: true, value: calendars }),
    events: async query => ({ ok: true, value: calendars.filter(calendar => !query.calendarId || calendar.id === query.calendarId)
      .map(calendar => ({ ...event, id: calendar.id, calendarId: calendar.id, title: 'Holiday',
        allDay: true, readOnly: true, start: day, end: addDays(day, 1) })) }) });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const displayed = () => document.querySelector<HTMLButtonElement>('[aria-label="Displayed calendar"]')!;
    await act(async () => displayed().click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(button => button.textContent?.includes('Google@Test'))!.click());
    expect(displayed().textContent).toContain('Google@Test');
    calendars = [google, apple];
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh calendars"]')!.click());
    expect(displayed().textContent).toBe('All calendars');
    expect(document.querySelector(`[aria-label="${day}, 1 events"]`)).not.toBeNull();
    const agenda = document.querySelector('[aria-label="Events for selected date"]')!;
    expect(agenda.textContent).toContain('대한민국 공휴일');
    expect(agenda.textContent).not.toContain('대한민국의 휴일');
    expect([...agenda.querySelectorAll('button')].filter(button => button.querySelector('strong'))).toHaveLength(1);
    await act(async () => displayed().click());
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Google@Test');
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('대한민국 공휴일');
  });
});

test('applying start in the event picker advances end by one hour and allows a manual end before saving', async () => {
  const saved: unknown[] = [];
  const original = { ...event, start: new Date(2026, 8, 30, 9).toISOString(), end: new Date(2026, 8, 30, 10).toISOString() };
  const api = calendarApiFixture({ update: async input => { saved.push(input.event); return { ok: true, value: original }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarEventDialog api={api} event={original} day="2026-09-30" calendarId="calendar-1"
      calendars={[]} onClose={() => {}} onChanged={() => {}} />);
    const click = async (label: string) => { await act(async () => {
      const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?? [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
      button.click();
    }); };
    const input = async (label: string, value: string) => { await act(async () => {
      const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    }); };
    await click('Start date and time');
    await input('Hour', '11'); await input('Minute', '30'); await click('PM');
    expect(document.querySelector('button[aria-label="End date and time"]')?.textContent).toBe('Sep 30, 2026 · 10:00 AM');
    await click('Done');
    expect(document.querySelector('button[aria-label="Start date and time"]')?.textContent).toBe('Sep 30, 2026 · 11:30 PM');
    expect(document.querySelector('button[aria-label="End date and time"]')?.textContent).toBe('Oct 1, 2026 · 12:30 AM');
    expect(saved).toEqual([]);
    await click('End date and time');
    await input('Hour', '2'); await click('Done');
    expect(document.querySelector('button[aria-label="End date and time"]')?.textContent).toBe('Oct 1, 2026 · 02:30 AM');
    await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(saved).toEqual([expect.objectContaining({ start: new Date(2026, 8, 30, 23, 30).toISOString(),
      end: new Date(2026, 9, 1, 2, 30).toISOString() })]);
  });
});

test('event modal shared menu and all-day switch preserve creation payload and do not submit on toggle', async () => {
  const inputs: unknown[] = [];
  const api = calendarApiFixture({ create: async input => { inputs.push(input); return { ok: true, value: { ...event, ...input } }; } });
  await withCalendarDOM(async (render, document) => {
    const calendars = [{ id: 'calendar-1', title: 'Work', source: 'iCloud', writable: true, isDefault: true },
      { id: 'calendar-2', title: 'Personal', source: 'iCloud', writable: true, isDefault: false }];
    await render(<CalendarEventDialog api={api} event={null} day="2026-09-22" calendarId="calendar-1"
      calendars={calendars} onClose={() => {}} onChanged={() => {}} />);
    const title = document.querySelector<HTMLInputElement>('[aria-label="Event title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'All-day meeting');
      title.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Event calendar"]')!.click());
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.closest('dialog')).not.toBeNull();
    await act(async () => [...menu.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'iCloud / Personal')!.click());
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[aria-label="Start time"]')).toBeNull();
    expect(document.querySelector('[aria-label="Last day date"]')?.textContent).toContain('Sep 22, 2026');
    expect(inputs).toEqual([]);
    await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(inputs).toEqual([expect.objectContaining({ title: 'All-day meeting', calendarId: 'calendar-2', allDay: true,
      start: '2026-09-22', end: '2026-09-23' })]);
  });
});

test('the shared event form creates a task from title, notes, workspace URL and repeat', async () => {
  let saved: unknown; let writes = 0;
  const api = calendarApiFixture({ async create(input) { writes++; saved = input; return { ok: true, value: { ...event, ...input } }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarEventDialog api={api} event={null} day="2026-10-01" calendarId="calendar-1" calendars={[]}
      onClose={() => {}} onChanged={() => {}} />);
    const enter = async (label: string, text: string, multiline = false) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(multiline ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    };
    await enter('Event title', '[task] Inspect');
    expect(document.body.textContent).toContain('Notes are the task instructions');
    expect(document.querySelector('[aria-label="Repeat task"]')).not.toBeNull();
    await enter('Event notes', 'Review the changes', true);
    await enter('Event URL', 'https://example.com/workspace');
    await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(writes).toBe(0); expect(document.querySelector('[role="alert"]')?.textContent).toContain('workspace folder');
    await enter('Event URL', 'file:///Users/example/project');
    await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(writes).toBe(1); expect(saved).toMatchObject({ title: '[task] Inspect', notes: 'Review the changes', url: 'file:///Users/example/project' });
  });
});

test('one event row exposes execution status and retained runs without duplicate task rows', async () => {
  const { calendarOccurrenceKey } = await import('../shared/calendar-task');
  const task = { ...event, title: '[task] Review', notes: 'Inspect changes', url: 'file:///Users/example/project' };
  const run = { id: 'run', scheduleId: calendarOccurrenceKey(task), workspace: '/Users/example/project', title: 'Review', plannedAt: task.start,
    kind: 'task' as const, status: 'completed' as const, mode: 'auto' as const, approvedAt: null, dismissed: true,
    startedAt: task.start, finishedAt: task.end, profileId: 'account', threadId: 'thread', turnId: 'turn', summary: 'Finished', snapshot: null };
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarEventList events={[task]} calendars={[]} searching={false} onOpen={() => {}}
      scheduler={{ auto: false, runs: [run], attention: [], schedules: [], error: '' }} day={localDay(new Date(task.start))} />);
    expect(document.querySelectorAll('[aria-label="Event list"] strong').length).toBe(1);
    expect(document.body.textContent).toContain('completed · View run');
    await render(<CalendarEventList events={[]} calendars={[]} searching={false} onOpen={() => {}}
      scheduler={{ auto: false, runs: [run], attention: [], schedules: [], error: '' }} day={localDay(new Date(task.start))} />);
    expect(document.querySelectorAll('[aria-label="Event list"] strong').length).toBe(1);
    expect(document.body.textContent).toContain('completed · View run');
  });
});
