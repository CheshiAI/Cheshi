import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { CalendarBrowser } from '../frontend/src/features/calendar/CalendarView';
import { CalendarEventDialog } from '../frontend/src/features/calendar/CalendarEventDialog';
import { calendarApiFixture, calendarEventFixture as event } from './apple-calendar-fixtures';
import { calendarFailure } from '../shared/apple-calendar';

async function withCalendarDOM(run: (render: (node: ReactNode) => Promise<void>, document: Document) => Promise<void>) {
  const window = new Window();
  const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
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
    const connect = [...document.querySelectorAll('button')].find(button => button.textContent === 'Apple 캘린더 연결');
    expect(connect).toBeDefined();
    await act(async () => connect!.click());
    expect(connects).toBe(1); expect(queries).toHaveLength(1);
    expect(document.querySelectorAll('button[aria-pressed]')).toHaveLength(43);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="새 일정"]')?.disabled).toBe(true);
    expect(document.querySelector('select')?.textContent).toContain('읽기 전용');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="다음 달"]')!.click());
    expect(queries).toHaveLength(2); expect(queries[0]).not.toBe(queries[1]);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="캘린더 새로고침"]')!.click());
    expect(queries).toHaveLength(3); expect(queries[1]).toBe(queries[2]);
  });
});

test('deleting an event requires confirmation and closes only after acknowledgement', async () => {
  let deleted = 0;
  let saved = 0;
  const api = calendarApiFixture({ delete: async target => { ++deleted; return { ok: true, value: target }; } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarEventDialog api={api} event={event} day="2026-09-22" calendarId="calendar-1"
      calendars={[{ id: 'calendar-1', title: 'Work', source: 'iCloud', writable: true, isDefault: true }]}
      onClose={() => {}} onSaved={() => { ++saved; }} />);
    const button = (label: string) => [...document.querySelectorAll('button')].find(button => button.textContent === label)!;
    await act(async () => button('삭제').click());
    expect(deleted).toBe(0);
    expect(document.body.textContent).toContain('이 일정을 Apple 캘린더에서 삭제할까요?');
    await act(async () => button('취소').click());
    expect(deleted).toBe(0);
    await act(async () => button('삭제').click());
    await act(async () => button('삭제').click());
    expect(deleted).toBe(1); expect(saved).toBe(1);
  });
});

test('recurring events expose their details with no save or delete actions', async () => {
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarEventDialog api={calendarApiFixture()} event={{ ...event, recurring: true, readOnly: true }}
      day="2026-09-22" calendarId="calendar-1" calendars={[]} onClose={() => {}} onSaved={() => {}} />);
    expect(document.querySelector<HTMLInputElement>('[aria-label="일정 제목"]')?.disabled).toBe(true);
    const labels = [...document.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).not.toContain('저장'); expect(labels).not.toContain('삭제');
    expect(document.body.textContent).toContain('반복 일정');
  });
});

test('event load failure does not claim an empty agenda and refreshing can recover', async () => {
  let failing = true;
  const api = calendarApiFixture({ events: async () => failing ? calendarFailure('unavailable') : { ok: true, value: [] } });
  await withCalendarDOM(async (render, document) => {
    await render(<CalendarBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('일정을 불러오지 못했습니다.');
    expect(document.body.textContent).not.toContain('일정이 없습니다.');
    expect(document.querySelector('[aria-label$="일정 0개"]')).toBeNull();
    expect(document.querySelector('select')?.textContent).toContain('Work');
    failing = false;
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="캘린더 새로고침"]')!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('일정이 없습니다.');
  });
});
