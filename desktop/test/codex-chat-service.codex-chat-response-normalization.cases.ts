import {
  goalFromResponse,
  mcpServersFromListResponse,
  modelsFromListResponse,
  permissionModesFromListResponse,
  pluginFromReadResponse,
  pluginInstallResultFromResponse,
  pluginsFromListResponse,
  sessionsFromListResponse,
  skillsFromListResponse,
  timelineFromThread,
} from '../lib/codex-chat-service.mts';
import { codexThread as thread } from './codex-chat-test-helpers.ts';
import { describe, expect, test } from 'bun:test';

export function registerCodexChatResponseNormalizationTests(): void {


  describe('Codex chat response normalization', () => {
    test('normalizes root sessions and filters subagent threads', () => {
      expect(sessionsFromListResponse({
        data: [
          thread('root', { name: 'Named chat' }),
          thread('preview-only'),
          thread('subagent', { parentThreadId: 'root' }),
          thread('guardian', { source: { subAgent: { other: 'guardian' } } }),
          thread('review', { source: { subAgent: 'review' } }),
          thread('spawn', { source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } } }),
          thread('compact', { source: 'subAgentCompact' }),
        ],
      })).toEqual([
        {
          id: 'root',
          title: 'Named chat',
          preview: 'Inspect the workspace',
          createdAt: 100,
          updatedAt: 120,
          status: 'idle',
        },
        {
          id: 'preview-only',
          title: 'Inspect the workspace',
          preview: 'Inspect the workspace',
          createdAt: 100,
          updatedAt: 120,
          status: 'idle',
        },
      ]);
    });

    test('restores messages, reasoning, tools, and failures from thread history', () => {
      const items = timelineFromThread({
        thread: thread('thread-1', {
          turns: [{
            id: 'turn-1',
            startedAt: 130,
            completedAt: 140,
            status: 'failed',
            error: { message: 'The response stopped.' },
            items: [
              { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'Hello', text_elements: [] }] },
              { type: 'reasoning', id: 'reasoning-1', summary: ['Checking files'], content: [] },
              {
                type: 'commandExecution',
                id: 'command-1',
                command: 'rg --files',
                status: 'completed',
              },
              {
                type: 'fileChange',
                id: 'files-1',
                changes: [{
                  path: '/workspace/cheshi/app.ts',
                  kind: { type: 'update', move_path: null },
                  diff: '@@ -1,2 +1,2 @@\n-old value\n+new value\n unchanged',
                }],
                status: 'completed',
              },
              { type: 'agentMessage', id: 'assistant-1', text: 'Done.' },
            ],
          }],
        }),
      });

      expect(items).toEqual([
        { id: 'user-1', kind: 'user', text: 'Hello', createdAt: 130 },
        { id: 'reasoning-1', kind: 'reasoning', text: 'Checking files', createdAt: 130 },
        {
          id: 'command-1',
          kind: 'activity',
          activity: 'command',
          label: 'Command',
          detail: 'rg --files',
          status: 'completed',
        },
        {
          id: 'files-1',
          kind: 'activity',
          activity: 'files',
          label: 'File changes',
          detail: '1 file',
          status: 'completed',
          changes: [{
            path: '/workspace/cheshi/app.ts',
            kind: 'update',
            diff: '@@ -1,2 +1,2 @@\n-old value\n+new value\n unchanged',
            movePath: null,
          }],
        },
        { id: 'assistant-1', kind: 'assistant', text: 'Done.', createdAt: 140 },
        {
          id: 'turn-1:error',
          kind: 'activity',
          activity: 'error',
          label: 'Response failed',
          detail: 'The response stopped.',
          status: 'failed',
        },
      ]);
    });

    test('normalizes enabled skills for the selected workspace', () => {
      expect(skillsFromListResponse({
        data: [
          {
            cwd: '/workspace/other',
            errors: [],
            skills: [{
              name: 'other-skill',
              description: 'Not in this workspace.',
              enabled: true,
              path: '/skills/other/SKILL.md',
              scope: 'user',
            }],
          },
          {
            cwd: '/workspace/cheshi',
            errors: [],
            skills: [
              {
                name: 'system-skill',
                description: 'System workflow.',
                enabled: true,
                path: '/skills/system/SKILL.md',
                scope: 'system',
              },
              {
                name: 'personal-skill',
                description: 'Long personal workflow description.',
                enabled: true,
                interface: {
                  displayName: 'Personal Skill',
                  shortDescription: 'Personal workflow.',
                },
                path: '/skills/personal/SKILL.md',
                scope: 'user',
              },
              {
                name: 'disabled-skill',
                description: 'Disabled.',
                enabled: false,
                path: '/skills/disabled/SKILL.md',
                scope: 'user',
              },
            ],
          },
        ],
      }, '/workspace/cheshi')).toEqual([
        {
          name: 'personal-skill',
          displayName: 'Personal Skill',
          description: 'Personal workflow.',
          scope: 'user',
          path: '/skills/personal/SKILL.md',
        },
        {
          name: 'system-skill',
          displayName: 'system-skill',
          description: 'System workflow.',
          scope: 'system',
          path: '/skills/system/SKILL.md',
        },
      ]);
    });

    test('normalizes visible models and their reasoning levels', () => {
      expect(modelsFromListResponse({
        data: [
          {
            id: 'model-default',
            model: 'gpt-default',
            displayName: 'GPT Default',
            description: 'Default coding model.',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Faster responses.' },
              { reasoningEffort: 'medium', description: 'Balanced responses.' },
            ],
            serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Faster responses.' }],
            defaultServiceTier: null,
          },
          {
            id: 'model-hidden',
            model: 'gpt-hidden',
            displayName: 'GPT Hidden',
            description: 'Not selectable.',
            hidden: true,
            isDefault: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [],
          },
        ],
      })).toEqual([{
        id: 'model-default',
        model: 'gpt-default',
        displayName: 'GPT Default',
        description: 'Default coding model.',
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { effort: 'low', description: 'Faster responses.' },
          { effort: 'medium', description: 'Balanced responses.' },
        ],
        serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Faster responses.' }],
        defaultServiceTier: null,
      }]);
    });

    test('normalizes MCP server status and persistent goals', () => {
      expect(mcpServersFromListResponse({
        data: [{
          name: 'codegraph',
          pluginId: null,
          serverInfo: {
            name: 'codegraph-server',
            title: 'CodeGraph',
            version: '1.5.0',
          },
          tools: { explore: {}, status: {} },
          resources: [{}],
          resourceTemplates: [{}, {}],
          authStatus: 'oAuth',
        }],
        nextCursor: null,
      })).toEqual([{
        name: 'codegraph',
        displayName: 'CodeGraph',
        version: '1.5.0',
        toolCount: 2,
        resourceCount: 1,
        resourceTemplateCount: 2,
        authStatus: 'oAuth',
        runtimeStatus: 'connected',
        toolsError: null,
        connected: true,
      }]);

      expect(goalFromResponse({
        goal: {
          threadId: 'goal-thread',
          objective: 'Finish the chat experience',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 320,
          timeUsedSeconds: 18,
        },
      })).toEqual({
        goal: {
          threadId: 'goal-thread',
          objective: 'Finish the chat experience',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 320,
          timeUsedSeconds: 18,
        },
      });
    });

    test('uses configured server names for generic rmcp metadata while preserving descriptive titles', () => {
      const servers = mcpServersFromListResponse({ data: [
        { name: 'cua_repl', serverInfo: { name: 'rmcp' } },
        { name: 'node_repl', serverInfo: { title: ' RMCP ', name: 'rmcp' } },
        { name: 'custom', serverInfo: { title: 'Custom Tools', name: 'rmcp' } },
      ] });
      expect(servers.map(server => server.displayName)).toEqual(['cua_repl', 'node_repl', 'Custom Tools']);
    });

    test.each([
      'notStarted', 'starting', 'connected', 'authenticationRequired',
      'failed', 'cancelled', 'disabled',
    ])('uses explicit MCP runtime state %s independently of authentication and cached metadata', (runtimeStatus) => {
      const [server] = mcpServersFromListResponse({
        data: [{
          name: 'computer-use',
          serverInfo: { name: 'cached-computer-use' },
          runtimeStatus,
          authStatus: 'unsupported',
          tools: {},
        }],
      });

      expect(server).toMatchObject({
        runtimeStatus,
        authStatus: 'unsupported',
        connected: runtimeStatus === 'connected',
        toolCount: 0,
        toolsError: null,
      });
    });

    test.each([null, 'unsupported', false, 1, {}])(
      'keeps an explicit unknown or invalid MCP runtime state unknown: %j',
      (runtimeStatus) => {
        const [server] = mcpServersFromListResponse({
          data: [{
            name: 'computer-use',
            runtimeStatus,
            serverInfo: { name: 'cached-computer-use' },
            authStatus: 'oAuth',
          }],
        });

        expect(server).toMatchObject({ runtimeStatus: null, connected: false, authStatus: 'oAuth' });
      },
    );

    test('does not infer a connection failure from unsupported authentication or an empty tool list', () => {
      const [server] = mcpServersFromListResponse({
        data: [{ name: 'computer-use', authStatus: 'unsupported', tools: {} }],
      });

      expect(server).toMatchObject({
        runtimeStatus: null,
        connected: false,
        authStatus: 'unsupported',
        toolCount: 0,
        toolsError: null,
      });
    });

    test('preserves tool discovery errors independently of a connected runtime', () => {
      const [server] = mcpServersFromListResponse({
        data: [{
          name: 'computer-use',
          runtimeStatus: 'connected',
          authStatus: 'unsupported',
          toolsError: '  Tools discovery timed out.  ',
        }],
      });

      expect(server).toMatchObject({
        runtimeStatus: 'connected',
        connected: true,
        toolsError: 'Tools discovery timed out.',
      });
    });

    test.each([null, '', '  ', {}, true])('normalizes empty or invalid MCP tool errors: %j', (toolsError) => {
      const [server] = mcpServersFromListResponse({ data: [{ name: 'computer-use', toolsError }] });
      expect(server?.toolsError).toBeNull();
    });

    test('normalizes built-in and custom permission profiles', () => {
      const modes = permissionModesFromListResponse({
        data: [
          { id: ':read-only', description: 'Read-only access.', allowed: true },
          { id: ':workspace', description: 'Workspace access.', allowed: true },
          { id: ':danger-full-access', description: 'Unrestricted access.', allowed: false },
          { id: ':team-profile', description: 'Team policy.', allowed: true },
        ],
        nextCursor: null,
      });

      expect(modes).toHaveLength(5);
      expect(modes).toContainEqual(expect.objectContaining({
        id: 'read-only',
        profileId: ':read-only',
        access: 'Read only',
        allowed: true,
      }));
      expect(modes).toContainEqual(expect.objectContaining({
        id: 'ask-for-approval',
        profileId: ':workspace',
        access: 'Ask for approval',
        allowed: true,
      }));
      expect(modes).toContainEqual(expect.objectContaining({
        id: 'approve-for-me',
        profileId: ':workspace',
        access: 'Approve for me',
        allowed: true,
      }));
      expect(modes).toContainEqual(expect.objectContaining({
        id: 'full-access',
        profileId: ':danger-full-access',
        allowed: false,
        dangerous: true,
      }));
      expect(modes).toContainEqual({
        id: 'custom::team-profile',
        profileId: ':team-profile',
        label: 'team-profile',
        description: 'Team policy.',
        access: 'team-profile',
        allowed: true,
        dangerous: false,
      });
    });

    test('normalizes plugin catalogs, details, and install results', () => {
      const summary = {
        id: 'gmail@openai-curated-remote',
        name: 'gmail',
        remotePluginId: 'plugin_gmail_remote',
        source: { type: 'remote' },
        installed: false,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_INSTALL',
        availability: 'AVAILABLE',
        version: '1.2.0',
        interface: {
          displayName: 'Gmail',
          shortDescription: 'Read and manage Gmail.',
          longDescription: 'Search, read, and manage Gmail messages.',
          developerName: 'OpenAI',
          category: 'Productivity',
          capabilities: ['Search', 'Email'],
          defaultPrompt: ['Find my latest receipt'],
          brandColor: '#ea4335',
        },
        keywords: ['mail', 'inbox'],
      };
      const catalog = pluginsFromListResponse({
        marketplaces: [{
          name: 'openai-curated-remote',
          path: null,
          interface: { displayName: 'OpenAI Curated' },
          plugins: [summary],
        }],
        featuredPluginIds: ['gmail@openai-curated-remote'],
        marketplaceLoadErrors: [{ marketplacePath: '/broken/marketplace.json', message: 'Invalid manifest.' }],
      });

      expect(catalog).toEqual({
        plugins: [expect.objectContaining({
          id: 'gmail@openai-curated-remote',
          name: 'gmail',
          displayName: 'Gmail',
          shortDescription: 'Read and manage Gmail.',
          installed: false,
          enabled: true,
          source: 'remote',
          marketplaceDisplayName: 'OpenAI Curated',
          reference: { pluginName: 'plugin_gmail_remote', remoteMarketplaceName: 'openai-curated-remote' },
        })],
        featuredPluginIds: ['gmail@openai-curated-remote'],
        marketplaceErrors: [{ marketplacePath: '/broken/marketplace.json', message: 'Invalid manifest.' }],
      });

      expect(pluginFromReadResponse({
        plugin: {
          marketplaceName: 'openai-curated-remote',
          marketplacePath: null,
          summary,
          description: 'Use Gmail directly from Codex.',
          shareUrl: 'https://example.com/plugins/gmail',
          skills: [{
            name: 'gmail-search',
            description: 'Search Gmail.',
            enabled: true,
            path: null,
            interface: { displayName: 'Gmail Search', shortDescription: 'Find messages.' },
          }],
          apps: [{ id: 'gmail', name: 'Gmail', description: 'Google mail', category: 'Productivity', installUrl: 'https://example.com/connect' }],
          appTemplates: [{ templateId: 'gmail-template', name: 'Gmail workspace app', materializedAppIds: [] }],
          mcpServers: ['gmail'],
          hooks: [{ key: 'gmail-stop', eventName: 'stop' }],
          scheduledTasks: [{ key: 'inbox-digest', name: 'Inbox digest', prompt: 'Summarize mail.', schedule: {} }],
        },
      })).toEqual({
        plugin: expect.objectContaining({
          id: 'gmail@openai-curated-remote',
          description: 'Use Gmail directly from Codex.',
          reference: { pluginName: 'plugin_gmail_remote', remoteMarketplaceName: 'openai-curated-remote' },
          skills: [{ name: 'gmail-search', displayName: 'Gmail Search', description: 'Find messages.', enabled: true }],
          apps: [{ id: 'gmail', name: 'Gmail', description: 'Google mail', category: 'Productivity', installUrl: 'https://example.com/connect' }],
          appTemplates: [{ id: 'gmail-template', name: 'Gmail workspace app', description: '', category: 'App template' }],
          mcpServers: ['gmail'],
          hooks: [{ key: 'gmail-stop', eventName: 'stop' }],
          scheduledTasks: [{ key: 'inbox-digest', name: 'Inbox digest', prompt: 'Summarize mail.' }],
        }),
      });

      expect(pluginInstallResultFromResponse({
        authPolicy: 'ON_INSTALL',
        appsNeedingAuth: [{ id: 'gmail', name: 'Gmail', installUrl: 'https://example.com/connect' }],
      })).toEqual({
        authPolicy: 'ON_INSTALL',
        appsNeedingAuth: [{ id: 'gmail', name: 'Gmail', description: '', category: 'App', installUrl: 'https://example.com/connect' }],
      });
    });
  });
}
