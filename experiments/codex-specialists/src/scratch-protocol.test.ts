import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient } from './app-server-client.ts';
import { record, textValue } from './protocol.ts';
import { SCRATCH_PROFILE, TaskScratch } from './task-scratch.ts';
import { permissionTools } from './execution-permissions.ts';
import { collaborationTools } from './collaboration-tools.ts';

// Uses an installed Codex but no credentials, turn/start, model call or running desktop app.
for (const projectWritable of [false, true]) test.skipIf(!Bun.which('codex'))(`native Codex reloads ${projectWritable ? 'development' : 'verification'} scratch permissions on warm and cold resumes`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-native-scratch-')));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  mkdirSync(join(root, 'codex'));
  const scratch = [new TaskScratch(root), new TaskScratch(root), new TaskScratch(root)];
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, 'codex') };
  let client = new AppServerClient(Bun.which('codex')!, env);
  const params = (index: number) => ({ cwd: workspace, model: 'gpt-6-astra', approvalPolicy: 'on-request',
    // Exercise both default selection and explicit selection against native Codex.
    ...(index === 0 ? {} : { permissions: SCRATCH_PROFILE }), config: scratch[index]!.config(workspace, projectWritable) });
  const assertPermissions = (result: Record<string, unknown>, index: number) => {
    scratch[index]!.assertApplied(result, projectWritable ? workspace : undefined);
    expect(record(result.activePermissionProfile).id).toBe(SCRATCH_PROFILE);
    expect(result.sandbox).toEqual({ type: 'workspaceWrite', writableRoots: expect.arrayContaining([scratch[index]!.directory]),
      networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  };
  try {
    await client.initialize();
    const start = await client.request('thread/start', { ...params(0), dynamicTools: [...permissionTools, ...collaborationTools] });
    const threadId = textValue(record(start.thread).id, 'thread id');
    assertPermissions(start, 0);
    // Persist a local history item without submitting anything to a provider.
    await client.request('thread/inject_items', { threadId, items: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Local permissions regression.' }] },
    ] });
    await client.request('thread/unsubscribe', { threadId });
    const warm = await client.request('thread/resume', { ...params(1), threadId });
    assertPermissions(warm, 1); expect(record(warm.thread).id).toBe(threadId);
    await client.close(); client = new AppServerClient(Bun.which('codex')!, env);
    await client.initialize();
    const cold = await client.request('thread/resume', { ...params(2), threadId });
    assertPermissions(cold, 2); expect(record(cold.thread).id).toBe(threadId);
  } finally {
    await client.close();
    for (const item of scratch) item.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
