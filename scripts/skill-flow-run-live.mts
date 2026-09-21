import { app, safeStorage } from 'electron';
import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { skillFlowArguments } from './skill-flow-run.mts';
import { CodexAppServerClient } from '../desktop/lib/codex-app-server-client.mts';
import { createSkillFlowCodex, type SkillFlowCodexResult } from '../desktop/lib/skill-flow-codex.mts';
import { createSkillFlowJudge } from '../desktop/lib/skill-flow-judge.mts';
import { createSkillFlowLunaJudge, withSkillFlowFallback } from '../desktop/lib/skill-flow-fallback.mts';
import { skillFlowKey } from '../desktop/lib/skill-flow-credentials.mts';
import { createResearchActions } from '../desktop/lib/skill-flow-research.mts';
import { createSkillRegistry, loadWorkspaceSkill, runRegisteredSkill } from '../desktop/lib/skill-flow-registry.mts';

app.setName('Cheshi');
const keyDirectory = app.getPath('userData');
const temporaryData = mkdtempSync(path.join(os.tmpdir(), 'cheshi-skill-run-'));
app.setPath('userData', temporaryData);
app.setPath('sessionData', temporaryData);
const lifetime = new AbortController();
const cancel = () => lifetime.abort(new Error('Skill canceled.'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

void app.whenReady().then(async () => {
  app.dock?.hide();
  let exitCode = 1;
  try {
    const args = skillFlowArguments(process.argv.slice(2));
    const input = await readFile(args.input!, 'utf8');
    if (Buffer.byteLength(input) > 32_000) throw new Error('Input file too large.');
    const registry = createSkillRegistry([await loadWorkspaceSkill(args.skill, process.cwd())]);
    const usages: Array<Omit<SkillFlowCodexResult, 'text'>> = [];
    const codex = createSkillFlowCodex({ cwd: process.cwd(), onUsage: usage => usages.push(usage),
      createClient: () => new CodexAppServerClient({ cwd: process.cwd(), capabilities: { experimentalApi: true },
        clientInfo: { name: 'cheshi_skill_flow', title: 'Cheshi skill flow', version: '1.0.0' },
        // In a selected skill invocation CODEX_HOME belongs to the invoking Codex account.
        command: { executable: process.env.CHESHI_CODEX?.trim() || 'codex', args: ['app-server', '--listen', 'stdio://'],
          environment: { ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) } },
      }),
    });
    const primary = createSkillFlowJudge({ getKey: () => skillFlowKey(keyDirectory, safeStorage) });
    const result = await runRegisteredSkill(args.skill, JSON.parse(input), {
      registry, judge: withSkillFlowFallback(primary, createSkillFlowLunaJudge(codex)),
      dependencies: { research: createResearchActions(codex) },
      outputRoot: args['output-root'], signal: lifetime.signal,
      timeoutMs: args.timeoutMs, maxJudgments: args.maxJudgments,
    });
    await writeFile(path.join(path.dirname(result.reportPath), 'execution.json'), JSON.stringify({
      outcome: result.outcome, reason: result.reason, judgments: result.judgments,
      codex: usages, artifacts: result.artifacts,
    }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`${result.outcome}: ${result.reportPath}`);
    for (const artifact of result.artifacts) console.log(artifact);
    exitCode = result.outcome === 'success' ? 0 : 1;
  } catch { console.error('Skill failed to load or save its output. Check its module, input, account and output-directory access.'); }
  finally {
    try { await rm(temporaryData, { recursive: true, force: true }); } catch { /* Preserve the run result. */ }
    app.exit(exitCode);
  }
});
