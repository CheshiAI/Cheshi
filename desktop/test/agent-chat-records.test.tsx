import { verificationReview, type VerificationReview } from '../frontend/src/features/agent-chats/verificationReviewModel';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useCallback, useState, type ReactNode } from 'react';
import { CommandActivity } from '../frontend/src/features/chat/CommandActivity';
import { ExecutionRecord } from '../frontend/src/features/agent-chats/ExecutionRecord';
import { VerificationMessage } from '../frontend/src/features/agents/VerificationMessage';
import { verificationQuote } from '../frontend/src/features/agents/verificationPresentation';
import { ReviewSidebar } from '../frontend/src/features/shell/ReviewSidebar';
import { fileChangesItem } from '../frontend/src/features/agent-chats/fileChanges';
import type { ChatActivityItem } from '../frontend/src/features/chat/model';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { TaskActivity } from '../shared/agent-activity';
import type { AgentChatsApi, ChatsSnapshot, RoomMessage } from '../shared/agent-chats';

async function withDOM(run: (render: (node: ReactNode) => Promise<void>) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, HTMLDialogElement: window.HTMLDialogElement, ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver, requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div'); document.body.append(container);
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container);
  try { await run(async node => { await act(async () => root.render(node)); }); }
  finally {
    await act(async () => root.unmount()); await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const activity: TaskActivity = { id: 'command', turnId: 'turn', kind: 'command', title: 'bun test',
  text: '', status: 'running', createdAt: '2026-10-05T00:00:00Z', final: false, truncated: false };
const result = { verdicts: [
  { criterion: 'Works', verdict: 'pass', reason: 'Observed', evidenceIds: ['command'] },
  { criterion: 'Builds', verdict: 'fail', reason: 'Missing dependency', evidenceIds: ['command'] },
  { criterion: 'Appearance', verdict: 'inconclusive', reason: 'Not reviewed', evidenceIds: [] },
], evidence: [
  { id: 'command', kind: 'command', detail: 'bun run build', output: '<script>unsafe()</script>\n## literal', exitCode: 1, successful: false },
  { id: 'file', kind: 'file', detail: 'src/main.ts', output: 'a'.repeat(64), exitCode: null },
] };

test('session and Chats use the same command disclosure and retain expansion through status updates', async () => {
  await withDOM(async render => {
    const view = (value: TaskActivity) => <><CommandActivity item={{ id: 'session', kind: 'activity', activity: 'command',
      label: 'Command', detail: value.title, status: 'inProgress' }} /><ExecutionRecord activity={value} /></>;
    await render(view(activity));
    const [session, chats] = [...document.querySelectorAll('details')];
    expect(session?.querySelector('summary')?.className).toBe(chats?.querySelector('summary')?.className);
    expect(chats?.querySelector('summary strong')?.textContent).toBe('Command');
    expect(chats?.querySelector('summary')?.textContent).toContain('Running');
    expect(chats?.open).toBe(false);
    await act(async () => chats!.querySelector('summary')!.click());
    expect(chats?.open).toBe(true);
    await render(view({ ...activity, status: 'failed', final: true, truncated: true, text: 'error\n<script>bad()</script>' }));
    expect(document.querySelectorAll('details')[1]).toBe(chats!);
    expect(chats?.open).toBe(true);
    expect(chats?.querySelector('summary')?.textContent).toContain('Failed');
    expect(chats?.querySelector('[aria-label="Command output"] code')?.textContent).toBe('error\n<script>bad()</script>');
    expect(chats?.querySelector('script')).toBeNull();
    expect(chats?.textContent).toContain('Execution failed.');
    expect(chats?.textContent).toContain('Output shortened');
    await render(view({ ...activity, status: 'unknown' }));
    expect(chats?.querySelector('summary')?.textContent).toContain('Result unknown');
    await act(async () => chats!.querySelector('summary')!.click());
    expect(chats?.open).toBe(false);
  });
});

test('verification keeps mixed verdicts and literal evidence in shared disclosures', async () => {
  await withDOM(async render => {
    await render(<VerificationMessage kind="verification_result" text={JSON.stringify(result)} />);
    expect(document.body.textContent).toContain('Passed 1 · Failed 1 · Inconclusive 1');
    expect([...document.querySelectorAll('[data-verdict]')].map(node => node.getAttribute('data-verdict'))).toEqual(['pass', 'fail', 'inconclusive']);
    expect(document.querySelector('[data-verdict]')?.parentElement?.querySelector('strong')).toBeNull();
    const evidence = document.querySelector('details')!;
    expect(evidence.open).toBe(false);
    await act(async () => evidence.querySelector('summary')!.click());
    expect(evidence.open).toBe(true);
    const command = evidence.querySelector('details')!;
    await act(async () => command.querySelector('summary')!.click());
    expect(command.querySelector('[aria-label="Command output"] code')?.textContent).toBe(result.evidence[0]!.output);
    expect(document.querySelector('script')).toBeNull();
    expect(command.textContent).toContain('Exit code: 1');
    expect(document.querySelector('[aria-label="Recorded file hash"] code')?.textContent).toBe('a'.repeat(64));
    await render(<VerificationMessage kind="verification_result" text={JSON.stringify({ ...result, evidence: [] })} />);
    expect(document.body.textContent).toContain('Evidence receipts · 0');
    expect(document.body.textContent).toContain('No evidence recorded.');
    await render(<VerificationMessage kind="verification_result" text="{bad json" />);
    expect(document.body.textContent).toBe('Verification details are unavailable.');
  });
});

test('Chats quotes verification summaries instead of serialized goals and evidence', async () => {
  const request = JSON.stringify({ goal: 'PRIVATE_GOAL_CONTEXT', criteria: ['Works'], artifacts: [{ path: 'main.ts', sha256: 'a'.repeat(64) }] });
  await withDOM(async render => {
    const data: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/project', name: 'Review', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [], createdAt: activity.createdAt }], messages: [
      { id: 'request', roomId: 'room', threadId: null, sender: 'dev', recipient: 'reviewer', kind: 'verification_request', text: request, createdAt: activity.createdAt },
      { id: 'result', roomId: 'room', threadId: null, sender: 'reviewer', recipient: 'dev', kind: 'verification_result', questionId: 'request', text: JSON.stringify(result), createdAt: activity.createdAt },
    ] };
    await render(<ChatsView active api={{ request: async () => data }} />);
    const quote = document.querySelector('blockquote')!;
    expect(quote.textContent).toContain('Verification requested · 1 criteria · Works');
    expect(quote.textContent).not.toContain('PRIVATE_GOAL_CONTEXT');
    expect(quote.textContent).not.toContain('{');
  });
  expect(verificationQuote('verification_result', JSON.stringify(result))).toBe('Verification result · Passed 1 · Failed 1 · Inconclusive 1');
  expect(verificationQuote('verification_request', '{bad')).toBe('Verification details are unavailable.');
});


