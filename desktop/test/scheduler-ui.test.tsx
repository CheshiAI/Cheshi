import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useRef, type ReactNode } from 'react';
import type { SchedulerApi, SchedulerSnapshot, ScheduleRun, SchedulerAction } from '../shared/scheduler';
import { SchedulerNotifications } from '../frontend/src/features/scheduler/SchedulerNotifications';
import { ScheduleDialog } from '../frontend/src/features/scheduler/ScheduleDialog';
import { CalendarSchedulerOptions } from '../frontend/src/features/calendar/CalendarSchedulerOptions';
import { RegionalBlur } from '../frontend/src/shared/ui/RegionalBlur';
import { SchedulerSettings } from '../frontend/src/features/settings/SchedulerSettings';
import { createChatSessionCache, type ChatSessionCache } from '../frontend/src/features/chat/chatSessionCache';
import type { ChatSession } from '../frontend/src/features/chat/model';
import { useSchedulerSessionSync } from '../frontend/src/features/scheduler/useSchedulerSessionSync';
import { createSchedulerModel } from '../frontend/src/features/scheduler/useScheduler';
import { createSchedulerDeferred } from './scheduler-test-clock';

mock.module('../frontend/src/shared/ui/DismissibleToast.module.css', () => ({
  default: { popupAnchor: 'popupAnchor', anchorLeft: 'anchorLeft', anchorTopRight: 'anchorTopRight' },
}));

