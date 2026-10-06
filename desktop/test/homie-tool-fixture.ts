import type { CustomTool } from '../../experiments/codex-specialists/src/custom-tool-contract';
/** Provider-neutral external bundle, used only by tests. */
export const externalToolFixture = {
  schemaVersion: 1,
  tool: { name: 'external_judge', description: 'Evaluate supplied content.', enabled: true, runtime: 'bun', script: 'scripts/judge.ts',
    parameters: [{ name: 'content', type: 'string', description: 'Content to evaluate', required: true },
      { name: 'criteria', type: 'string', description: 'Criteria to satisfy', required: true }],
    network: { url: 'https://api.example.com/judge', credential: 'external' },
  } satisfies CustomTool,
  resources: { programs: [], files: [{ path: 'scripts/judge.ts', content: 'const input = JSON.parse(await Bun.stdin.text());\nconsole.log(JSON.stringify({ request: { body: input } }));\n' }] },
};
