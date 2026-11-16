import { expect, test } from 'bun:test';
import { ChatStatusPanel } from '../frontend/src/features/chat/ChatStatusPanel';
import { normalizeChatCommandStatus } from '../frontend/src/features/chat/model';
import { normalizeChatStatusDetails, statusCredits, statusPlan } from '../frontend/src/features/chat/chatStatus';
import { withDOM } from './agent-chats-test-dom';

const status = () => normalizeChatCommandStatus({
  threadId: 'session-a', model: 'session-model', modelDisplayName: 'Session model', reasoningEffort: 'high',
  collaborationMode: 'plan', serviceTier: null, serviceTierDisplayName: 'Standard', supportedReasoningEfforts: [],
  fastModeAvailable: false, fastModeEnabled: false, access: 'Approve for me', responseInProgress: true,
  details: { version: '0.163.0', server: 'Local app server', provider: 'openai', directory: '/workspace/project',
    permissionProfile: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
    instructionFiles: ['/workspace/project/AGENTS.md'], instructionNote: 'Files found on disk; loaded state is not reported.',
    account: 'test@example.com', plan: 'pro', warnings: [],
    usage: { state: 'ready', authenticated: true, plan: 'pro', error: null,
      rateLimits: [{ limitId: 'codex', limitName: null, plan: 'pro', primary: null,
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1792906140 },
        credits: { balance: '62500', hasCredits: true, unlimited: false } }] },
  },
});

test('status keeps session and credit details while excluding usage limit rows', async () => {
  await withDOM(async ui => {
    await ui.render(<ChatStatusPanel status={status()} />);
    const rows = [...document.querySelectorAll('dl > div')].map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]);
    for (const pair of [['Codex', 'OpenAI Codex v0.163.0'], ['Server', 'Local app server'], ['Model', 'Session model'],
      ['Reasoning', 'high'], ['Model provider', 'openai'], ['Directory', '/workspace/project'],
      ['Permissions', ':workspace · Approve for me'], ['Account', 'test@example.com'], ['Plan', 'Pro 200'],
      ['Collaboration mode', 'Plan'], ['Session', 'session-a'], ['Service tier', 'Standard'], ['Response', 'In progress'],
      ['Credits', '62500 credits']]) expect(rows).toContainEqual(pair);
    expect(rows.find(row => row[0] === 'AGENTS.md')?.[1]).toContain('/workspace/project/AGENTS.md');
    expect(rows.some(row => row[0]?.includes('limit'))).toBe(false);
    expect(document.querySelector('meter')).toBeNull();
    expect(document.querySelector('a')?.href).toBe('https://chatgpt.com/settings/usage');
  });
});

test('unknown usage and runtime fields stay unknown, without hiding known account information', async () => {
  await withDOM(async ui => {
    const current = status();
    current.details = { ...current.details!, usage: null, version: null, warnings: ['Usage details unavailable.'] };
    await ui.render(<ChatStatusPanel status={current} />);
    expect(document.body.textContent).toContain('Version not reported');
    expect(document.body.textContent).toContain('Pro 200');
    expect(document.body.textContent).toContain('Usage details unavailable.');
    expect(document.body.textContent).not.toContain('0%');
    expect(document.querySelector('meter')).toBeNull();
  });
});

test('status formats integer credits without rounding up and preserves unknown or unlimited balances', () => {
  expect(statusCredits({ balance: '0', hasCredits: false, unlimited: false })).toBe('0 credits');
  expect(statusCredits({ balance: '62500.000000000', hasCredits: true, unlimited: false })).toBe('62500 credits');
  expect(statusCredits({ balance: '123456789123456789.1250', hasCredits: true, unlimited: false })).toBe('123456789123456789 credits');
  expect(statusCredits({ balance: null, hasCredits: true, unlimited: true })).toBe('Unlimited');
  expect(statusCredits({ balance: '0.999', hasCredits: true, unlimited: false })).toBe('0 credits');
  expect(statusCredits(undefined)).toBe('Not reported');
  expect(normalizeChatStatusDetails({ instructionFiles: ['ok', 1], usage: { authenticated: 'true' } })?.instructionFiles).toBeNull();
});

test('status uses the terminal subscription labels for API plan names', () => {
  for (const [plan, label] of [['pro', 'Pro 200'], ['prolite', 'Pro 100'], ['promax', 'Pro 500'], ['team', 'Business'], ['business', 'Enterprise']] as const) {
    expect(statusPlan(plan)).toBe(label);
  }
  expect(statusPlan(null)).toBe('Plan not reported');
  expect(statusPlan('future_plan')).toBe('Future Plan');
});
