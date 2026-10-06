import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runDocker } from '../lib/agent-management/docker.mts';
import { preparePackEnvironment } from '../lib/agent-management/pack-environment.mts';
import { executeCustomTool } from '../lib/agent-management/custom-tool-execution.mts';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';
import { externalToolFixture } from './homie-tool-fixture';

test.skipIf(process.env.CHESHI_TEST_CUSTOM_TOOL_DOCKER !== '1')('external script runs in isolated Docker and returns its request through the generic broker', async () => {
  const prefix = ['--context', 'colima-cheshi'];
  const base = (await officialAgentPackages())[0]!;
  const unique = randomUUID(), tool = externalToolFixture.tool;
  const pack = { ...base, tools: [tool], resources: { programs: [], files: [{ path: tool.script,
    content: externalToolFixture.resources.files[0]!.content + `\n// isolated probe ${unique}\n` }] } };
  let image: string | undefined;
  try {
    image = await preparePackEnvironment(runDocker, prefix, 'cheshi-specialist:1', pack);
    let called = false;
    const result = await executeCustomTool({ run: runDocker, prefix, image, tool, args: { content: 'synthetic', criteria: 'check' },
      signal: AbortSignal.timeout(60_000), credential: async () => 'fixture-secret',
      post: async (url, body, credential) => {
        expect(url.href).toBe('https://api.example.com/judge'); expect(body).toEqual({ content: 'synthetic', criteria: 'check' });
        expect(credential).toBe('fixture-secret'); called = true; return { accepted: true };
      } });
    expect(called).toBe(true); expect(result).toEqual({ accepted: true });
  } finally { if (image) await runDocker([...prefix, 'image', 'rm', image]); }
}, 120_000);
