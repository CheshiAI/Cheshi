import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { createSettingsService } from '../lib/settings-service.mts';
import { chatPreferences, type ChatPreferenceStore } from '../lib/chat-preferences.mts';
import { codexThread, createFakeCodexClient, expectFailure } from './codex-chat-test-helpers.ts';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-chat-preferences-'));
  const settingsPath = path.join(directory, 'settings.json');
  const settings = () => createSettingsService({ settingsPath });
  const clients: ReturnType<typeof createFakeCodexClient>[] = [];
  const managers: CodexChatContexts[] = [];
  let allowed: unknown = true;
  const contexts = (preferences = settings().workspaceChatPreferences('/workspace/cheshi')) => {
    const manager = new CodexChatContexts({
      service: { cwd: '/workspace/cheshi', serviceName: 'cheshi', developerInstructions: 'Test.', chatPreferences: preferences },
      createClient() {
        const client = createFakeCodexClient({
          'permissionProfile/list': () => ({ data: [
            { id: ':read-only', allowed: true }, { id: ':workspace', allowed },
          ] }),
          'thread/start': { thread: codexThread('new-thread') },
          'thread/read': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId)) }),
          'thread/resume': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId)) }),
          'thread/unsubscribe': {},
          'thread/settings/update': {},
          'turn/start': { turn: { id: 'turn' } },
        });
        clients.push(client);
        return { ...client, stop: async () => {} };
      },
      emit() {},
    });
    managers.push(manager);
    return manager;
  };
  return { contexts, settings, settingsPath, clients, setAllowed(value: unknown) { allowed = value; },
    async close() {
      await Promise.all(managers.map(manager => manager.stop()));
      rmSync(directory, { recursive: true, force: true });
    } };
}

test('last choices survive session navigation, new panes and restart without changing existing panes', async () => {
  const f = fixture();
  try {
    const contexts = f.contexts();
    const first = contexts.get(1, 'first');
    const existing = contexts.get(1, 'existing');
    await first.setPermissionMode('approve-for-me');
    first.setCollaborationMode('plan');
    await first.openSession('saved');
    expect(first.currentPermissionMode().id).toBe('approve-for-me');
    await first.newSession();
    expect(first.currentPermissionMode().id).toBe('approve-for-me');
    expect(first.configuration().collaborationMode).toBe('plan');
    expect(existing.configuration().collaborationMode).toBe('default');
    expect((await existing.listPermissionModes()).currentMode.id).toBe('read-only');
    const fresh = contexts.get(1, 'fresh');
    expect((await fresh.listPermissionModes()).currentMode.id).toBe('approve-for-me');
    expect(fresh.configuration().collaborationMode).toBe('plan');
    await contexts.stop();
    const restarted = f.contexts().get(2, 'restarted');
    // Sending before the UI fetches permissions must still validate and restore the saved mode.
    await restarted.sendMessage('Hello', 'message');
    const requests = f.clients.at(-1)!.requests;
    expect(requests.find(request => request.method === 'thread/start')?.params).toMatchObject({
      permissions: ':workspace', approvalsReviewer: 'auto_review',
    });
    expect(requests.find(request => request.method === 'turn/start')?.params).toMatchObject({
      permissions: ':workspace', collaborationMode: { mode: 'plan' },
    });
  } finally { await f.close(); }
});