async function withDOM(run: (render: (node: ReactNode) => Promise<void>, document: Document) => Promise<void>) {
  const window = new Window();
  const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    CustomEvent: window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = globalThis.document.createElement('div'); globalThis.document.body.append(container);
  const root = createRoot(container);
  try { await run(async node => { await act(async () => root.render(node)); }, globalThis.document); }
  finally {
    await act(async () => root.unmount()); await window.happyDOM.abort();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
function fixture() {
  const actions: SchedulerAction[] = [];
  const run: ScheduleRun = { id: 'run', scheduleId: 'schedule:1', workspace: '/workspace', title: 'Review task', kind: 'task',
    plannedAt: new Date(Date.now() + 300_000).toISOString(), startedAt: null, finishedAt: null, status: 'pending', mode: 'manual',
    approvedAt: null, dismissed: false, summary: '', profileId: null, threadId: null, turnId: null, snapshot: null };
  let state: SchedulerSnapshot = { auto: false, schedules: [], runs: [run], attention: [], error: '' };
  const listeners = new Set<() => void>();
  const api: SchedulerApi = { onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, async read() { return state; }, async save(input) { return { ...input, id: 'new', revision: 1, workspace: '/workspace', nextAt: input.startAt }; },
    async remove() {}, async setAuto() {}, async act(_id, action) { actions.push(action); state = { ...state, runs: [{ ...run, dismissed: true }] }; },
    async respondApproval() {}, async respondInput() {} };
  return { api, actions, run, listeners, setState(value: SchedulerSnapshot) { state = value; listeners.forEach(listener => listener()); } };
}
function button(document: Document, label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing button: ${label}`); return found;
}
test('manual confirmation explicitly approves, while closing never does', async () => {
  await withDOM(async (render, document) => {
    const one = fixture(); await render(<SchedulerNotifications api={one.api} onOpenThread={() => {}} />);
    expect(document.body.textContent).toContain('Approve for scheduled time');
    await act(async () => button(document, 'Close notification').click());
    expect(one.actions).toEqual(['dismiss']);
    const two = fixture(); await render(<SchedulerNotifications api={two.api} onOpenThread={() => {}} />);
    await act(async () => button(document, 'Approve for scheduled time').click());
    expect(two.actions).toEqual(['approve']);
  });
});
test('auto shows an informational notification; ordinary events offer acknowledgement only', async () => {
  await withDOM(async (render, document) => {
    const one = fixture(); one.setState({ auto: true, schedules: [], runs: [{ ...one.run, mode: 'auto' }], attention: [], error: '' });
    await render(<SchedulerNotifications api={one.api} onOpenThread={() => {}} />);
    expect(document.body.textContent).toContain('will run automatically');
    expect(document.body.textContent).not.toContain('Approve for scheduled time');
    const two = fixture(); two.setState({ auto: false, schedules: [], runs: [{ ...two.run, kind: 'event' }], attention: [], error: '' });
    await render(<SchedulerNotifications api={two.api} onOpenThread={() => {}} />);
    expect(document.body.textContent).not.toContain('Approve for scheduled time');
    await act(async () => button(document, 'Got it').click()); expect(two.actions).toEqual(['acknowledge']);
  });
});
test('new task requires an explicit prompt and defaults to read-only permissions', async () => {
  await withDOM(async (render, document) => {
    const { api } = fixture(); const saved: unknown[] = [];
    api.save = async input => { saved.push(input); return { ...input, id: 'task', revision: 1, workspace: '/workspace', nextAt: input.startAt }; };
    await render(<ScheduleDialog api={api} schedule={null} onClose={() => {}} onSaved={() => {}} />);
    expect(button(document, 'Save task').disabled).toBe(true);
    const inputs = [...document.querySelectorAll('input,textarea')];
    const title = inputs.find(element => element.tagName === 'INPUT' && element.getAttribute('required') !== null)!;
    const prompt = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'Morning report');
      title.dispatchEvent(new window.Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Summarize the workspace changes.');
      prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => button(document, 'Save task').click());
    expect(saved[0]).toMatchObject({ title: 'Morning report', prompt: 'Summarize the workspace changes.', permissionMode: 'read-only', threadId: null, repeat: 'once' });
  });
});
test('calendar options preserve legacy editing and explicit migration without separate task tabs', async () => {
  await withDOM(async (render, document) => {
    const time = new Date(Date.now() + 3_600_000);
    const schedule = { id: 'task', revision: 1, workspace: '/workspace', title: 'Future report', prompt: 'Summarize changes',
      startAt: time.toISOString(), nextAt: time.toISOString(), timeZone: 'Asia/Seoul', repeat: 'once' as const, enabled: true,
      threadId: null, permissionMode: 'read-only' as const, model: null, effort: 'medium' };
    let edited = ''; let migrated = ''; const { api } = fixture();
    api.migrate = async id => { migrated = id; };
    await render(<CalendarSchedulerOptions api={api} refresh={async () => {}} calendarId="calendar" state={{ auto: false, schedules: [schedule], runs: [], attention: [], error: '' }}
      onEdit={value => { edited = value.id; }} />);
    expect(document.body.textContent).toContain('Future report');
    expect(document.body.textContent).not.toContain('New task');
    expect(document.querySelector('[role="switch"]')).toBeNull();
    await act(async () => button(document, 'Edit existing task').click()); expect(edited).toBe('task');
    await act(async () => button(document, 'Move to Apple Calendar').click()); expect(migrated).toBe('task');
  });
});

test('push updates reach mounted notifications without a polling tick', async () => {
  await withDOM(async (render, document) => {
    const value = fixture(); value.setState({ auto: false, schedules: [], runs: [], attention: [], error: '' });
    await render(<SchedulerNotifications api={value.api} onOpenThread={() => {}} />);
    expect(document.body.textContent).not.toContain('Review task');
    await act(async () => value.setState({ auto: false, schedules: [], runs: [value.run], attention: [], error: '' }));
    expect(document.body.textContent).toContain('Review task');
    await render(null); expect(value.listeners.size).toBe(0);
  });
});
test('a push during a pending snapshot forces a fresh read and prevents stale state from publishing', async () => {
  const value = fixture(); const stale = createSchedulerDeferred<SchedulerSnapshot>();
  const latest: SchedulerSnapshot = { auto: true, schedules: [], runs: [], attention: [], error: '' };
  let reads = 0;
  value.api.read = async () => ++reads === 1 ? stale.promise : latest;
  const model = createSchedulerModel(value.api); const published: boolean[] = [];
  const remove = model.subscribe(() => published.push(model.getSnapshot().auto));
  value.listeners.forEach(listener => listener()); value.listeners.forEach(listener => listener());
  stale.resolve({ ...latest, auto: false });
  await model.refresh();
  expect(reads).toBe(2); expect(published).toEqual([true]);
  remove(); expect(value.listeners.size).toBe(0);
});
test('unsubscribe discards the old read and resubscription fetches the current snapshot', async () => {
  const value = fixture(); const gate = createSchedulerDeferred<SchedulerSnapshot>();
  const next: SchedulerSnapshot = { auto: true, schedules: [], runs: [], attention: [], error: '' }; let reads = 0;
  value.api.read = async () => ++reads === 1 ? gate.promise : next;
  const model = createSchedulerModel(value.api); const first = model.subscribe(() => {}); first();
  const second = model.subscribe(() => {});
  gate.resolve({ ...next, error: 'Old response' }); await model.refresh();
  expect(model.getSnapshot()).toEqual(next); expect(reads).toBe(2); second();
});


test('launch at login changes only through the explicit option toggle', async () => {
  await withDOM(async (render, document) => {
    const { api } = fixture(); const changes: boolean[] = []; let enabled = false;
    api.startup = async () => ({ enabled, available: true });
    api.setStartup = async value => { enabled = value; changes.push(value); };
    await render(<SchedulerSettings api={api} />);
    expect(changes).toEqual([]);
    await act(async () => button(document, 'Launch Cheshi at login').click());
    expect(changes).toEqual([true]);
    expect(button(document, 'Launch Cheshi at login').getAttribute('aria-checked')).toBe('true');
  });
});

test('scheduler settings read existing auto state and follow shared changes without resetting preferences', async () => {
  await withDOM(async (render, document) => {
    const value = fixture(); const writes: boolean[] = [];
    const snapshot: SchedulerSnapshot = { auto: true, schedules: [], runs: [], attention: [], error: '' };
    value.setState(snapshot);
    value.api.setAuto = async enabled => { writes.push(enabled); value.setState({ ...snapshot, auto: enabled }); };
    await render(<SchedulerSettings api={value.api} />);
    const toggle = () => button(document, 'Automatically run scheduled tasks');
    expect(toggle().getAttribute('aria-checked')).toBe('true'); expect(writes).toEqual([]);
    await act(async () => toggle().click()); expect(writes).toEqual([false]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    await act(async () => value.setState(snapshot)); expect(toggle().getAttribute('aria-checked')).toBe('true');
    await render(null); expect(value.listeners.size).toBe(0);
  });
});

test('scheduler settings guard pending writes and keep the saved value when saving fails', async () => {
  await withDOM(async (render, document) => {
    const { api } = fixture(); const gate = createSchedulerDeferred<void>(); let writes = 0;
    api.startup = async () => ({ enabled: false, available: false });
    api.setAuto = async () => { writes++; await gate.promise; throw new Error('Could not save Auto'); };
    await render(<SchedulerSettings api={api} />);
    expect(button(document, 'Launch Cheshi at login').disabled).toBe(true);
    await act(async () => button(document, 'Automatically run scheduled tasks').click());
    expect(button(document, 'Automatically run scheduled tasks').disabled).toBe(true);
    await act(async () => button(document, 'Automatically run scheduled tasks').click());
    expect(writes).toBe(1);
    await act(async () => gate.resolve());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save Auto');
    expect(button(document, 'Automatically run scheduled tasks').getAttribute('aria-checked')).toBe('false');
  });
});

test('calendar options render no empty controls block after settings move', async () => {
  await withDOM(async (render, document) => {
    const { api } = fixture(); let reads = 0;
    api.startup = async () => { reads++; return { enabled: true, available: true }; };
    await render(<CalendarSchedulerOptions api={api} state={{ auto: true, schedules: [], runs: [], attention: [], error: '' }}
      refresh={async () => {}} onEdit={() => {}} />);
    expect(document.body.textContent).toBe(''); expect(reads).toBe(0);
  });
});

test('position settings immediately update mounted notifications and retain the saved value on failure', async () => {
  await withDOM(async (render, document) => {
    const value = fixture();
    const snapshot: SchedulerSnapshot = { auto: false, schedules: [], runs: [value.run], attention: [], error: '', notificationPosition: 'bottom-left' };
    value.setState(snapshot);
    value.api.setNotificationPosition = async position => { snapshot.notificationPosition = position; value.setState({ ...snapshot }); };
    const views = <><SchedulerSettings api={value.api} /><SchedulerNotifications api={value.api} onOpenThread={() => {}} /></>;
    await render(views);
    await act(async () => button(document, 'Scheduler notification position').click());
    await act(async () => button(document, 'Top right').click());
    expect(button(document, 'Scheduler notification position').textContent).toContain('Top right');
    const anchor = () => document.querySelector('[aria-label="Close notification"]')!.closest('aside')!.parentElement!;
    expect(anchor().className).toContain('anchorTopRight');
    expect(value.actions).toEqual([]);
    await render(null); await render(views);
    expect(button(document, 'Scheduler notification position').textContent).toContain('Top right');
    value.api.setNotificationPosition = async () => { throw new Error('Position could not be saved'); };
    await act(async () => button(document, 'Scheduler notification position').click());
    await act(async () => button(document, 'Bottom right').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Position could not be saved');
    expect(button(document, 'Scheduler notification position').textContent).toContain('Top right');
    expect(anchor().className).toContain('anchorTopRight');
  });
});

function NotificationScene({ api }: { api: SchedulerApi }) {
  const sourceRef = useRef<HTMLDivElement>(null);
  return <><div ref={sourceRef} data-notification-scene>Calendar and workspace content</div>
    <RegionalBlur sourceRef={sourceRef}><SchedulerNotifications api={api} onOpenThread={() => {}} /></RegionalBlur>
  </>;
}

test('scheduler notification portals register with the shared SVG source and release blur on dismissal', async () => {
  await withDOM(async (render, document) => {
    const value = fixture(); await render(<NotificationScene api={value.api} />);
    const source = document.querySelector<HTMLElement>('[data-notification-scene]')!;
    const surface = document.querySelector<HTMLElement>('aside')!;
    expect(source.contains(surface)).toBe(false);
    expect(surface.getAttribute('data-regional-blur-surface')).toBe('true');
    const rect = { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 500, width: 600, height: 500, toJSON() { return {}; } };
    Object.defineProperties(source, { offsetWidth: { value: 600 }, offsetHeight: { value: 500 }, getBoundingClientRect: { value: () => rect } });
    Object.defineProperties(surface, { getBoundingClientRect: { value: () => ({ ...rect, width: 300, height: 200 }) }, getClientRects: { value: () => [rect] } });
    surface.style.visibility = 'visible'; surface.style.opacity = '1'; surface.style.borderRadius = '12px';
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'));
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    });
    expect(source.style.filter).toContain('url(');
    expect(surface.style.filter).toBe('');
    expect(document.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    await act(async () => button(document, 'Close notification').click());
    expect(source.style.filter).toBe('');
    expect(document.querySelector('feImage')?.hasAttribute('href')).toBe(false);
    expect(value.actions).toEqual(['dismiss']);
  });
});

function SessionSync({ cache, api, load }: { cache: ChatSessionCache; api: SchedulerApi; load(): Promise<ChatSession[]> }) {
  useSchedulerSessionSync(cache, api, load);
  return null;
}

test('background run changes refresh the shared session list immediately, without polling or preference-triggered reads', async () => {
  await withDOM(async render => {
    const value = fixture(); const cache = createChatSessionCache(); let reads = 0;
    const load = async (): Promise<ChatSession[]> => { reads++; return [{ id: 'background-thread', title: 'Scheduled result', updatedAt: reads }]; };
    const snapshot: SchedulerSnapshot = { auto: false, schedules: [], runs: [value.run], attention: [], error: '' };
    value.setState(snapshot);
    await render(<SessionSync cache={cache} api={value.api} load={load} />);
    expect(reads).toBe(0);
    const running = { ...value.run, threadId: 'background-thread', status: 'running' as const };
    await act(async () => value.setState({ ...snapshot, runs: [running] }));
    expect(reads).toBe(1); expect(cache.getSnapshot().sessions[0]?.id).toBe('background-thread');
    await act(async () => value.setState({ ...snapshot, auto: true, notificationPosition: 'top-right', runs: [running] }));
    expect(reads).toBe(1);
    const completed = { ...running, status: 'completed' as const, finishedAt: new Date().toISOString() };
    await act(async () => value.setState({ ...snapshot, runs: [completed] }));
    expect(reads).toBe(2); expect(cache.getSnapshot().sessions[0]?.updatedAt).toBe(2);
    const replacementCache = createChatSessionCache();
    await render(<SessionSync cache={replacementCache} api={value.api} load={load} />);
    expect(reads).toBe(3); expect(replacementCache.getSnapshot().sessions[0]?.id).toBe('background-thread');
    await render(null); expect(value.listeners.size).toBe(0);
  });
});

test('completion during a pending session load invalidates the stale response', async () => {
  await withDOM(async render => {
    const value = fixture(); const cache = createChatSessionCache();
    const gate = createSchedulerDeferred<ChatSession[]>(); let reads = 0;
    const load = async (): Promise<ChatSession[]> => ++reads === 1 ? gate.promise : [{ id: 'background-thread', title: 'Completed result', updatedAt: 2 }];
    const run = { ...value.run, threadId: 'background-thread', status: 'running' as const };
    const state: SchedulerSnapshot = { auto: false, schedules: [], runs: [run], attention: [], error: '' };
    value.setState(state);
    await render(<SessionSync cache={cache} api={value.api} load={load} />);
    await act(async () => value.setState({ ...state, runs: [{ ...run, status: 'completed', finishedAt: new Date().toISOString() }] }));
    await act(async () => gate.resolve([{ id: 'background-thread', title: 'Old result', updatedAt: 1 }]));
    expect(reads).toBe(2); expect(cache.getSnapshot().sessions[0]?.title).toBe('Completed result');
  });
});