const fileActivity: TaskActivity = { ...activity, kind: 'file', status: 'completed', title: 'File changes',
  text: '', changes: [
    { path: '/workspace/a.ts', kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-old\n+new' },
    { path: '/workspace/b.ts', kind: 'add', movePath: null, diff: '+second' },
  ] };

function ReviewHarness({ api }: { api: NonNullable<Parameters<typeof ChatsView>[0]['api']> }) {
  const [review, setReview] = useState<{ item: ChatActivityItem; path: string | null } | null>(null);
  const open = useCallback((item: ChatActivityItem | null, path?: string) => {
    setReview(current => item ? { item, path: path ?? current?.path ?? null } : null);
  }, []);
  return <><ChatsView active api={api} reviewedMessageId={review?.item.id} onReviewFileChanges={open} />
    <ReviewSidebar open={!!review} item={review?.item ?? null} initialPath={review?.path ?? null} onCloseReview={() => setReview(null)} /></>;
}

test('Chats opens the shared review for the selected file, updates it, closes and reopens', async () => {
  await withDOM(async render => {
    let data: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/project', name: 'Files', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [], createdAt: activity.createdAt }], messages: [
      { id: 'files', roomId: 'room', threadId: null, sender: 'dev', recipient: null, kind: 'message',
        text: '', createdAt: activity.createdAt, activity: fileActivity },
    ] };
    let refresh = () => {};
    const api: AgentChatsApi = { request: async () => data, onDidChange: listener => {
      refresh = () => listener({ cursor: { epoch: 'test', sequence: 1 }, rooms: [], messages: [], removedRoomIds: [], removedMessageIds: [] });
      return () => {};
    } };
    await render(<ReviewHarness api={api} />);
    const article = document.querySelector('[data-message-id="files"]')!;
    expect(article.textContent).toContain('Edited 2 files');
    expect(article.querySelector('[aria-label="2 additions, 1 deletions"]')).not.toBeNull();
    const fileButtons = article.querySelectorAll('button');
    const second = [...fileButtons].find(button => button.textContent?.includes('b.ts'))!;
    await act(async () => second.click());
    const panel = () => document.querySelector('[aria-label="Review sidebar"]')!;
    expect(panel().getAttribute('data-open')).toBe('true');
    expect(panel().querySelector('[aria-label="Diff for b.ts"]')?.textContent).toContain('+second');
    const updated = { ...fileActivity, status: 'failed' as const, truncated: true,
      changes: [fileActivity.changes![0]!, { ...fileActivity.changes![1]!, diff: '+updated' }] };
    data = { ...data, messages: [{ ...data.messages[0]!, activity: updated }] };
    await act(async () => refresh());
    expect(panel().textContent).toContain('Failed to edit 2 files');
    expect(panel().textContent).toContain('Partial record');
    expect(panel().querySelector('[aria-label="Diff for b.ts"]')?.textContent).toContain('+updated');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close file changes review"]')!.click());
    expect(panel().getAttribute('data-open')).toBe('false');
    await act(async () => [...article.querySelectorAll('button')].find(button => button.textContent?.includes('a.ts'))!.click());
    expect(panel().querySelector('[aria-label="Diff for a.ts"] [data-kind="remove"]')?.textContent).toContain('−old');
    expect(panel().querySelector('[aria-label="Diff for a.ts"] [data-kind="add"]')?.textContent).toContain('+new');
    data = { ...data, messages: [] }; await act(async () => refresh());
    expect(panel().getAttribute('data-open')).toBe('false');
  });
});

