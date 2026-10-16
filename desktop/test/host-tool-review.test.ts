import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { confirmHostToolReview, hostToolReviewDetails, hostToolReviewSummary } from '../lib/agent-management/host-tool-review-content.mts';
import { showHostToolDetails } from '../lib/agent-management/host-tool-details.mts';
import { onHostToolDetails } from '../lib/host-tool-details-preload.cts';
import { HOST_TOOL_DETAILS_CHANNEL, hostToolDetailsReplyChannel, type HostToolDetails } from '../shared/host-tool-details';
import type { HostToolReview } from '../lib/agent-management/host-tool-registration.mts';

const review: HostToolReview = {
  id: 'grant', agentId: 'atlas', accountId: 'account', name: 'Atlas', tool: 'ios_appium', runtime: 'python3',
  workspace: '/projects/cheshi-desktop', executable: '/local/bin/python3', executableHash: 'a'.repeat(64),
  digest: 'b'.repeat(64), script: 'scripts/run.py', output: '/private/output',
  files: Array.from({ length: 500 }, (_, i) => `skills/tool/scripts/file-${i}.py`),
};

test('large bundles keep confirmation concise while details preserve every path and fingerprint', () => {
  const summary = hostToolReviewSummary(review), details = hostToolReviewDetails(review);
  expect(summary.detail!.length).toBeLessThan(600);
  expect(summary.detail).not.toContain(review.files[0]!);
  expect(summary.detail).toContain('not limited to this project folder');
  expect(summary.defaultId).toBe(summary.cancelId);
  for (const value of [...review.files, review.workspace, review.executable, review.executableHash, review.digest, review.accountId]) {
    expect(details).toContain(value);
  }
  expect(hostToolReviewSummary({ ...review, name: 'x'.repeat(5000), workspace: '/p/' + 'p'.repeat(5000) }).message!.length).toBeLessThan(200);
});

test('details cannot approve; returning requires another native confirmation', async () => {
  const responses = [2, 2, 1];
  let views = 0, summaries = 0;
  const approved = await confirmHostToolReview(review, {
    available: () => true,
    summary: async () => { summaries++; return { response: responses.shift()! }; },
    details: async text => { views++; expect(text).toContain(review.digest); return true; },
  });
  expect(approved).toBe(true); expect(summaries).toBe(3); expect(views).toBe(2);
  expect(await confirmHostToolReview(review, {
    available: () => true, summary: async () => ({ response: 2 }), details: async () => false,
  })).toBe(false);
  let available = true;
  expect(await confirmHostToolReview(review, {
    available: () => available,
    summary: async () => { available = false; return { response: 1 }; }, details: async () => true,
  })).toBe(false);
});

function detailsFixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, back: unknown) => void>();
  let payload: HostToolDetails | undefined;
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {},
    send: (channel: string, data: HostToolDetails) => { expect(channel).toBe(HOST_TOOL_DETAILS_CHANNEL); payload = data; } });
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: owner });
  const ipc = { handle: (channel: string, callback: (event: IpcMainInvokeEvent, back: unknown) => void) => { handlers.set(channel, callback); },
    removeHandler: (channel: string) => { handlers.delete(channel); } };
  const result = showHostToolDetails(window as unknown as Parameters<typeof showHostToolDetails>[0], ipc, 'atlas', 'ios_appium', 'full details');
  const respond = (sender: unknown, frame: unknown, back: unknown) => {
    handlers.get(hostToolDetailsReplyChannel(payload!.token))?.({ sender, senderFrame: frame } as IpcMainInvokeEvent, back);
  };
  return { handlers, owner, window, result, respond };
}

test('details replies are bound to the owning main frame and handlers are removed after use', async () => {
  const f = detailsFixture();
  f.respond({}, f.owner.mainFrame, true);
  f.respond(f.owner, {}, true);
  expect(f.handlers.size).toBe(1);
  f.respond(f.owner, f.owner.mainFrame, true);
  expect(await f.result).toBe(true); expect(f.handlers.size).toBe(0);
  expect(f.owner.listenerCount('did-start-navigation')).toBe(0);
  expect(f.window.listenerCount('closed')).toBe(0);
  const malformed = detailsFixture();
  malformed.respond(malformed.owner, malformed.owner.mainFrame, 'true');
  expect(await malformed.result).toBe(false);
});

test('closing or navigating the owning window cancels review without leaving handlers', async () => {
  for (const event of ['closed', 'did-start-navigation', 'render-process-gone']) {
    const f = detailsFixture();
    (event === 'closed' ? f.window : f.owner).emit(event);
    expect(await f.result).toBe(false); expect(f.handlers.size).toBe(0);
  }
});

test('preload only replies to handled details and unsubscribing cancels outstanding UI', async () => {
  const emitter = new EventEmitter(), replies: unknown[][] = [];
  const ipc = Object.assign(emitter, { invoke: async (...args: unknown[]) => { replies.push(args); } });
  const data: HostToolDetails = { token: '00000000-0000-0000-0000-000000000001', agentId: 'atlas', tool: 'ios_appium', text: 'details' };
  const transport = ipc as unknown as Parameters<typeof onHostToolDetails>[0];
  const ignore = onHostToolDetails(transport, () => undefined);
  emitter.emit(HOST_TOOL_DETAILS_CHANNEL, {}, data); expect(replies).toEqual([]); ignore();
  let finish: ((back: boolean) => void) | undefined;
  const unsubscribe = onHostToolDetails(transport, () => new Promise<boolean>(resolve => { finish = resolve; }));
  emitter.emit(HOST_TOOL_DETAILS_CHANNEL, {}, data);
  unsubscribe(); finish!(true); await Promise.resolve();
  expect(replies).toEqual([[hostToolDetailsReplyChannel(data.token), false]]);
  expect(emitter.listenerCount(HOST_TOOL_DETAILS_CHANNEL)).toBe(0);
  expect(() => hostToolDetailsReplyChannel('another-ipc-channel')).toThrow();
});
