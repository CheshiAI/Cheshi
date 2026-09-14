import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatAgentStatus } from '../frontend/src/features/chat/ChatAgentStatus';

const explanation = 'Thread loading and runtime state. This does not indicate whether the agent task is complete.';

function render(status: string, current = false) {
  return renderToStaticMarkup(<ChatAgentStatus status={status} current={current} />);
}

test('labels known loading and runtime states as thread states', () => {
  for (const [status, label] of [
    ['notLoaded', 'Not loaded'], ['idle', 'Idle'], ['active', 'Active'],
  ] as const) {
    const html = render(status);
    expect(html).toContain(`Thread: ${label}`);
    expect(html).not.toContain('Current');
  }
});

test('labels a system error without presenting it as an agent task failure', () => {
  const html = render('systemError');
  expect(html).toContain('Thread: Error');
  expect(html).not.toContain('Failed');
});

test('normalizes unknown and unsupported future states without exposing their raw names', () => {
  for (const status of ['unknown', 'futureRuntimeState', '']) {
    const html = render(status);
    expect(html).toContain('Thread: Unknown');
    expect(html).not.toContain('futureRuntimeState');
  }
});

test('keeps the thread state visible alongside the current agent indicator', () => {
  for (const [status, label] of [
    ['notLoaded', 'Not loaded'], ['idle', 'Idle'], ['active', 'Active'],
    ['systemError', 'Error'], ['unknown', 'Unknown'],
  ] as const) {
    const html = render(status, true);
    expect(html).toContain('Current');
    expect(html).toContain(`Thread: ${label}`);
  }
});

test('always explains that thread state does not report task completion', () => {
  for (const status of ['notLoaded', 'idle', 'active', 'systemError', 'unknown', 'futureRuntimeState']) {
    for (const current of [false, true]) {
      expect(render(status, current)).toContain(`title="${explanation}"`);
    }
  }
});

test('does not infer completed or failed task outcomes from any thread state', () => {
  for (const status of ['notLoaded', 'idle', 'active', 'systemError', 'unknown', 'completed', 'failed']) {
    const html = render(status);
    expect(html).not.toMatch(/>[^<]*\b(?:Completed|Failed)\b[^<]*</);
  }
});
