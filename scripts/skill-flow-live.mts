import { app, safeStorage } from 'electron';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runSkillFlowDemo } from './skill-flow-demo.mts';
import { skillFlowKey } from '../desktop/lib/skill-flow-credentials.mts';

// Same app identity as the earlier Jev benchmarks; no BrowserWindow is created.
app.setName('Cheshi');
const keyDirectory = app.getPath('userData');
const temporaryData = mkdtempSync(path.join(os.tmpdir(), 'cheshi-skill-flow-live-'));
app.setPath('userData', temporaryData);
app.setPath('sessionData', temporaryData);

void app.whenReady().then(async () => {
  app.dock?.hide();
  let exitCode = 1;
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: {
      'output-root': { type: 'string', default: 'out/skill-flow' },
    }, allowPositionals: false });
    const result = await runSkillFlowDemo({ mode: 'live', outputRoot: values['output-root'],
      getKey: () => skillFlowKey(keyDirectory, safeStorage) });
    console.log(`${result.outcome}: ${result.reportPath}`);
    exitCode = result.outcome === 'success' ? 0 : 1;
  } catch {
    console.error('Live skill flow could not run or save its report.');
  } finally {
    try { await rm(temporaryData, { recursive: true, force: true }); }
    catch { /* Temporary runtime cleanup must not mask the result. */ }
    app.exit(exitCode);
  }
});