test('legacy diffs recover known modifications and keep ambiguous kinds and partial records explicit', () => {
  const legacy = { ...fileActivity, changes: undefined,
    text: '/workspace/a.ts\n@@ -1 +1 @@\n-old\n+new\n\n/workspace/b.ts\n@@ -0,0 +1 @@\n+second' };
  const item = fileChangesItem(legacy)!;
  expect(item.changes?.map(change => change.path)).toEqual(['a.ts', 'b.ts']);
  expect(item.changes?.map(change => change.kind)).toEqual(['update', 'unknown']);
  expect(fileChangesItem({ ...legacy, text: 'ambiguous raw content' })).toBeNull();
  const partial = fileChangesItem({ ...legacy, truncated: true })!;
  expect(partial.changesTruncated).toBe(true);
  expect(partial.changes?.[1]?.diff).not.toContain('+second');
  expect(partial.changes?.[1]?.kind).toBe('unknown');
  expect(fileChangesItem({ ...fileActivity, status: 'unknown' })?.status).toBe('unknown');
});

test('legacy change kinds use complete hunks and explicit file headers without guessing empty-file edits', () => {
  const recover = (diff: string) => fileChangesItem({ ...fileActivity, changes: undefined,
    text: `/workspace/a.ts\n${diff}` })?.changes?.[0]?.kind;
  expect(recover('@@ -1 +1,3 @@\n-old\n+one\n+two\n+three')).toBe('update');
  expect(recover('--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+new')).toBe('add');
  expect(recover('--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old')).toBe('delete');
  expect(recover('--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+new')).toBe('update');
  expect(recover('@@ -0,0 +1 @@\n+new')).toBe('unknown');
  expect(recover('@@ -1 +0,0 @@\n-old')).toBe('unknown');
  expect(recover('@@ -1 +1,3 @@\n-old\n+unfinished')).toBe('unknown');
  expect(recover('@@ -1 +1 @@\n-old\n+new\n+extra')).toBe('unknown');
  expect(recover('@@ -1 +1 @@\n unchanged')).toBe('unknown');
  expect(recover('--- /dev/null\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new')).toBe('unknown');
  expect(recover('const plainContent = true;')).toBe('unknown');
  expect(recover('@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-before\n+after')).toBe('update');
  expect(fileChangesItem(fileActivity)?.changes?.map(change => change.kind)).toEqual(['update', 'add']);
});

