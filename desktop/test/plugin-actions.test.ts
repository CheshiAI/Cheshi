import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SkillRecordingStore } from '../lib/skill-recording-store.mts';
import { marketplaceAddRequest, pluginWorkflowRequest, type SkillRecordingUpload } from '../shared/plugin-actions.ts';
import { codexThread, createCodexChatService, createFakeCodexClient, expectFailure } from './codex-chat-test-helpers.ts';

function workflowClient(skillName = 'plugin-creator', allowed: unknown = true) {
  return createFakeCodexClient({
    'plugin/list': { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    'skills/list': { data: [{ cwd: '/workspace/cheshi', errors: [], skills: [{
      name: skillName, description: 'Create a reusable workflow.', enabled: true,
      path: `/skills/${skillName}/SKILL.md`, scope: 'user',
    }] }] },
    'permissionProfile/list': { data: [{ id: ':workspace', description: 'Workspace access.', allowed }], nextCursor: null },
    'thread/start': { thread: codexThread('created-thread') },
    'thread/read': { thread: codexThread('existing-thread') },
    'turn/start': { turn: { id: 'created-turn', items: [], status: 'inProgress' } },
  });
}

describe('plugin action boundaries', () => {
  test('normalizes sources and optional Git refs without shell interpretation', () => {
    expect(marketplaceAddRequest({ source: ' owner/repo ', refName: ' release ' })).toEqual({ source: 'owner/repo', refName: 'release' });
    expect(marketplaceAddRequest({ source: '/a folder/marketplace' })).toEqual({ source: '/a folder/marketplace' });
    expect(() => marketplaceAddRequest({ source: '' })).toThrow('Marketplace source');
    expect(() => marketplaceAddRequest({ source: ['repo'] })).toThrow('Marketplace source');
    expect(() => marketplaceAddRequest({ source: 'repo\0other' })).toThrow('Marketplace source');
    expect(() => marketplaceAddRequest({ source: 'repo', refName: true })).toThrow('Git ref');
  });

  test('normalizes optional repository folders and preserves folders containing spaces', () => {
    expect(marketplaceAddRequest({
      source: 'owner/repo',
      sparsePaths: [' plugins/my-plugin ', 'shared tools', 'plugins/my-plugin'],
    })).toEqual({ source: 'owner/repo', sparsePaths: ['plugins/my-plugin', 'shared tools'] });
    expect(marketplaceAddRequest({ source: 'owner/repo', sparsePaths: [] })).toEqual({ source: 'owner/repo' });
  });

  test('rejects malformed or escaping repository folders', () => {
    for (const sparsePaths of ['plugins/foo', [true], [''], ['/etc'], ['C:\\plugins'], ['../outside'], ['plugins/../outside'], ['plugins\\..\\outside'], Array(129).fill('plugins')]) {
      expect(() => marketplaceAddRequest({ source: 'owner/repo', sparsePaths })).toThrow('Repository folder');
    }
  });

  test('requires a recording only for skill creation and rejects unknown workflows', () => {
    expect(pluginWorkflowRequest({ kind: 'plugin', description: ' Build a plugin ' })).toEqual({ kind: 'plugin', description: 'Build a plugin' });
    expect(() => pluginWorkflowRequest({ kind: 'skill', description: 'Build a skill' })).toThrow('Record a workflow');
    expect(() => pluginWorkflowRequest({ kind: 'plugin', description: 'Build', recordingId: 'id' })).toThrow('does not accept a recording');
    expect(() => pluginWorkflowRequest({ kind: 'command', description: 'Run' })).toThrow('Invalid plugin workflow');
  });
});

describe('connected plugin workflows', () => {
  test('registers the requested marketplace through the Codex API', async () => {
    const result = { marketplaceName: 'team', installedRoot: '/plugins/team', alreadyAdded: false };
    const client = createFakeCodexClient({ 'marketplace/add': result });
    const service = createCodexChatService(client);
    try {
      expect(await service.addMarketplace({ source: ' team/plugins ', refName: ' main ', sparsePaths: [' plugins/my-plugin ', 'shared/tools'] })).toEqual(result);
      expect(client.requests).toEqual([{ method: 'marketplace/add', params: { source: 'team/plugins', refName: 'main', sparsePaths: ['plugins/my-plugin', 'shared/tools'] } }]);
    } finally { service.stop(); }
  });

  test('preserves explicit branch, tag, and commit refs while leaving defaults to Codex', async () => {
    const result = { marketplaceName: 'team', installedRoot: '/plugins/team', alreadyAdded: false };
    const client = createFakeCodexClient({ 'marketplace/add': result });
    const service = createCodexChatService(client);
    try {
      for (const refName of ['feature/plugins', 'v1.0.0', '0123456789abcdef0123456789abcdef01234567']) {
        await service.addMarketplace({ source: 'team/plugins', refName });
        expect(client.requests.at(-1)?.params).toEqual({ source: 'team/plugins', refName });
      }
      await service.addMarketplace({ source: 'team/plugins' });
      expect(client.requests.at(-1)?.params).toEqual({ source: 'team/plugins' });
      await expectFailure(() => service.addMarketplace({ source: 'team/plugins', sparsePaths: ['../outside'] }), 'Repository folders must be relative paths inside the repository.');
      expect(client.requests).toHaveLength(4);
    } finally { service.stop(); }
  });

  test('rejects malformed registration responses and propagates registration errors', async () => {
    for (const response of [
      { marketplaceName: 'team', installedRoot: '/plugins/team', alreadyAdded: 'true' },
      new Error('Repository is not a marketplace.'),
    ]) {
      const service = createCodexChatService(createFakeCodexClient({ 'marketplace/add': response }));
      try {
        await expectFailure(() => service.addMarketplace({ source: 'team/plugins' }), response instanceof Error ? response.message : 'The marketplace registration response is invalid.');
      } finally { service.stop(); }
    }
  });

  test('starts plugin creation in a fresh chat with the creator skill and approval mode', async () => {
    const client = workflowClient();
    const service = createCodexChatService(client);
    try {
      await service.openSession('existing-thread');
      expect(await service.startPluginWorkflow({ kind: 'plugin', description: 'Build a release helper.' })).toEqual({ threadId: 'created-thread', turnId: 'created-turn' });
      expect(client.requests.find(({ method }) => method === 'thread/start')?.params).toMatchObject({
        cwd: '/workspace/cheshi', permissions: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      });
      const turn = client.requests.find(({ method }) => method === 'turn/start')?.params;
      expect(turn).toMatchObject({ threadId: 'created-thread', permissions: ':workspace', approvalPolicy: 'on-request' });
      expect(turn?.input).toEqual([
        { type: 'skill', name: 'plugin-creator', path: '/skills/plugin-creator/SKILL.md' },
        { type: 'text', text: expect.stringContaining('Build a release helper.'), text_elements: [] },
      ]);
    } finally { service.stop(); }
  });

  test('attaches the recording and preview frames to skill creation', async () => {
    const client = workflowClient('skill-creator');
    const service = createCodexChatService(client);
    try {
      await service.startPluginWorkflow({ kind: 'skill', description: 'Repeat the export.', recordingId: 'saved-recording' }, [
        { kind: 'file', name: 'recording.webm', path: '/recordings/recording.webm' },
        { kind: 'file', name: 'recording.json', path: '/recordings/recording.json' },
        { kind: 'image', name: 'frame-0.jpg', path: '/recordings/frame-0.jpg' },
      ]);
      const input = client.requests.find(({ method }) => method === 'turn/start')?.params.input;
      expect(input).toEqual([
        { type: 'skill', name: 'skill-creator', path: '/skills/skill-creator/SKILL.md' },
        { type: 'text', text: expect.stringContaining('/recordings/recording.webm'), text_elements: [] },
        { type: 'localImage', path: '/recordings/frame-0.jpg' },
      ]);
    } finally { service.stop(); }
  });

  test('does not start a chat when the creator skill or file permission is unavailable', async () => {
    const cases = [
      { client: workflowClient('another-skill'), message: 'Install the plugin-creator skill before starting this workflow.' },
      { client: workflowClient('plugin-creator', false), message: 'This workflow requires permission to edit files with approval for additional access.' },
      { client: workflowClient('plugin-creator', 'true'), message: 'This workflow requires permission to edit files with approval for additional access.' },
    ];
    for (const { client, message } of cases) {
      const service = createCodexChatService(client);
      try {
        await expectFailure(() => service.startPluginWorkflow({ kind: 'plugin', description: 'Build a plugin.' }), message);
        expect(client.requests.some(({ method }) => method === 'thread/start' || method === 'turn/start')).toBe(false);
      } finally { service.stop(); }
    }
  });

  test('does not start skill creation without captured frames', async () => {
    const client = workflowClient('skill-creator');
    const service = createCodexChatService(client);
    try {
      await expectFailure(() => service.startPluginWorkflow({ kind: 'skill', description: 'Export', recordingId: 'recording' }), 'The recording has no preview frames. Record the workflow again.');
      expect(client.requests.some(({ method }) => method === 'turn/start')).toBe(false);
    } finally { service.stop(); }
  });
});

function recordingFixture(): SkillRecordingUpload {
  return {
    video: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
    durationSeconds: 10,
    frames: [{ seconds: 0, image: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}` }],
  };
}

async function withRecordingStore(run: (store: SkillRecordingStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-recording-test-'));
  try { await run(new SkillRecordingStore(directory), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('skill recording storage', () => {
  test('persists recording data and resolves only its own attachments within the chat limit', async () => {
    await withRecordingStore(async (store, directory) => {
      const recording = recordingFixture();
      recording.frames = Array.from({ length: 18 }, (_, index) => ({ ...recording.frames[0]!, seconds: index / 2 }));
      const saved = await store.save(recording);
      expect(saved).toMatchObject({ frameCount: 18, durationSeconds: 10 });
      const attachments = await store.attachments(saved.id);
      expect(attachments).toHaveLength(20);
      expect(attachments.slice(0, 2).map(({ name }) => name)).toEqual(['recording.json', 'recording.webm']);
      expect(attachments.every((attachment) => attachment.path.startsWith(path.join(directory, saved.id) + path.sep))).toBe(true);
      expect(await readFile(path.join(directory, saved.id, 'recording.webm'))).toEqual(Buffer.from(recording.video));
      const manifest = JSON.parse(await readFile(path.join(directory, saved.id, 'recording.json'), 'utf8'));
      expect(manifest.frames.at(-1)).toEqual({ seconds: 8.5, file: 'frame-17.jpg' });
    });
  });

  test('rejects invalid uploads before creating any files', async () => {
    await withRecordingStore(async (store, directory) => {
      const cases = [
        { value: { ...recordingFixture(), video: new Uint8Array([1, 2, 3, 4]) }, message: 'Recording must be WebM video.' },
        { value: { ...recordingFixture(), durationSeconds: Number.NaN }, message: 'Recording duration must be at most two minutes.' },
        { value: { ...recordingFixture(), frames: [] }, message: 'Recording must contain between 1 and 18 preview frames.' },
        { value: { ...recordingFixture(), frames: [{ seconds: 11, image: 'unused' }] }, message: 'Recording frame timestamps must be ordered and inside the recording.' },
        { value: { ...recordingFixture(), frames: [{ seconds: 0, image: 'data:image/jpeg;base64,AAAA' }] }, message: 'Invalid JPEG frame.' },
      ];
      for (const { value, message } of cases) await expectFailure(() => store.save(value), message);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('rejects traversal ids and tampered frame paths', async () => {
    await withRecordingStore(async (store, directory) => {
      await expectFailure(() => store.attachments('../elsewhere'), 'Invalid recording id.');
      const saved = await store.save(recordingFixture());
      await writeFile(path.join(directory, saved.id, 'recording.json'), JSON.stringify({ frames: [{ file: '../outside.jpg' }] }));
      await expectFailure(() => store.attachments(saved.id), 'Recording frame path is invalid.');
    });
  });
});
