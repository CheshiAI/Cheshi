import { expect, test } from 'bun:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import {
  createFakeCodexClient as createFakeClient,
  createCodexChatService as createService,
  expectFailure,
  codexThread as thread,
} from './codex-chat-test-helpers.ts';

export function registerAppliesPermissionModesAndResolvesApprovalRequestsTests(): void {

  test('applies permission modes and resolves approval requests', async () => {
    const client = createFakeClient({
      'permissionProfile/list': {
        data: [
          { id: ':read-only', description: 'Read-only access.', allowed: true },
          { id: ':workspace', description: 'Workspace access.', allowed: true },
          { id: ':danger-full-access', description: 'Unrestricted access.', allowed: true },
        ],
        nextCursor: null,
      },
      'thread/start': { thread: thread('permission-thread') },
      'turn/start': { turn: { id: 'permission-turn', items: [], status: 'inProgress' } },
      'thread/settings/update': {},
    });
    const service = createService(client);
    const events: Array<Record<string, unknown>> = [];
    const removeListener = service.onEvent((event) => events.push(event));
    try {
      const catalog = await service.listPermissionModes();
      expect(catalog.currentMode).toMatchObject({ id: 'read-only', access: 'Read only' });
      expect(await service.setPermissionMode('ask-for-approval')).toMatchObject({
        mode: { id: 'ask-for-approval', access: 'Ask for approval' },
      });

      await service.sendMessage('Inspect and update the project', 'client-permissions');
      expect(client.requests.find(({ method }) => method === 'thread/start')?.params).toMatchObject({
        permissions: ':workspace',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      });
      expect(client.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({
        permissions: ':workspace',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      });

      client.emitRequest(44, 'item/commandExecution/requestApproval', {
        command: 'bun run build',
        reason: 'Run the focused build.',
        availableDecisions: ['accept', 'acceptForSession', 'decline'],
      });
      expect(events).toContainEqual({
        type: 'approval-requested',
        approval: {
          id: 'approval-1',
          threadId: 'permission-thread',
          kind: 'command',
          title: 'Command approval',
          detail: 'bun run build',
          canAllowForSession: true,
        },
      });
      expect(await service.respondToApproval('approval-1', 'acceptForSession')).toEqual({
        approvalId: 'approval-1',
      });
      expect(client.responsesSent).toEqual([{
        id: 44,
        result: { decision: 'acceptForSession' },
      }]);

      client.emitRequest(45, 'item/permissions/requestApproval', {
        reason: 'Connect to the package registry.',
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      });
      expect(events).toContainEqual({
        type: 'approval-requested',
        approval: {
          id: 'approval-2',
          threadId: 'permission-thread',
          kind: 'permissions',
          title: 'Additional access',
          detail: 'Connect to the package registry.',
          canAllowForSession: true,
        },
      });
      await service.respondToApproval('approval-2', 'accept');
      deepStrictEqual(client.responsesSent.at(-1), {
        id: 45,
        result: {
          permissions: { network: { enabled: true } },
          scope: 'turn',
        },
      });

      client.emit('turn/completed', {
        threadId: 'permission-thread',
        turn: { id: 'permission-turn', status: 'completed', items: [], error: null },
      });
      expect(await service.setPermissionMode('approve-for-me')).toMatchObject({
        mode: { id: 'approve-for-me', access: 'Approve for me' },
      });
      deepStrictEqual(client.requests.at(-1), {
        method: 'thread/settings/update',
        params: {
          threadId: 'permission-thread',
          permissions: ':workspace',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
        },
      });
    } finally {
      removeListener();
      service.stop();
    }
  });


  test('lists only sessions in the selected workspace', async () => {
    const client = createFakeClient({
      'thread/list': { data: [thread('thread-1')] },
    });
    const service = createService(client);
    try {
      expect(await service.listSessions()).toEqual({
        sessions: [{
          id: 'thread-1',
          title: 'Inspect the workspace',
          preview: 'Inspect the workspace',
          createdAt: 100,
          updatedAt: 120,
          status: 'idle',
        }],
      });
      expect(client.requests).toEqual([{
        method: 'thread/list',
        params: {
          limit: 100,
          sortKey: 'recency_at',
          sortDirection: 'desc',
          cwd: '/workspace/cheshi',
        },
      }]);
    } finally {
      service.stop();
    }
  });


  test('uses parent ancestry for agents with different session ids and rejects unrelated matching sessions', async () => {
    const threads = new Map([
      ['root-thread', thread('root-thread', {
        sessionId: 'root-thread',
        name: 'Main workflow',
        preview: 'Coordinate the implementation',
      })],
      ['reviewer-thread', thread('reviewer-thread', {
        sessionId: 'reviewer-thread',
        parentThreadId: 'root-thread',
        agentNickname: 'Sage',
        agentRole: 'reviewer',
        preview: 'Review the implementation',
      })],
      ['worker-thread', thread('worker-thread', {
        sessionId: 'worker-thread',
        parentThreadId: 'reviewer-thread',
        agentNickname: 'Nova',
        agentRole: 'worker',
        preview: 'Implement the regression tests',
      })],
      ['ephemeral-thread', thread('ephemeral-thread', {
        sessionId: 'ephemeral-thread',
        parentThreadId: 'root-thread',
        agentNickname: 'Scout',
        agentRole: 'researcher',
        preview: 'Inspect the app-server protocol',
        ephemeral: true,
      })],
      ['unrelated-thread', thread('unrelated-thread', {
        sessionId: 'root-thread',
        parentThreadId: 'outside-thread',
      })],
      ['cycle-a', thread('cycle-a', {
        sessionId: 'root-thread',
        parentThreadId: 'cycle-b',
      })],
      ['cycle-b', thread('cycle-b', {
        sessionId: 'root-thread',
        parentThreadId: 'cycle-a',
      })],
    ]);
    let turnSequence = 0;
    const client = createFakeClient({
      'thread/read': ({ threadId }: { threadId: string }) => {
        const selectedThread = threads.get(threadId);
        if (!selectedThread) throw new Error(`Unknown thread: ${threadId}`);
        return { thread: selectedThread };
      },
      'thread/list': {
        data: [
          threads.get('reviewer-thread'),
          threads.get('worker-thread'),
          threads.get('ephemeral-thread'),
          threads.get('unrelated-thread'),
          threads.get('cycle-a'),
          threads.get('cycle-b'),
        ],
        nextCursor: null,
      },
      'thread/resume': ({ threadId }: { threadId: string }) => ({ thread: threads.get(threadId) }),
      'thread/unsubscribe': {},
      'turn/start': () => ({
        turn: { id: `agent-turn-${++turnSequence}`, items: [], status: 'inProgress' },
      }),
    });
    const service = createService(client);
    const events: Array<Record<string, unknown>> = [];
    const removeListener = service.onEvent((event) => events.push(event));
    try {
      await service.openSession('root-thread');
      expect(await service.listAgents()).toEqual({
        agents: [
          {
            id: 'root-thread',
            parentThreadId: null,
            title: 'Main agent',
            description: 'Main workflow',
            kind: 'main',
            role: null,
            depth: 0,
            status: 'idle',
            current: true,
          },
          {
            id: 'reviewer-thread',
            parentThreadId: 'root-thread',
            title: 'Sage',
            description: 'reviewer · Review the implementation',
            kind: 'subagent',
            role: 'reviewer',
            depth: 1,
            status: 'idle',
            current: false,
          },
          {
            id: 'worker-thread',
            parentThreadId: 'reviewer-thread',
            title: 'Nova',
            description: 'worker · Implement the regression tests',
            kind: 'subagent',
            role: 'worker',
            depth: 2,
            status: 'idle',
            current: false,
          },
          {
            id: 'ephemeral-thread',
            parentThreadId: 'root-thread',
            title: 'Scout',
            description: 'researcher · Inspect the app-server protocol',
            kind: 'subagent',
            role: 'researcher',
            depth: 1,
            status: 'idle',
            current: false,
          },
        ],
      });
      deepStrictEqual(client.requests.find(({ method }) => method === 'thread/list')?.params, {
        limit: 100,
        sortKey: 'created_at',
        sortDirection: 'asc',
        ancestorThreadId: 'root-thread',
      });
      await expectFailure(
        () => service.openAgent('unrelated-thread'),
        'The selected Codex agent thread is no longer available. Open /agent and choose it again.',
      );

      expect(await service.openAgent('worker-thread')).toEqual({
        session: {
          id: 'worker-thread',
          title: 'Nova',
          preview: 'Implement the regression tests',
          createdAt: 100,
          updatedAt: 120,
          status: 'idle',
        },
        items: [],
      });
      await service.sendMessage('Continue the delegated work', 'client-agent');
      deepStrictEqual(client.requests.findLast(({ method }) => method === 'thread/resume')?.params, {
        threadId: 'worker-thread',
        permissions: ':read-only',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
      });
      const agentsWhileWorkerRuns = await service.listAgents();
      strictEqual(agentsWhileWorkerRuns.agents.find(({ current }) => current)?.id, 'worker-thread');
      expect(await service.openAgent('root-thread')).toEqual({
        session: {
          id: 'root-thread',
          title: 'Main workflow',
          preview: 'Coordinate the implementation',
          createdAt: 100,
          updatedAt: 120,
          status: 'idle',
        },
        items: [],
        responseInProgress: true,
        responseThreadIds: ['worker-thread'],
      });
      client.emit('item/agentMessage/delta', {
        threadId: 'worker-thread',
        turnId: 'agent-turn-1',
        itemId: 'hidden-worker-message',
        delta: 'This belongs only to the worker thread.',
      });
      expect(events.some((event) => event.text === 'This belongs only to the worker thread.')).toBe(false);
      client.emit('turn/completed', {
        threadId: 'worker-thread',
        turn: { id: 'agent-turn-1', status: 'completed', items: [], error: null },
      });

      const agentsFromRoot = await service.listAgents();
      expect(agentsFromRoot.agents.map(({ id, current, depth }) => ({ id, current, depth }))).toEqual([
        { id: 'root-thread', current: true, depth: 0 },
        { id: 'reviewer-thread', current: false, depth: 1 },
        { id: 'worker-thread', current: false, depth: 2 },
        { id: 'ephemeral-thread', current: false, depth: 1 },
      ]);
      await service.sendMessage('Continue the main work', 'client-main');
      deepStrictEqual(client.requests.findLast(({ method }) => method === 'thread/resume')?.params, {
        threadId: 'root-thread',
        permissions: ':read-only',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        cwd: '/workspace/cheshi',
        developerInstructions: 'Inspect the project in a read-only sandbox.',
      });
      client.emit('turn/completed', {
        threadId: 'root-thread',
        turn: { id: 'agent-turn-2', status: 'completed', items: [], error: null },
      });
    } finally {
      removeListener();
      service.stop();
    }
  });


  test('discovers installed plugin skills before reloading them in the same service', async () => {
    let installed = false;
    let discovered = false;
    let releaseDiscovery!: () => void;
    const discovery = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const pluginSkill = {
      name: 'codex-security:security-diff-scan', description: 'Review a diff.',
      enabled: true, scope: 'user', path: '/plugins/codex-security/skills/security-diff-scan/SKILL.md',
    };
    const client = createFakeClient({
      'plugin/list': async () => {
        await discovery;
        discovered = installed;
        return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
      },
      'skills/list': () => ({ data: [{
        cwd: '/workspace/cheshi', errors: [], skills: discovered ? [pluginSkill] : [],
      }] }),
    });
    const service = createService(client);
    try {
      const initial = service.listSkills();
      expect(client.requests.map(({ method }) => method)).toEqual(['plugin/list']);
      releaseDiscovery();
      expect((await initial).skills).toEqual([]);

      installed = true;
      expect((await service.listSkills()).skills.map(({ name }) => name)).toEqual([pluginSkill.name]);
      expect(service.availableSkills.has(pluginSkill.path)).toBe(true);

      installed = false;
      expect((await service.listSkills()).skills).toEqual([]);
      expect(service.availableSkills.has(pluginSkill.path)).toBe(false);
      expect(client.requests.map(({ method }) => method)).toEqual([
        'plugin/list', 'skills/list', 'plugin/list', 'skills/list', 'plugin/list', 'skills/list',
      ]);
    } finally {
      releaseDiscovery();
      service.stop();
    }
  });

  test('reports plugin discovery failure instead of presenting an incomplete skill list', async () => {
    const client = createFakeClient({ 'plugin/list': new Error('Plugin discovery failed.') });
    const service = createService(client);
    try {
      await expectFailure(() => service.listSkills(), 'Plugin discovery failed.');
      expect(client.requests.map(({ method }) => method)).toEqual(['plugin/list']);
    } finally {
      service.stop();
    }
  });

  test('lists skills and sends the selected skill as structured turn input', async () => {
    const client = createFakeClient({
      'plugin/list': { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
      'skills/list': {
        data: [{
          cwd: '/workspace/cheshi',
          errors: [],
          skills: [{
            name: 'personal-skill',
            description: 'Personal workflow.',
            enabled: true,
            path: '/skills/personal/SKILL.md',
            scope: 'user',
          }],
        }],
      },
      'thread/start': { thread: thread('skill-thread') },
      'turn/start': { turn: { id: 'skill-turn', items: [], status: 'inProgress' } },
    });
    const service = createService(client);
    try {
      expect(await service.listSkills()).toEqual({
        skills: [{
          name: 'personal-skill',
          displayName: 'personal-skill',
          description: 'Personal workflow.',
          scope: 'user',
          path: '/skills/personal/SKILL.md',
        }],
      });
      await service.sendMessage('Use this workflow', 'client-skill', {
        name: 'personal-skill',
        path: '/skills/personal/SKILL.md',
      });

      deepStrictEqual(client.requests[0], {
        method: 'plugin/list',
        params: { cwds: ['/workspace/cheshi'], forceRefetch: false },
      });
      deepStrictEqual(client.requests[1], {
        method: 'skills/list',
        params: {
          cwds: ['/workspace/cheshi'],
          forceReload: true,
        },
      });
      expect(client.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({
        threadId: 'skill-thread',
        clientUserMessageId: 'client-skill',
        input: [
          { type: 'skill', name: 'personal-skill', path: '/skills/personal/SKILL.md' },
          { type: 'text', text: 'Use this workflow', text_elements: [] },
        ],
      });
    } finally {
      service.stop();
    }
  });


  test('lists, reads, installs, and uninstalls plugins through structured references', async () => {
    const summary = {
      id: 'workflow@openai-curated-remote',
      name: 'workflow',
      remotePluginId: 'plugin_workflow_remote',
      source: { type: 'remote' },
      installed: false,
      enabled: true,
      installPolicy: 'AVAILABLE',
      authPolicy: 'ON_USE',
      interface: {
        displayName: 'Workflow',
        shortDescription: 'Automate project work.',
        logoUrl: 'https://files.openai.com/content?id=workflow-logo',
        logoUrlDark: 'https://files.openai.com/content?id=workflow-logo-dark',
      },
    };
    const client = createFakeClient({
      'plugin/list': {
        marketplaces: [{
          name: 'openai-curated-remote',
          path: null,
          interface: { displayName: 'OpenAI Curated' },
          plugins: [summary],
        }],
        featuredPluginIds: [],
        marketplaceLoadErrors: [],
      },
      'plugin/read': {
        plugin: {
          marketplaceName: 'openai-curated-remote',
          marketplacePath: null,
          summary,
          description: 'Automate project work.',
          skills: [],
          apps: [],
          appTemplates: [],
          mcpServers: [],
          hooks: [],
          scheduledTasks: null,
        },
      },
      'plugin/install': { authPolicy: 'ON_USE', appsNeedingAuth: [] },
      'plugin/uninstall': {},
      'skills/list': { data: [{ cwd: '/workspace/cheshi', errors: [], skills: [] }] },
    });
    const service = createService(client);
    const reference = { pluginName: 'plugin_workflow_remote', remoteMarketplaceName: 'openai-curated-remote' };
    try {
      const catalog = await service.listPlugins(true);
      await expectFailure(
        () => service.listPlugins('true'),
        'Plugin refresh flag must be a boolean.',
      );
      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.plugins[0]).toMatchObject({ hasLogo: true, name: 'workflow', reference });
      deepStrictEqual(service.getPluginLogoSources('workflow@openai-curated-remote'), {
        light: { kind: 'remote', value: 'https://files.openai.com/content?id=workflow-logo' },
        dark: { kind: 'remote', value: 'https://files.openai.com/content?id=workflow-logo-dark' },
      });
      expect((await service.readPlugin(reference)).plugin.displayName).toBe('Workflow');
      expect(await service.installPlugin(reference)).toEqual({
        authPolicy: 'ON_USE',
        appsNeedingAuth: [],
        runtimeRefreshed: true,
      });
      expect(await service.uninstallPlugin(reference.pluginName)).toEqual({ runtimeRefreshed: true });
      expect(client.requests).toEqual([
        { method: 'plugin/list', params: { cwds: ['/workspace/cheshi'], forceRefetch: true } },
        { method: 'plugin/read', params: reference },
        { method: 'plugin/install', params: reference },
        { method: 'plugin/list', params: { cwds: ['/workspace/cheshi'], forceRefetch: false } },
        { method: 'skills/list', params: { cwds: ['/workspace/cheshi'], forceReload: true } },
        { method: 'plugin/uninstall', params: { pluginId: 'plugin_workflow_remote' } },
        { method: 'plugin/list', params: { cwds: ['/workspace/cheshi'], forceRefetch: false } },
        { method: 'skills/list', params: { cwds: ['/workspace/cheshi'], forceReload: true } },
      ]);
      await expectFailure(
        () => service.readPlugin({ pluginName: 'workflow' }),
        'Plugin reference must identify exactly one marketplace.',
      );
    } finally {
      service.stop();
    }
  });


  test('sends image attachments and references other files in the text input', async () => {
    const client = createFakeClient({
      'thread/start': { thread: thread('attachment-thread') },
      'turn/start': { turn: { id: 'attachment-turn', items: [], status: 'inProgress' } },
    });
    const service = createService(client);
    try {
      await service.sendMessage('Review these attachments', 'client-attachments', null, [
        { kind: 'image', name: 'screenshot.png', path: '/tmp/screenshot.png' },
        { kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' },
      ]);

      expect(client.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({
        threadId: 'attachment-thread',
        clientUserMessageId: 'client-attachments',
        input: [
          {
            type: 'text',
            text: 'Review these attachments\n\nAttached files:\n- "/tmp/notes.txt"',
            text_elements: [],
          },
          { type: 'localImage', path: '/tmp/screenshot.png' },
        ],
      });
    } finally {
      service.stop();
    }
  });

}
