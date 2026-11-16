import { expect, test } from 'bun:test';
import { HomieHostTool } from '../frontend/src/features/agents/HomieHostTool';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import { parseHostToolStatus, type HostToolStatus } from '../shared/host-tools';
import { withDOM } from './agent-chats-test-dom';

const base: HostToolStatus = { allowed: false, executable: '/managed/python', digest: 'previous-package', approvalDetails: 'Project: /project\nApproved package version: 1.6.6' };
const cases: { status: HostToolStatus; title: string; reason: string; action: string; readsOnly?: boolean }[] = [
  { status: { ...base, allowed: true, state: 'approved', reason: null }, title: 'Approved', reason: 'You do not need to approve each use.', action: 'View approval details', readsOnly: true },
  { status: { ...base, state: 'review-required', reason: 'package-changed' }, title: 'Review required', reason: 'package has changed', action: 'Review changes…' },
  { status: { ...base, state: 'review-required', reason: 'runtime-changed' }, title: 'Review required', reason: 'different runtime', action: 'Review changes…' },
  { status: { ...base, state: 'preparation-required', reason: 'executable-missing' }, title: 'Preparation required', reason: 'missing or cannot be accessed', action: 'Prepare runtime…' },
  { status: { ...base, state: 'preparation-required', reason: 'dependencies-unavailable' }, title: 'Preparation required', reason: 'dependencies are missing or have changed', action: 'Prepare runtime…' },
  { status: { ...base, autoApprove: true, state: 'automatic-renewal', reason: 'package-changed' }, title: 'Automatic renewal pending', reason: 'renew automatically on the next use', action: 'View approval details', readsOnly: true },
  { status: { ...base, state: 'review-required', reason: 'policy-changed' }, title: 'Review required', reason: 'no longer active', action: 'Review changes…' },
];
for (const entry of cases) test(`host access presents ${entry.status.state}/${entry.status.reason} and the correct action`, async () => {
  const calls: string[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [], onDidChange: () => () => {},
    save: async () => { throw new Error('unused'); }, hostTool: async request => { calls.push(request.action); return entry.status; } });
  try {
    await withDOM(async ui => {
      await ui.render(<HomieHostTool model={model} agentId="atlas" tool="ios_appium" saved disabled={false} onBusy={() => {}} />);
      expect(document.querySelector('[role="status"]')?.textContent).toContain(entry.title);
      expect(document.querySelector('[role="status"]')?.textContent).toContain(entry.reason);
      await ui.click(entry.action);
      if (entry.readsOnly) {
        expect(calls).toEqual(['status']);
        expect(document.querySelector('dialog pre')?.textContent).toBe(base.approvalDetails!);
        await ui.click('Close');
        expect(document.querySelector('dialog')).toBeNull();
      } else expect(calls).toEqual(['status', 'allow']);
    });
  } finally { model.dispose(); }
});

test('host status IPC preserves diagnostic fields and rejects invalid boundary values', () => {
  for (const { status } of cases) expect(parseHostToolStatus(status)).toEqual(status);
  for (const invalid of [{ allowed: 'true' }, { state: 'available' }, { reason: 'guess' }, { approvalDetails: {} }]) {
    expect(() => parseHostToolStatus({ ...base, ...invalid })).toThrow('Invalid host tool status');
  }
});
