import {
  registerAppliesPermissionModesAndResolvesApprovalRequestsTests,
} from './codex-chat-service.applies-permission-modes-and-resolves-approval-requests.cases';
import {
  createFakeCodexClient as createFakeClient,
  createCodexChatService as createService,
  expectFailure,
  codexThread as thread,
} from './codex-chat-test-helpers.ts';
import { describe, expect, test } from 'bun:test';
import { deepStrictEqual } from 'node:assert/strict';

export function registerCodexchatserviceTests(): void {


  describe('CodexChatService', () => {

    registerAppliesPermissionModesAndResolvesApprovalRequestsTests();

    test('lists MCP servers and starts a persistent goal on the active thread', async () => {
      const goal = {
        threadId: 'goal-thread',
        objective: 'Finish the chat experience',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
      };
      const client = createFakeClient({
        'mcpServerStatus/list': {
          data: [{
            name: 'codegraph',
            pluginId: null,
            serverInfo: { name: 'codegraph', title: 'CodeGraph', version: '1.5.0' },
            tools: { explore: {} },
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported',
          }],
          nextCursor: null,
        },
        'thread/start': (params: Record<string, unknown>) => ({
          thread: params.ephemeral === true ? thread('mcp-probe', { ephemeral: true }) : thread('goal-thread'),
        }),
        'thread/goal/set': { goal },
        'thread/goal/get': { goal },
      });
      const service = createService(client);
      const events: Array<Record<string, unknown>> = [];
      const removeListener = service.onEvent((event) => events.push(event));
      try {
        expect(await service.listMcpServers()).toEqual({
          servers: [{
            name: 'codegraph',
            displayName: 'CodeGraph',
            version: '1.5.0',
            toolCount: 1,
            resourceCount: 0,
            resourceTemplateCount: 0,
            authStatus: 'unsupported',
            runtimeStatus: 'connected',
            toolsError: null,
            connected: true,
          }],
        });
        expect(await service.getGoal()).toEqual({ goal: null });
        expect(await service.setGoal('Finish the chat experience')).toEqual({ goal });
        expect(await service.getGoal()).toEqual({ goal });
        expect(client.requests).toEqual([
          {
            method: 'thread/start',
            params: { cwd: '/workspace/cheshi', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' },
          },
          {
            method: 'mcpServerStatus/list',
            params: { limit: 100, detail: 'toolsAndAuthOnly', threadId: 'mcp-probe' },
          },
          {
            method: 'thread/start',
            params: {
              cwd: '/workspace/cheshi',
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              permissions: ':read-only',
              developerInstructions: 'Inspect the project in a read-only sandbox.',
              ephemeral: false,
              serviceName: 'cheshi',
              sessionStartSource: 'startup',
            },
          },
          {
            method: 'thread/goal/set',
            params: { threadId: 'goal-thread', objective: 'Finish the chat experience', status: 'active' },
          },
          {
            method: 'thread/goal/get',
            params: { threadId: 'goal-thread' },
          },
        ]);

        client.emit('turn/started', {
          threadId: 'goal-thread',
          turn: { id: 'goal-turn', status: 'inProgress', items: [] },
        });
        client.emit('item/agentMessage/delta', {
          threadId: 'goal-thread',
          turnId: 'goal-turn',
          itemId: 'goal-message',
          delta: 'Working on the goal.',
        });
        client.emit('turn/completed', {
          threadId: 'goal-thread',
          turn: { id: 'goal-turn', status: 'completed', items: [], error: null },
        });
        expect(events).toContainEqual({
          type: 'assistant-delta',
          threadId: 'goal-thread',
          turnId: 'goal-turn',
          itemId: 'goal-message',
          text: 'Working on the goal.',
        });
      } finally {
        removeListener();
        service.stop();
      }
    });

    test('selects an advertised model, reasoning level, and Fast tier for subsequent turns', async () => {
      const client = createFakeClient({
        'model/list': {
          data: [{
            id: 'model-1',
            model: 'gpt-model-1',
            displayName: 'GPT Model 1',
            description: 'Primary model.',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Balanced.' },
              { reasoningEffort: 'high', description: 'Deeper reasoning.' },
            ],
            serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Faster responses.' }],
            defaultServiceTier: null,
          }],
        },
        'thread/start': { thread: thread('configured-thread') },
        'turn/start': { turn: { id: 'configured-turn', items: [], status: 'inProgress' } },
      });
      const service = createService(client);
      try {
        const catalog = await service.listModels();
        await expectFailure(
          () => service.configure({ fast: 'true' }),
          'Fast mode must be a boolean.',
        );
        expect(catalog.configuration).toMatchObject({
          model: 'gpt-model-1',
          modelDisplayName: 'GPT Model 1',
          reasoningEffort: 'medium',
          serviceTier: null,
          serviceTierDisplayName: 'Standard',
          fastModeAvailable: true,
          fastModeEnabled: false,
        });
        expect(await service.configure({ model: 'gpt-model-1', effort: 'high', fast: true })).toMatchObject({
          model: 'gpt-model-1',
          reasoningEffort: 'high',
          serviceTier: 'fast',
          serviceTierDisplayName: 'Fast',
          fastModeAvailable: true,
          fastModeEnabled: true,
        });
        expect(await service.configure({ fast: false })).toMatchObject({
          serviceTier: null,
          serviceTierDisplayName: 'Standard',
          fastModeAvailable: true,
          fastModeEnabled: false,
        });
        await service.configure({ fast: true });
        await service.sendMessage('Inspect the project', 'client-configured');

        expect(client.requests.find(({ method }) => method === 'thread/start')?.params).toMatchObject({
          model: 'gpt-model-1',
          permissions: ':read-only',
          serviceTier: 'fast',
        });
        expect(client.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({
          model: 'gpt-model-1',
          effort: 'high',
          serviceTier: 'fast',
        });
      } finally {
        service.stop();
      }
    });

    test('forks the selected chat and keeps the fork in read-only mode', async () => {
      const client = createFakeClient({
        'thread/read': { thread: thread('source-thread', { turns: [] }) },
        'thread/fork': { thread: thread('forked-thread', { turns: [] }) },
      });
      const service = createService(client);
      try {
        await service.openSession('source-thread');
        expect(await service.forkSession()).toEqual({
          session: {
            id: 'forked-thread',
            title: 'Inspect the workspace',
            preview: 'Inspect the workspace',
            createdAt: 100,
            updatedAt: 120,
            status: 'idle',
          },
          items: [],
        });
        deepStrictEqual(client.requests.at(-1), {
          method: 'thread/fork',
          params: {
            threadId: 'source-thread',
            cwd: '/workspace/cheshi',
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            permissions: ':read-only',
            developerInstructions: 'Inspect the project in a read-only sandbox.',
            ephemeral: false,
            excludeTurns: false,
            deferGoalContinuation: true,
          },
        });
        expect(service.getStatus()).toMatchObject({ threadId: 'forked-thread', access: 'Read only' });
      } finally {
        service.stop();
      }
    });

    test('starts compact and review command turns on the active chat', async () => {
      const client = createFakeClient({
        'thread/read': { thread: thread('command-thread', { turns: [] }) },
        'thread/resume': { thread: thread('command-thread') },
        'thread/compact/start': {},
        'review/start': { reviewThreadId: 'command-thread', turn: { id: 'review-turn', items: [], status: 'inProgress' } },
      });
      const service = createService(client);
      const events: Array<Record<string, unknown>> = [];
      const removeListener = service.onEvent((event) => events.push(event));
      try {
        await service.openSession('command-thread');
        expect(await service.compactSession()).toEqual({ threadId: 'command-thread', turnId: null });
        client.emit('turn/started', {
          threadId: 'command-thread',
          turn: { id: 'compact-turn', items: [], status: 'inProgress' },
        });
        client.emit('item/completed', {
          threadId: 'command-thread',
          turnId: 'compact-turn',
          item: { type: 'contextCompaction', id: 'compact-item' },
        });
        client.emit('turn/completed', {
          threadId: 'command-thread',
          turn: { id: 'compact-turn', status: 'completed', items: [], error: null },
        });

        expect(await service.reviewSession()).toEqual({ threadId: 'command-thread', turnId: 'review-turn' });
        expect(client.requests.map(({ method }) => method)).toEqual([
          'thread/read',
          'thread/resume',
          'thread/compact/start',
          'review/start',
        ]);
        deepStrictEqual(client.requests.at(-1)?.params, {
          threadId: 'command-thread',
          target: { type: 'uncommittedChanges' },
          delivery: 'inline',
        });
        expect(events).toContainEqual({
          type: 'activity',
          threadId: 'command-thread',
          turnId: 'compact-turn',
          item: {
            id: 'compact-item',
            kind: 'activity',
            activity: 'context',
            label: 'Context compacted',
            detail: 'Conversation context was summarized',
            status: 'completed',
          },
        });
      } finally {
        removeListener();
        service.stop();
      }
    });

    test('rejects a skill reference that was not returned by the skills API', async () => {
      const client = createFakeClient();
      const service = createService(client);
      try {
        await expectFailure(
          () => service.sendMessage('Use this workflow', 'client-forged-skill', {
            name: 'forged-skill',
            path: '/untrusted/SKILL.md',
          }),
          'The selected Codex skill is no longer available. Open /skills and choose it again.',
        );
        expect(client.requests).toEqual([]);
      } finally {
        service.stop();
      }
    });

    test('opens history without resuming and resumes only when the user sends', async () => {
      const client = createFakeClient({
        'thread/read': { thread: thread('saved-thread', { turns: [] }) },
        'thread/resume': { thread: thread('saved-thread') },
        'turn/start': { turn: { id: 'turn-1', items: [], status: 'inProgress' } },
      });
      const service = createService(client);
      try {
        expect(await service.openSession('saved-thread')).toEqual({
          session: {
            id: 'saved-thread',
            title: 'Inspect the workspace',
            preview: 'Inspect the workspace',
            createdAt: 100,
            updatedAt: 120,
            status: 'idle',
          },
          items: [],
        });
        expect(client.requests.map(({ method }) => method)).toEqual(['thread/read']);

        expect(await service.sendMessage('Continue', 'client-1')).toEqual({
          threadId: 'saved-thread',
          turnId: 'turn-1',
        });
        expect(client.requests.map(({ method }) => method)).toEqual([
          'thread/read',
          'model/list',
          'thread/resume',
          'turn/start',
        ]);
        expect(client.requests[2]?.params).toMatchObject({
          threadId: 'saved-thread',
          cwd: '/workspace/cheshi',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          permissions: ':read-only',
        });
      } finally {
        service.stop();
      }
    });

    test('runs responses in two sessions concurrently and routes their events independently', async () => {
      let turnSequence = 0;
      const client = createFakeClient({
        'thread/read': ({ threadId }: { threadId: string }) => ({
          thread: thread(threadId, { preview: `Preview for ${threadId}`, turns: [] }),
        }),
        'thread/resume': ({ threadId }: { threadId: string }) => ({ thread: thread(threadId) }),
        'thread/unsubscribe': { status: 'notLoaded' },
        'turn/interrupt': {},
        'turn/start': () => ({
          turn: { id: `turn-${++turnSequence}`, items: [], status: 'inProgress' },
        }),
      });
      const service = createService(client);
      const events: Array<Record<string, unknown>> = [];
      const removeListener = service.onEvent((event) => events.push(event));
      try {
        await service.openSession('running-thread');
        await service.sendMessage('Keep working', 'client-running');

        expect(await service.openSession('history-thread')).toMatchObject({
          session: { id: 'history-thread' },
          items: [],
          responseInProgress: true,
          responseThreadIds: ['running-thread'],
        });
        expect(client.requests.some(({ method }) => method === 'thread/unsubscribe')).toBe(false);

        expect(await service.sendMessage('Continue this chat', 'client-history')).toEqual({
          threadId: 'history-thread',
          turnId: 'turn-2',
        });
        await expectFailure(
          () => service.sendMessage('Duplicate turn', 'client-duplicate', null, [], 'history-thread'),
          'A response is already in progress for this chat.',
        );
        expect(client.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(2);

        client.emit('item/agentMessage/delta', {
          threadId: 'running-thread',
          turnId: 'turn-1',
          itemId: 'background-message',
          delta: 'This must stay in the running thread.',
        });
        expect(events.some((event) => event.text === 'This must stay in the running thread.')).toBe(false);

        client.emit('item/agentMessage/delta', {
          threadId: 'history-thread',
          turnId: 'turn-2',
          itemId: 'visible-history-message',
          delta: 'This belongs to the viewed history thread.',
        });
        expect(events).toContainEqual({
          type: 'assistant-delta',
          threadId: 'history-thread',
          turnId: 'turn-2',
          itemId: 'visible-history-message',
          text: 'This belongs to the viewed history thread.',
        });

        expect(await service.openSession('running-thread')).toMatchObject({
          responseInProgress: true,
          responseThreadIds: ['running-thread', 'history-thread'],
        });

        client.emit('turn/completed', {
          threadId: 'running-thread',
          turn: { id: 'turn-1', status: 'completed', items: [], error: null },
        });
        expect(await service.openSession('history-thread')).toMatchObject({
          responseInProgress: true,
          responseThreadIds: ['history-thread'],
        });

        expect(await service.cancelResponse('history-thread')).toEqual({ requested: true });
        deepStrictEqual(client.requests.findLast(({ method }) => method === 'turn/interrupt'), {
          method: 'turn/interrupt',
          params: { threadId: 'history-thread', turnId: 'turn-2' },
        });
        expect(client.requests.filter(({ method }) => method === 'thread/resume').map(({ params }) => params.threadId)).toEqual([
          'running-thread',
          'history-thread',
        ]);
        client.emit('turn/completed', {
          threadId: 'history-thread',
          turn: { id: 'turn-2', status: 'interrupted', items: [], error: null },
        });
        expect(await service.cancelResponse('history-thread')).toEqual({ requested: false });
      } finally {
        removeListener();
        service.stop();
      }
    });

    test('reports a missing thread id returned by Codex', async () => {
      const client = createFakeClient({
        'thread/start': { thread: thread('missing-thread', { id: null }) },
      });
      const service = createService(client);
      const events: Array<Record<string, unknown>> = [];
      const removeListener = service.onEvent((event) => events.push(event));
      try {
        await expectFailure(
          () => service.sendMessage('Inspect this project', 'client-missing-thread'),
          'Codex did not return a thread id.',
        );
        expect(events).toContainEqual({
          type: 'error',
          message: 'Codex did not return a thread id.',
          clientMessageId: 'client-missing-thread',
        });
      } finally {
        removeListener();
        service.stop();
      }
    });

    test('streams the active turn, reports tools, and interrupts it', async () => {
      let commandRunning = true;
      const client = createFakeClient({
        'thread/start': { thread: thread('new-thread') },
        'turn/start': { turn: { id: 'turn-2', items: [], status: 'inProgress' } },
        'turn/interrupt': {},
        'thread/backgroundTerminals/list': () => ({ data: commandRunning ? [{ itemId: 'command-2', processId: 'process-2' }] : [], nextCursor: null }),
        'thread/backgroundTerminals/terminate': () => { commandRunning = false; return { terminated: true }; },
      });
      const service = createService(client);
      const events: Array<Record<string, unknown>> = [];
      const removeListener = service.onEvent((event) => events.push(event));
      try {
        await service.sendMessage('Inspect this project', 'client-2');
        client.emit('item/reasoning/summaryTextDelta', {
          threadId: 'new-thread',
          turnId: 'turn-2',
          itemId: 'reasoning-2',
          delta: 'Looking around',
        });
        client.emit('item/started', {
          threadId: 'new-thread',
          turnId: 'turn-2',
          item: { type: 'commandExecution', id: 'command-2', command: 'rg --files', status: 'inProgress' },
        });
        client.emit('item/fileChange/patchUpdated', {
          threadId: 'new-thread',
          turnId: 'turn-2',
          itemId: 'files-2',
          changes: [{
            path: '/workspace/cheshi/app.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-old value\n+new value',
          }],
        });
        client.emit('item/completed', {
          threadId: 'new-thread',
          turnId: 'turn-2',
          item: { type: 'reasoning', id: 'reasoning-fallback', summary: ['Validated the result'], content: [] },
        });
        client.emit('item/agentMessage/delta', {
          threadId: 'new-thread',
          turnId: 'turn-2',
          itemId: 'assistant-2',
          delta: 'I found it.',
        });
        expect(await service.cancelResponse()).toEqual({ requested: true });
        client.emit('turn/completed', {
          threadId: 'new-thread',
          turn: { id: 'turn-2', status: 'interrupted', items: [], error: null },
        });

        expect(events).toContainEqual({
          type: 'turn-started',
          threadId: 'new-thread',
          turnId: 'turn-2',
          clientMessageId: 'client-2',
        });
        expect(events).toContainEqual({
          type: 'reasoning-delta',
          threadId: 'new-thread',
          turnId: 'turn-2',
          itemId: 'reasoning-2',
          text: 'Looking around',
        });
        expect(events).toContainEqual({
          type: 'activity',
          threadId: 'new-thread',
          turnId: 'turn-2',
          item: {
            id: 'command-2',
            kind: 'activity',
            activity: 'command',
            label: 'Command',
            detail: 'rg --files',
            status: 'inProgress',
          },
        });
        expect(events).toContainEqual({
          type: 'activity',
          threadId: 'new-thread',
          turnId: 'turn-2',
          item: {
            id: 'files-2',
            kind: 'activity',
            activity: 'files',
            label: 'File changes',
            detail: '1 file',
            status: 'inProgress',
            changes: [{
              path: '/workspace/cheshi/app.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old value\n+new value',
              movePath: null,
            }],
          },
        });
        expect(events).toContainEqual({
          type: 'reasoning-delta',
          threadId: 'new-thread',
          turnId: 'turn-2',
          itemId: 'reasoning-fallback',
          text: 'Validated the result',
        });
        expect(events).toContainEqual({
          type: 'assistant-delta',
          threadId: 'new-thread',
          turnId: 'turn-2',
          itemId: 'assistant-2',
          text: 'I found it.',
        });
        deepStrictEqual(client.requests.findLast(({ method }) => method === 'turn/interrupt'), {
          method: 'turn/interrupt',
          params: { threadId: 'new-thread', turnId: 'turn-2' },
        });
        expect(await service.cancelResponse()).toEqual({ requested: false });
      } finally {
        removeListener();
        service.stop();
      }
    });

    test('unsubscribes an idle viewed thread before starting a new chat', async () => {
      const client = createFakeClient({
        'thread/start': { thread: thread('new-thread') },
        'turn/start': { turn: { id: 'turn-3', items: [], status: 'inProgress' } },
        'thread/unsubscribe': { status: 'notLoaded' },
      });
      const service = createService(client);
      try {
        await service.sendMessage('Hello', 'client-3');
        client.emit('turn/completed', {
          threadId: 'new-thread',
          turn: { id: 'turn-3', status: 'completed', items: [], error: null },
        });
        expect(await service.newSession()).toEqual({ sessionId: null, items: [] });
        deepStrictEqual(client.requests.at(-1), {
          method: 'thread/unsubscribe',
          params: { threadId: 'new-thread' },
        });
      } finally {
        service.stop();
      }
    });
  });
}
