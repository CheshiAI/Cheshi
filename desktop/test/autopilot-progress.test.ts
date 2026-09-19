import { expect, test } from 'bun:test';
import { AutopilotProgress } from '../lib/autopilot-progress.mts';
import { AutopilotPageChangedError, createAutopilotRunner } from '../lib/autopilot-runner.mts';
import { createAutopilotTextResolver, parseAutopilotFieldText } from '../lib/autopilot-field-text.mts';
import { createAutopilotCodex } from '../lib/autopilot-codex.mts';
import type { ResearchSession } from '../lib/autopilot-codex.mts';
import type { AutopilotDecisionInput, AutopilotPage } from '../lib/autopilot-model.mts';
import type { AutopilotInteraction } from '../lib/autopilot-actions.mts';
import { autopilotActions } from '../lib/autopilot-actions.mts';

const field = { id: 'control_1', signature: 'destination', identity: 'trip/destination',
  kind: 'input' as const, label: 'Destination', value: '', search: false };
const page: AutopilotPage = { url: 'https://example.org/', title: 'Trip', text: 'Choose origin and destination', links: [], controls: [field] };
const action: AutopilotInteraction = { kind: 'fill', control: field, text: '서울' };
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function sessionFixture(overrides: Partial<ResearchSession>): ResearchSession {
  return { model: 'chosen', close() {}, plan: async () => { throw new Error('Unexpected planning'); },
    report: async () => { throw new Error('Unexpected report'); }, ...overrides };
}
const signal = () => new AbortController().signal;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function rejects(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test('an executed action remains blocked when observation fails, including misleading stale errors', async () => {
  const progress = new AutopilotProgress();
  let sent = 0;
  await rejects(progress.interact(page, action, signal(), async dispatched => {
    dispatched(); sent++;
    expect(progress.outcomes[0]!.status).toBe('dispatched');
    throw new AutopilotPageChangedError(page);
  }), 'will not be repeated');
  expect(progress.outcomes[0]!.status).toBe('unconfirmed');
  await rejects(progress.interact(page, action, signal(), async () => { sent++; return page; }), 'already attempted');
  expect(sent).toBe(1);
});

test('a pre-execution stale target can be reconsidered without losing prior outcomes', async () => {
  const progress = new AutopilotProgress();
  await rejects(progress.interact(page, action, signal(), async () => { throw new AutopilotPageChangedError(page); }), 'page changed');
  expect(progress.completedInteractions).toEqual([]);
  await progress.interact(page, action, signal(), async dispatched => { dispatched(); return { ...page, text: 'Changed' }; });
  expect(progress.outcomes.map(entry => entry.status)).toEqual(['stale', 'verified']);
  expect(progress.outcomes[1]!.pageChanged).toBe(true);
});

test('a covered target is excluded on the same page state and becomes eligible after the overlay changes', async () => {
  const progress = new AutopilotProgress();
  await rejects(progress.interact(page, action, signal(), async () => { throw new AutopilotPageChangedError(page, 'unavailable'); }), 'covered');
  expect(progress.outcomes[0]!.status).toBe('unavailable');
  expect(progress.completedInteractions).toEqual([]);
  expect(progress.excludedInteractions(page)).toHaveLength(2);
  expect(autopilotActions(page, [], '', progress.excludedInteractions(page), true)).toEqual([]);
  const changed = { ...page, text: 'Overlay dismissed' };
  expect(progress.excludedInteractions(changed)).toEqual([]);
  await progress.interact(changed, action, signal(), async dispatched => { dispatched(); return changed; });
  expect(progress.outcomes[1]!.status).toBe('verified');
});

test('runner chooses an alternative after a covered target instead of retrying it as a changed page', async () => {
  const button = { id: 'control_2', kind: 'button' as const, label: 'Covered menu', value: '', signature: 'menu' };
  const link = { id: 'link_0', label: 'Article', url: 'https://example.org/article' };
  const current = { ...page, controls: [button], links: [link] };
  let clicks = 0, followed = 0;
  const runner = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {}, load: async () => current,
    decide: async input => ({ completed: input.page.url === link.url, confidence: 1,
      link: input.completedInteractions?.length ? link : null,
      ...(!input.completedInteractions?.length ? { interaction: { kind: 'click' as const, control: button } } : {}) }),
    interact: async () => { clicks++; throw new AutopilotPageChangedError(current, 'unavailable'); },
    follow: async () => { followed++; return { ...current, url: link.url }; } });
  try {
    runner.start({ url: current.url, goal: 'Article', searchText: 'article' }); await flush();
    expect(clicks).toBe(1);
    expect(followed).toBe(1);
    expect(runner.snapshot().phase).toBe('completed');
  } finally { runner.dispose(); }
});

