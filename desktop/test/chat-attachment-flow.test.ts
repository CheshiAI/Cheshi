import { afterEach, describe, expect, test } from 'bun:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ChatAttachmentStore } from '../lib/chat-attachment-store.mts';
import { timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import {
  codexThread as thread,
  createCodexChatService as createService,
  createFakeCodexClient as createFakeClient,
  expectFailure,
} from './codex-chat-test-helpers.ts';
import { loadForgeConfiguration } from './forge-test-helpers.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-chat-attachments-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('persistent chat attachment flow', () => {
  test('keeps attachments after source deletion and restores their paths from chat history', async () => {
    const root = await temporaryDirectory();
    const sourceDirectory = path.join(root, 'incoming');
    await mkdir(sourceDirectory);
    const imageSource = path.join(sourceDirectory, 'stage-photo.png');
    const fileSource = path.join(sourceDirectory, 'notes.txt');
    const duplicateImageSource = path.join(sourceDirectory, 'stage-photo-copy.PNG');
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const fileText = 'persistent attachment notes';
    await Promise.all([
      writeFile(imageSource, imageBytes),
      writeFile(duplicateImageSource, imageBytes),
      writeFile(fileSource, fileText),
    ]);

    const store = new ChatAttachmentStore({ directory: path.join(root, 'user-data', 'chat-attachments') });
    const [image, file, duplicateImage] = await store.importFiles([
      imageSource,
      fileSource,
      duplicateImageSource,
    ]);
    if (!image || !file || !duplicateImage) {
      throw new Error('Expected all three chat attachments to be imported.');
    }
    expect(image.kind).toBe('image');
    expect(file.kind).toBe('file');
    expect(duplicateImage.path).toBe(image.path);
    expect(path.basename(image.path)).toMatch(/^[a-f0-9]{64}\.png$/);

    await Promise.all([unlink(imageSource), unlink(duplicateImageSource), unlink(fileSource)]);
    deepStrictEqual(await readFile(image.path), imageBytes);
    expect(await readFile(file.path, 'utf8')).toBe(fileText);

    const durableAttachments = await store.importAttachments([
      { ...image, name: 'stage-photo.png' },
      { ...file, name: 'notes.txt' },
    ]);
    expect(durableAttachments.map(({ name }) => name)).toEqual(['stage-photo.png', 'notes.txt']);

    const sendingClient = createFakeClient({
      'thread/start': { thread: thread('attachment-thread') },
      'turn/start': { turn: { id: 'attachment-turn', items: [], status: 'inProgress' } },
    });
    const sendingService = createService(sendingClient);
    try {
      await sendingService.sendMessage(
        'Review these attachments',
        'client-attachment-flow',
        null,
        durableAttachments,
      );
    } finally {
      sendingService.stop();
    }

    const sentInput = sendingClient.requests.find(({ method }) => method === 'turn/start')?.params.input;
    if (!Array.isArray(sentInput)) throw new Error('Codex did not receive the expected attachment input.');
    deepStrictEqual(sentInput, [
      {
        type: 'text',
        text: `Review these attachments\n\nAttached files:\n- ${JSON.stringify(file.path)}`,
        text_elements: [],
      },
      { type: 'localImage', path: image.path },
    ]);

    const reopeningClient = createFakeClient({
      'thread/read': {
        thread: thread('attachment-thread', {
          turns: [{
            id: 'attachment-turn',
            startedAt: 130,
            completedAt: 140,
            status: 'completed',
            items: [
              { type: 'userMessage', id: 'user-attachment', content: sentInput },
              { type: 'agentMessage', id: 'assistant-attachment', text: 'Attachments reviewed.' },
            ],
          }],
        }),
      },
    });
    const reopeningService = createService(reopeningClient);
    try {
      const restored = await reopeningService.openSession('attachment-thread');
      expect(restored.items).toEqual([
        {
          id: 'user-attachment',
          turnId: 'attachment-turn',
          kind: 'user',
          text: `Review these attachments\n\nAttached files:\n- ${JSON.stringify(file.path)}\n\n[Image: ${image.path}]`,
          createdAt: 130,
        },
        {
          id: 'assistant-attachment',
          turnId: 'attachment-turn',
          kind: 'assistant',
          text: 'Attachments reviewed.',
          createdAt: 140,
        },
      ]);
    } finally {
      reopeningService.stop();
    }

    deepStrictEqual(await readFile(image.path), imageBytes);
    expect(await readFile(file.path, 'utf8')).toBe(fileText);
  });

  test('rejects non-file and relative attachment sources', async () => {
    const root = await temporaryDirectory();
    const store = new ChatAttachmentStore({ directory: path.join(root, 'chat-attachments') });
    await expectFailure(
      () => store.importFile(root),
      'Chat attachments must be regular files.',
    );
    await expectFailure(
      () => store.importFile('relative.png'),
      'Chat attachment path must be absolute.',
    );
  });

  test('preserves ordinary text, mention and skill spacing when restoring input', () => {
    const items = timelineFromThread({ turns: [{ startedAt: 1, items: [{
      type: 'userMessage', id: 'user', content: [
        { type: 'text', text: 'Review this' },
        { type: 'mention', name: 'notes.txt' },
        { type: 'skill', name: 'review' },
        { type: 'unknown' },
        { type: 'text', text: 'Keep existing spacing.' },
      ],
    }] }] });
    expect(items[0]?.text).toBe('Review this\n@notes.txt\n$review\nKeep existing spacing.');
  });

  test('includes the attachment store in packaged desktop builds', async () => {
    const configuration = await loadForgeConfiguration();
    const shouldIgnore = configuration.packagerConfig.ignore;
    if (typeof shouldIgnore !== 'function') throw new Error('Forge ignore configuration is unavailable.');
    strictEqual(shouldIgnore('/desktop/lib/chat-attachment-store.mts'), false);
    strictEqual(shouldIgnore('/desktop/lib/not-packaged.mjs'), true);
  });
});
