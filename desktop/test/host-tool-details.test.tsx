import { expect, test } from 'bun:test';
import { act } from 'react';
import { HomieHostTool } from '../frontend/src/features/agents/HomieHostTool';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import type { HostToolDetailsListener } from '../shared/host-tool-details';
import { withDOM } from './agent-chats-test-dom';

test('details stay read-only and return to native review; closing or unmounting cancels', async () => {
  for (const action of ['Back to confirmation', 'Cancel', 'Close dialog', 'unmount']) {
    let listener: HostToolDetailsListener | undefined;
    const answers: boolean[] = [];
    const text = Array.from({ length: 500 }, (_, i) => `skills/tool/${i}.py`).join('\n') + '\n<script>not executable</script>';
    const model = new AgentRegistryModel({
      list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [], onDidChange: () => () => {},
      save: async () => { throw new Error('unused'); },
      onHostToolDetails: callback => { listener = callback; return () => { listener = undefined; }; },
      hostTool: async request => {
        if (request.action === 'allow') {
          const back = await listener!({ token: 'test', agentId: 'atlas', tool: 'ios_appium', text });
          answers.push(back === true);
        }
        return { allowed: false, executable: null, digest: null };
      },
    });
    try {
      await withDOM(async ui => {
        await ui.render(<HomieHostTool model={model} agentId="atlas" tool="ios_appium" saved disabled={false} onBusy={() => {}} />);
        await ui.click('Review host access…');
        expect(document.querySelector('pre')!.textContent).toBe(text);
        expect(document.querySelector('script')).toBeNull();
        expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Allow this tool')).toBe(false);
        if (action === 'unmount') await ui.render(null);
        else await ui.click(action);
        await act(async () => { await Promise.resolve(); });
        expect(answers).toEqual([action === 'Back to confirmation']);
        expect(document.querySelector('dialog')).toBeNull();
        if (action !== 'unmount') expect(document.body.textContent).toContain('Approval required');
      });
    } finally { model.dispose(); }
  }
});
