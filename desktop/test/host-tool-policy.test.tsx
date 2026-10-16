import { expect, test } from 'bun:test';
import { HomieHostToolPolicy } from '../frontend/src/features/agents/HomieHostToolPolicy';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import type { HostToolRequest } from '../shared/host-tools';
import { withDOM } from './agent-chats-test-dom';

test('automatic approval settings persist on toggle, show failures and cannot change unsaved assignments', async () => {
  let enabled = false, fail = false, changes = 0;
  const requests: HostToolRequest[] = [], busy: boolean[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [],
    onDidChange: () => () => {}, save: async () => { throw new Error('unused'); }, hostTool: async request => {
      requests.push(request);
      if (request.action === 'policy' && request.autoApprove !== undefined) {
        if (fail) throw new Error('Could not save policy');
        enabled = request.autoApprove;
      }
      return { allowed: false, executable: null, digest: null, autoApprove: enabled };
    } });
  const component = (saved: boolean) => <HomieHostToolPolicy model={model} agentId="atlas" tool="ios_appium" saved={saved}
    disabled={false} onBusy={value => busy.push(value)} onChanged={() => { changes++; }} />;
  try {
    await withDOM(async ui => {
      await ui.render(component(false));
      expect(document.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
      expect(requests).toEqual([]);
      await ui.render(component(true));
      expect(document.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
      await ui.click('Automatically approve local tools');
      expect(enabled).toBe(true); expect(changes).toBe(1);
      expect(document.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
      expect(requests.at(-1)).toEqual({ action: 'policy', agentId: 'atlas', tool: 'ios_appium', autoApprove: true });
      fail = true;
      await ui.click('Automatically approve local tools');
      expect(document.querySelector('[role="alert"]')!.textContent).toContain('Could not save');
      expect(document.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    });
    await withDOM(async ui => {
      await ui.render(component(true));
      expect(document.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
      fail = false;
      await ui.click('Automatically approve local tools');
      expect(enabled).toBe(false); expect(changes).toBe(2);
    });
    expect(busy).toEqual([true, false, true, false, true, false]);
  } finally { model.dispose(); }
});