test('an already satisfied generated value is recorded without typing and excluded from later choices', async () => {
  const progress = new AutopilotProgress();
  const populated = { ...page, controls: [{ ...field, value: action.text }] };
  let sent = 0;
  await progress.interact(populated, { ...action, control: populated.controls[0]! }, signal(), async () => { sent++; return populated; });
  expect(sent).toBe(0);
  expect(progress.outcomes[0]!.action).toBe('Already set: Destination');
  expect(autopilotActions(populated, [], '', progress.completedInteractions, true)).toEqual([]);
});

test('field values are generated only for the selected observed target, cached per context and never invented', async () => {
  let calls = 0, closed = 0;
  const session = sessionFixture({ fieldText: async (context: { field: { label: string }; goal: string }) => {
    calls++;
    expect(context.field.label).toBe('Destination');
    expect(context.goal).toContain('서울');
    return '서울';
  }, close() { closed++; } });
  const resolver = createAutopilotTextResolver({ open: async () => session }, 'pane');
  const input: AutopilotDecisionInput = { page, goal: '부산에서 서울로', visited: [], signal: signal(), searchText: 'entire query' };
  const decision = { link: null, completed: false, confidence: 1, interaction: { ...action, text: '' } };
  const resolved = await resolver.resolve(decision, input);
  expect(resolved.interaction).toEqual(action);
  await resolver.resolve(decision, input);
  expect(calls).toBe(1);
  await resolver.resolve(decision, { ...input, page: { ...page, text: 'Updated trip form' } });
  expect(calls).toBe(2);
  await rejects(resolver.resolve({ ...decision, interaction: { ...action, control: { ...field, id: 'control_99' } } }, input), 'no longer available');
  resolver.close();
  expect(closed).toBe(1);
  for (const value of [{ text: null }, { text: 3 }, { text: '' }, { text: 'x', command: 'click' }, { text: 'x'.repeat(2001) }]) {
    expect(() => parseAutopilotFieldText(value)).toThrow();
  }
});

test('normal navigation retains context ID and closes its lazy Codex session after input', async () => {
  let closed = 0, filled = '';
  const session = sessionFixture({ fieldText: async () => '서울', close: () => { closed++; } });
  const runner = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {},
    research: { open: async context => { expect(context).toBe('active-pane'); return session; } },
    load: async () => page, follow: async () => page,
    decide: async input => {
      expect(input.fieldTextAvailable).toBe(true);
      return { link: null, confidence: 1, completed: !!filled, interaction: { ...action, text: '' } };
    },
    interact: async (current, selected, _signal, dispatched) => {
      dispatched?.();
      filled = selected.kind === 'fill' ? selected.text : '';
      return { ...current, controls: [{ ...field, value: filled }] };
    },
  });
  try {
    runner.start({ url: page.url, goal: '부산에서 서울로', contextId: 'active-pane' });
    await flush();
    expect(runner.snapshot().phase).toBe('completed');
    expect(filled).toBe('서울');
    expect(closed).toBe(1);
  } finally { runner.dispose(); }
});

test('the Codex bridge validates generated text and cancels the matching request', async () => {
  const pending = createDeferred<{ text: string; model: string }>();
  let requestId = '', cancelled = '';
  const bridge = createAutopilotCodex({ configuration: async () => ({ model: 'chosen', effort: 'low' }),
    session: () => ({ run: async (request: unknown) => { requestId = String((request as Record<string, unknown>).requestId); return pending.promise; }, cancel: id => { cancelled = id; return true; } }),
  });
  const controller = new AbortController();
  const session = await bridge.open('pane', controller.signal);
  const result = session.fieldText!({ goal: 'Go to 서울', url: page.url, title: page.title, text: '', history: [],
    field: { identity: 'destination', label: 'Destination', role: 'textbox', value: '', context: '' } }, controller.signal);
  controller.abort();
  pending.resolve({ text: '{"text":"서울"}', model: 'chosen' });
  await rejects(result, 'abort');
  expect(cancelled).toBe(requestId);
  session.close();
  expect(bridge.busy).toBe(false);
});