test('new sessions use the latest defaults while partial preference writes preserve other choices and workspaces', async () => {
  const f = fixture();
  try {
    const contexts = f.contexts();
    const first = contexts.get(1, 'first');
    const second = contexts.get(1, 'second');
    await first.setPermissionMode('approve-for-me');
    second.setCollaborationMode('plan');
    f.settings().setProjectDocMaxBytes(65536);
    const other = f.settings().workspaceChatPreferences('/workspace/other');
    other.write({ permissionModeId: 'ask-for-approval' });
    await first.newSession();
    expect(first.configuration().collaborationMode).toBe('plan');
    expect(first.currentPermissionMode().id).toBe('approve-for-me');
    await second.newSession();
    expect((await second.listPermissionModes()).currentMode.id).toBe('approve-for-me');
    expect(other.read()).toEqual({ permissionModeId: 'ask-for-approval', collaborationMode: 'default' });
    expect(f.settings().getProjectDocMaxBytes()).toBe(65536);
    second.setCollaborationMode('default');
    await second.setPermissionMode('read-only');
    const next = contexts.get(1, 'next');
    expect(next.configuration().collaborationMode).toBe('default');
    expect((await next.listPermissionModes()).currentMode.id).toBe('read-only');
  } finally { await f.close(); }
});

test('unavailable or disallowed saved permissions fall back before sending, including after account reset', async () => {
  const f = fixture();
  try {
    f.settings().workspaceChatPreferences('/workspace/cheshi').write({ permissionModeId: 'approve-for-me', collaborationMode: 'plan' });
    const service = f.contexts().get(1, 'pane');
    expect((await service.listPermissionModes()).currentMode.id).toBe('approve-for-me');
    for (const allowed of [false, 'true', 1, null]) {
      f.setAllowed(allowed);
      await service.resetForAccount();
      await service.sendMessage('Hello', `message-${String(allowed)}`);
      expect(service.currentPermissionMode().id).toBe('read-only');
      expect(f.clients[0]!.requests.filter(request => request.method === 'turn/start').at(-1)?.params).toMatchObject({
        permissions: ':read-only', collaborationMode: { mode: 'plan' },
      });
    }
    f.settings().workspaceChatPreferences('/workspace/cheshi').write({ permissionModeId: 'custom:removed' });
    await service.resetForAccount();
    expect((await service.listPermissionModes()).currentMode.id).toBe('read-only');
  } finally { await f.close(); }
});

test('invalid saved values use initial defaults and failed selections do not replace saved choices', async () => {
  const f = fixture();
  try {
    for (const value of [null, [], true, 'plan', { permissionModeId: 42, collaborationMode: true }]) {
      expect(chatPreferences(value)).toEqual({ permissionModeId: 'read-only', collaborationMode: 'default' });
    }
    const preferences = f.settings().workspaceChatPreferences('/workspace/cheshi');
    const service = f.contexts().get(1, 'pane');
    await service.setPermissionMode('approve-for-me');
    service.setCollaborationMode('plan');
    await expectFailure(() => service.setPermissionMode('missing'), 'The selected Codex permission mode is no longer available.');
    expect(() => service.setCollaborationMode(true)).toThrow('must be default or plan');
    expect(preferences.read()).toEqual({ permissionModeId: 'approve-for-me', collaborationMode: 'plan' });
    writeFileSync(f.settingsPath, '{damaged');
    expect(() => preferences.write({ collaborationMode: 'default' })).toThrow('Could not save the chat defaults');
    expect(readFileSync(f.settingsPath, 'utf8')).toBe('{damaged');
  } finally { await f.close(); }
});

test('preference write errors retain the applied permission event and leave Plan unchanged', async () => {
  const f = fixture();
  try {
    const store: ChatPreferenceStore = { read: () => chatPreferences(null), write() { throw new Error('Save failed'); } };
    const service = f.contexts(store).get(1, 'pane');
    const events: Record<string, unknown>[] = [];
    service.onEvent(event => events.push(event));
    await expectFailure(() => service.setPermissionMode('approve-for-me'), 'Save failed');
    expect(service.currentPermissionMode().id).toBe('approve-for-me');
    expect(events.at(-1)).toMatchObject({ type: 'permission-mode-changed', mode: { id: 'approve-for-me' } });
    events.length = 0;
    expect(() => service.setCollaborationMode('plan')).toThrow('Save failed');
    expect(service.configuration().collaborationMode).toBe('default');
    expect(events).toEqual([]);
  } finally { await f.close(); }
});