test('mixed legacy unified diffs and raw new-file contents all open in the shared review', async () => {
  const mixed: TaskActivity = { ...fileActivity, changes: undefined, text:
    '/workspace/ChatsView.module.css\n@@ -1 +1 @@\n-old\n+new\n\n\n'
    + '/workspace/ChatsView.tsx\n@@ -1 +1 @@\n-before\n+after\n\n\n'
    + '/workspace/useChatsScroll.ts\nimport { useState } from "react";\n\nexport function count() {\n  let count = 0;\n++count;\n  return count;\n}\n' };
  const files = fileChangesItem(mixed)!;
  expect(files.changes).toHaveLength(3);
  expect(files.changes?.[2]?.diffFormat).toBe('plain');
  await withDOM(async render => {
    const data: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/project', name: 'Files', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [], createdAt: activity.createdAt }], messages: [
      { id: 'mixed', roomId: 'room', threadId: null, sender: 'dev', recipient: null, kind: 'message',
        text: '', createdAt: activity.createdAt, activity: mixed },
    ] };
    const api: AgentChatsApi = { request: async () => data };
    await render(<ReviewHarness api={api} />);
    const article = document.querySelector('[data-message-id="mixed"]')!;
    expect(article.textContent).toContain('Edited 3 files');
    expect([...article.querySelectorAll('[data-kind]')].map(node => node.textContent)).toEqual(['M', 'M', '?']);
    expect(article.querySelector('details')).toBeNull();
    expect(article.querySelector('[aria-label="2 additions, 2 deletions"]')).toBeNull();
    const clickFile = async (path: string) => {
      await act(async () => [...article.querySelectorAll('button')].find(button => button.textContent?.includes(path))!.click());
      expect(document.querySelector('[aria-label="Review sidebar"]')?.getAttribute('data-open')).toBe('true');
      return document.querySelector(`[aria-label="Diff for ${path}"]`)!;
    };
    expect((await clickFile('ChatsView.module.css')).querySelector('[data-kind="add"]')?.textContent).toContain('+new');
    expect((await clickFile('ChatsView.tsx')).querySelector('[data-kind="remove"]')?.textContent).toContain('−before');
    await clickFile('useChatsScroll.ts');
    const raw = document.querySelector('[aria-label="Recorded content for useChatsScroll.ts"]')!;
    expect(raw.textContent).toContain('import { useState }');
    expect(raw.textContent).toContain('++count;');
    expect(raw.querySelector('[data-kind="add"]')).toBeNull();
    expect(document.body.textContent).toContain('FILE CONTENTS');
    expect(raw.querySelector('[data-kind]')).toBeNull();
    expect(document.body.textContent).not.toContain('Counts unavailable');
    expect(article.querySelector('button[aria-description*="change type and line counts"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Change types were not recorded.');
    expect(document.body.textContent).not.toContain('Counts exclude files');
  });
});


test('plain-only historical file records never display zero changes or empty diff gutters', async () => {
  await withDOM(async render => {
    const item = fileChangesItem({ ...fileActivity, changes: undefined,
      text: '/workspace/new.ts\nconst created = true;\n' })!;
    await render(<><ExecutionRecord activity={{ ...fileActivity, changes: undefined,
      text: '/workspace/new.ts\nconst created = true;\n' }} onReview={() => {}} />
      <ReviewSidebar open item={item} initialPath="new.ts" onCloseReview={() => {}} /></>);
    expect(document.body.textContent).toContain('File contents · 1 file');
    expect(document.body.textContent).not.toContain('Edited 1 file');
    expect(document.body.textContent).not.toContain('+0');
    expect(document.body.textContent).not.toContain('−0');
    expect(document.querySelector('[aria-label="Diff for new.ts"]')).toBeNull();
    expect(document.querySelector('[aria-label="Recorded content for new.ts"] code')?.textContent).toBe('const created = true;\n');
    expect(document.querySelector('[aria-label="Recorded content for new.ts"]')?.querySelector('span')).toBeNull();
    expect(document.querySelector('button[aria-description*="change type and line counts"]')).not.toBeNull();
  });
});


