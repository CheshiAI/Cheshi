import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { HomieCustomTools } from '../frontend/src/features/agents/HomieCustomTools';
import { HomieHostTool } from '../frontend/src/features/agents/HomieHostTool';
import { importHomieTool } from '../frontend/src/features/agents/customToolImport';
import { externalToolFixture } from './homie-tool-fixture';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';
import { parseAgentPackage, type AgentPackage } from '../shared/agent-package';
import type { ToolTestRequest, ToolCredentialRequest } from '../shared/homie-tools';
import { withDOM } from './agent-chats-test-dom';

test('host approval is a separate local review action and unsaved tools cannot request it', async () => {
  const requests: string[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [], onDidChange: () => () => {},
    save: async () => { throw new Error('unused'); }, hostTool: async request => {
      requests.push(request.action); return { allowed: request.action === 'allow', executable: request.action === 'allow' ? '/local/runtime' : null, digest: null };
    } });
  try {
    await withDOM(async ui => {
      await ui.render(<HomieHostTool model={model} agentId="fixture" tool="fixture" saved={false} disabled={false} onBusy={() => {}} />);
      expect(requests).toEqual([]);
      expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Review host access…')!.disabled).toBe(true);
    });
    await withDOM(async ui => {
      await ui.render(<HomieHostTool model={model} agentId="fixture" tool="fixture" saved disabled={false} onBusy={() => {}} />);
      await ui.click('Review host access…');
      expect(document.body.textContent).toContain('Host tool allowed');
      await ui.click('Revoke host access');
      expect(requests).toEqual(['status','allow','revoke']);
      expect(document.body.textContent).toContain('needs local approval');
    });
  } finally { model.dispose(); }
});

test('tool editor imports externally authored code and inputs, separates credentials, and tests only the saved definition', async () => {
  let pack = (await officialAgentPackages())[0]!;
  const requests: ToolTestRequest[] = [], credentials: ToolCredentialRequest[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [], onDidChange: () => () => {},
    save: async () => { throw new Error('unused'); }, toolCredential: async input => { credentials.push(input); return input.action === 'save'; },
    testTool: async input => { requests.push(input); return { result: { judgment: 'yes' } }; } });
  let savedPack: AgentPackage | undefined;
  function Editor() {
    const [value, setValue] = useState(pack), [busy, setBusy] = useState(false);
    return <HomieCustomTools pack={value} savedPack={savedPack} patch={patch => { pack = { ...value, ...patch }; setValue(pack); }} disabled={busy}
      model={model} agentId="test" engineId="docker:fixture" onBusy={setBusy} />;
  }
  try {
    await withDOM(async ui => {
      await ui.render(<Editor />);
      expect(document.body.textContent).not.toContain('Jev');
      const picker = document.querySelector<HTMLInputElement>('[aria-label="Import tool file"]')!;
      Object.defineProperty(picker, 'files', { configurable: true, value: [new File([JSON.stringify(externalToolFixture)], 'external.homietool.json')] });
      await act(async () => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
      expect(parseAgentPackage(pack).tools![0]!.network?.url).toBe('https://api.example.com/judge');
      expect(pack.resources?.files[0]?.content).toContain('request: { body: input }');
      await ui.type('Tool API key', 'fixture-secret'); await ui.click('Save API key');
      expect(credentials.at(-1)).toMatchObject({ action: 'save', value: 'fixture-secret', origin: 'https://api.example.com' });
      expect(JSON.stringify(pack)).not.toContain('fixture-secret');
      expect((document.querySelector('[aria-label="Tool API key"]') as HTMLInputElement).value).toBe('');
      expect([...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('Run test'))!.disabled).toBe(true);
    });
    savedPack = pack;
    await withDOM(async ui => {
      await ui.render(<Editor />); await ui.type('Test input content', '2 + 2 = 4'); await ui.type('Test input criteria', 'Is this true?');
      await ui.click('Run test · sends inputs to API');
      expect(requests).toEqual([{ agentId: 'test', engineId: 'docker:fixture', tool: 'external_judge', args: { content: '2 + 2 = 4', criteria: 'Is this true?' } }]);
      expect(document.body.textContent).toContain('judgment');
      await ui.type('Custom tool description', 'Changed draft');
      expect([...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('Run test'))!.disabled).toBe(true);
      await ui.click('Remove tool'); expect(pack.tools).toEqual([]); expect(pack.resources!.files).toHaveLength(1);
    });
  } finally { model.dispose(); }
});
test('folder imports preserve scripts and dependencies and reject collisions without changing the current pack', async () => {
  const base = (await officialAgentPackages())[0]!;
  const files = [new File([JSON.stringify({ schemaVersion: 1, tool: externalToolFixture.tool, programs: ['jq'] })], 'tool.json'),
    new File([externalToolFixture.resources.files[0]!.content], 'judge.ts')];
  for (const [index, path] of ['outside/tool.json', 'outside/scripts/judge.ts'].entries()) Object.defineProperty(files[index]!, 'webkitRelativePath', { value: path });
  const imported = await importHomieTool(files, base);
  expect(imported.tools![0]).toEqual(externalToolFixture.tool); expect(imported.resources?.programs).toEqual(['jq']);
  const previous = JSON.stringify(imported);
  let error: unknown; try { await importHomieTool(files, { ...base, ...imported }); } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect(JSON.stringify(imported)).toBe(previous);
});

test('switching a managed Python tool to Docker clears its host pin and adds the container dependency', async () => {
  let pack = parseAgentPackage({ ...(await officialAgentPackages())[0], tools: [{ name: 'python_fixture', description: 'Python fixture',
    enabled: true, execution: 'host', runtime: 'python3', runtimeVersion: '3.14.8', script: 'scripts/run.py', parameters: [] }],
  resources: { programs: [], files: [{ path: 'scripts/run.py', content: 'print("fixture")' }] } });
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [],
    onDidChange: () => () => {}, save: async () => { throw new Error('unused'); } });
  function Editor() {
    const [value, setValue] = useState(pack);
    return <HomieCustomTools pack={value} patch={patch => { pack = { ...value, ...patch }; setValue(pack); }}
      disabled={false} model={model} onBusy={() => {}} />;
  }
  try {
    await withDOM(async ui => {
      await ui.render(<Editor />);
      expect(document.body.textContent).toContain('No separate Python installation');
      await ui.click('Tool execution target'); await ui.click('Docker container');
      const parsed = parseAgentPackage(pack);
      expect(parsed.tools![0]!.runtimeVersion).toBeUndefined();
      expect(parsed.tools![0]!.execution).toBeUndefined();
      expect(parsed.resources!.programs).toContain('python3');
    });
  } finally { model.dispose(); }
});