function VerificationHarness({ api, onOpenFile }: { api: AgentChatsApi; onOpenFile?: (path: string) => void }) {
  const [review, setReview] = useState<VerificationReview | null>(null);
  const open = useCallback((value: VerificationReview | null, activate = false) => {
    setReview(current => activate || !value || current?.id === value.id ? value : current);
  }, []);
  return <><ChatsView active api={api} reviewedVerificationId={review?.id} onReviewVerification={open} />
    <ReviewSidebar open={!!review} item={null} initialPath={null} verification={review} onCloseReview={() => setReview(null)}
      onOpenFile={path => { onOpenFile?.(path); setReview(null); }} /></>;
}
const verificationRequest = (): RoomMessage => ({ id: 'verify-request', roomId: 'room', threadId: null, sender: 'dev', recipient: 'reviewer',
  kind: 'verification_request', questionId: 'verify-request', createdAt: activity.createdAt,
  text: JSON.stringify({ goal: 'Private internal context', criteria: ['Keep the reading position', 'Show new arrivals'],
    artifacts: [{ path: 'src/components/Chat.tsx', sha256: 'a'.repeat(64) }, { path: 'src/hooks/scroll.ts', sha256: 'b'.repeat(64) }] }) });
const verificationResult = (): RoomMessage => ({ ...verificationRequest(), id: 'verify-result', kind: 'verification_result',
  sender: 'reviewer', recipient: 'dev', text: JSON.stringify(result) });

test('verification cards open shared slide review, hide hashes, update replies and preserve the draft', async () => {
  await withDOM(async render => {
    let data: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/project', name: 'Verification', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [], createdAt: activity.createdAt }], messages: [verificationRequest()] };
    let refresh = () => {};
    const api: AgentChatsApi = { request: async () => data, onDidChange: listener => {
      refresh = () => listener({ cursor: { epoch: 'refresh', sequence: 1 }, rooms: [], messages: [], removedRoomIds: [], removedMessageIds: [] });
      return () => {};
    } };
    const openedFiles: string[] = [];
    await render(<VerificationHarness api={api} onOpenFile={path => openedFiles.push(path)} />);
    const article = document.querySelector('[data-message-id="verify-request"]')!;
    expect(article.textContent).toContain('2 criteria · 2 files');
    expect(article.textContent).toContain('Awaiting reply');
    expect(article.textContent).not.toContain('Keep the reading position');
    expect(article.textContent).not.toContain('Private internal context');
    expect(article.textContent).not.toContain('a'.repeat(64));
    expect(article.textContent).not.toContain('Please verify that the implementation meets the criteria.');
    const draft = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'Keep my draft');
      draft.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const openCard = async () => { await act(async () => [...article.querySelectorAll('button')].find(button => button.textContent?.includes('Verification request'))!.click()); };
    await openCard();
    const panel = () => document.querySelector('[aria-label="Verification review"]')!;
    const sectionOrder = () => [...panel().querySelector('[aria-label="Verification criteria"], [aria-label="Verification result"]')!.parentElement!.children]
      .map(section => section.getAttribute('aria-label'));
    const requestOrder = ['Verification criteria', 'Verification files'];
    expect(sectionOrder()).toEqual(requestOrder);
    expect(panel().querySelector('[aria-label="Verification criteria"]')?.textContent).toContain('Keep the reading position');
    const file = panel().querySelector('[aria-label="Verification files"] li')!;
    expect(file.querySelector('button')?.textContent).toBe('Chat.tsx');
    expect(file.textContent).toContain('src/components');
    expect(file.querySelector('details')).toBeNull();
    expect(file.textContent).not.toContain('a'.repeat(64));
    await act(async () => file.querySelector<HTMLButtonElement>('[aria-label="Open src/components/Chat.tsx"]')!.click());
    expect(openedFiles).toEqual(['src/components/Chat.tsx']);
    expect(document.querySelector('[aria-label="Review sidebar"]')?.getAttribute('data-open')).toBe('false');
    expect(draft.value).toBe('Keep my draft');
    await openCard();
    await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Open src/hooks/scroll.ts"]')!.click());
    expect(openedFiles).toEqual(['src/components/Chat.tsx', 'src/hooks/scroll.ts']);
    await openCard();
    expect(panel().querySelector('[aria-label="Verification result"]')).toBeNull();
    data = { ...data, messages: [verificationRequest(), verificationResult()] }; await act(async () => refresh());
    expect(article.textContent).toContain('Reply received');
    expect(panel().querySelector('[aria-label="Verification result"]')).toBeNull();
    expect(sectionOrder()).toEqual(requestOrder);
    const replyArticle = document.querySelector('[data-message-id="verify-result"]')!;
    expect(replyArticle.textContent).not.toContain('A verification reply has arrived.');
    await act(async () => [...replyArticle.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Verification result'))!.click());
    expect(sectionOrder()).toEqual(['Verification result']);
    expect(panel().querySelector('[aria-label="Verification result"]')?.textContent).toContain('Passed 1 · Failed 1 · Inconclusive 1');
    expect(panel().querySelector('[data-verdict="fail"]')).not.toBeNull();
    expect(panel().textContent).toContain('Missing dependency');
    expect(panel().textContent).not.toContain('Evidence receipts');
    expect(panel().querySelector('[aria-label="Command output"]')).toBeNull();
    expect(panel().querySelector('[aria-label="Recorded file hash"]')).toBeNull();
    expect(panel().querySelector('[aria-label="Verification criteria"]')).toBeNull();
    expect(panel().querySelector('[aria-label="Verification files"]')).toBeNull();
    expect(panel().querySelectorAll('[aria-label="Verification result"]')).toHaveLength(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close verification review"]')!.click());
    expect(document.querySelector('[aria-label="Review sidebar"]')?.getAttribute('data-open')).toBe('false');
    expect(draft.value).toBe('Keep my draft');
    await openCard();
    expect(sectionOrder()).toEqual(requestOrder);
    expect(panel().textContent).not.toContain('File details');
    data = { ...data, messages: [] }; await act(async () => refresh());
    expect(document.querySelector('[aria-label="Review sidebar"]')?.getAttribute('data-open')).toBe('false');
  });
});

test('Chats highlights only the explicit leading mention of the recorded recipient', async () => {
  await withDOM(async render => {
    const agentName = 'Cheshi Development Specialist';
    const texts = [
      `@${agentName} **Implement this.**\n\n@${agentName} is mentioned again.\n\nUse \`@${agentName}\` and dev@example.com.\n\n\`\`\`text\n@${agentName}\n\`\`\``,
      `@${agentName}: Please review.`,
      `@${agentName}Extra Please review.`,
      `Discussion about @${agentName}.`,
      `\`@${agentName}\``,
      `\`\`\`text\n@${agentName}\n\`\`\``,
      'dev@example.com',
      `@${agentName} Please review.`,
      `@${agentName} Please review.`,
    ];
    const data: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/project', name: 'Mentions', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [{ id: 'dev', accountId: 'account', name: agentName },
        { id: 'short', accountId: 'account', name: 'Cheshi' }], createdAt: activity.createdAt }],
      messages: texts.map((text, index): RoomMessage => ({ id: `mention-${index}`, roomId: 'room', threadId: null,
        sender: 'user', recipient: index === 7 ? 'short' : index === 8 ? null : 'dev',
        kind: 'message', text, createdAt: activity.createdAt })) };
    await render(<ChatsView active api={{ request: async () => data }} />);
    const first = document.querySelector('[data-message-id="mention-0"]')!;
    expect(first.querySelectorAll('[data-mention-id]')).toHaveLength(1);
    expect(first.querySelector('[data-mention-id="dev"]')?.textContent).toBe(`@${agentName}`);
    expect(first.querySelector('p strong')?.textContent).toBe('Implement this.');
    expect(first.querySelector('code')?.textContent).toBe(`@${agentName}`);
    expect(first.querySelector('pre')?.textContent).toContain(`@${agentName}`);
    expect(first.querySelector('code [data-mention-id]')).toBeNull();
    expect(first.textContent).toContain('dev@example.com');
    expect(document.querySelector('[data-message-id="mention-1"] [data-mention-id="dev"]')).not.toBeNull();
    for (let index = 2; index < texts.length; index++) {
      expect(document.querySelector(`[data-message-id="mention-${index}"] [data-mention-id]`)).toBeNull();
    }
  });
});

test('verification joins require exact request, room and peer identities and exclude late results', () => {
  const request = verificationRequest(), reply = verificationResult();
  for (const unrelated of [{ ...reply, questionId: 'another' }, { ...reply, roomId: 'another' },
    { ...reply, sender: 'other-agent' }, { ...reply, status: 'late reply · not applied' }]) {
    expect(verificationReview(request, [request, unrelated])?.result).toBeUndefined();
  }
  expect(verificationReview(request, [request, reply])?.result?.id).toBe(reply.id);
  expect(verificationReview(reply, [request, reply])?.request?.id).toBe(request.id);
  expect(verificationReview(reply, [reply])?.request).toBeUndefined();
});
