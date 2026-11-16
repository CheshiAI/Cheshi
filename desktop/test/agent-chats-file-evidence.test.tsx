import { expect, test } from 'bun:test';
import { act, useCallback, useMemo, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../frontend/src/features/chat/MessageContent';
import { fileEvidence } from '../frontend/src/features/chat/fileEvidenceModel';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatsSnapshot, RoomMessage } from '../shared/agent-chats';
import { specialistAgent } from './agent-registry-fixtures';
import { ReviewSidebar } from '../frontend/src/features/shell/ReviewSidebar';
import { verificationReview, verificationReportContext, type VerificationReview } from '../frontend/src/features/agent-chats/verificationReviewModel';
import { withDOM } from './agent-chats-test-dom';

const hash = 'a'.repeat(64);
const block = `ChatsView.tsx\n${hash}\npackage.json\n${'b'.repeat(64)}`;
const text = `Review complete.\n\n\`\`\`text\n${block}\n\`\`\``;
const context = 'Files:\ndesktop/frontend/ChatsView.tsx (untracked 신규)\n`package.json`';

test('file evidence resolves only unique paths explicitly present in the request', () => {
  expect(fileEvidence(block, 'text', context)).toEqual([
    { file: 'ChatsView.tsx', sha256: hash, path: 'desktop/frontend/ChatsView.tsx' },
    { file: 'package.json', sha256: 'b'.repeat(64), path: 'package.json' },
  ]);
  expect(fileEvidence(`ChatsView.tsx\n${hash}`, undefined, 'a/ChatsView.tsx b/ChatsView.tsx'))
    .toEqual([{ file: 'ChatsView.tsx', sha256: hash }]);
  expect(fileEvidence(`ChatsView.tsx\n${hash}`, 'plaintext', ''))
    .toEqual([{ file: 'ChatsView.tsx', sha256: hash }]);
  expect(fileEvidence(`a/ChatsView.tsx\n${hash}`, 'text', 'b/ChatsView.tsx'))
    .toEqual([{ file: 'a/ChatsView.tsx', sha256: hash }]);
});

test('partial hashes, mixed code and unsafe paths remain ordinary code', () => {
  for (const value of ['', `ChatsView.tsx\n${hash.slice(1)}`, `${block}\nadditional text`,
    `${block}\nmissing.ts`, `../file.ts\n${hash}`, `file:///tmp/a.ts\n${hash}`, `//host/a.ts\n${hash}`,
    `a/../file.ts\n${hash}`, `javascript:alert.ts\n${hash}`]) {
    expect(fileEvidence(value, 'text', context)).toBeNull();
  }
  expect(fileEvidence(block, 'ts', context)).toBeNull();
  expect(fileEvidence(`ChatsView.tsx\n${hash}`, 'text', '/workspace/ChatsView.tsx ../ChatsView.tsx'))
    .toEqual([{ file: 'ChatsView.tsx', sha256: hash }]);
});

test('review rendering shows a flat file list with links and omits hash details', async () => {
  await withDOM(async ui => {
    await ui.render(<MessageContent text={text} reviewFileContext={context} />);
    expect(document.querySelector('pre')).toBeNull();
    expect(document.querySelector('[aria-label="Evidence files"]')?.children.length).toBe(2);
    expect([...document.querySelectorAll('a')].map(a => a.getAttribute('href')))
      .toEqual(['desktop/frontend/ChatsView.tsx', 'package.json']);
    expect(document.querySelector('h3')?.textContent).toBe('Files · 2');
    expect(document.querySelector('details')).toBeNull();
    expect(document.body.textContent).not.toContain(hash);
    expect(document.body.textContent).not.toContain('SHA-256');
    expect(document.body.textContent).toContain('root');
    expect(document.body.textContent).toContain('Review complete.');
  });
});

test('normal messages and description mode preserve literal code; unresolved files have no guessed links', () => {
  expect(renderToStaticMarkup(<MessageContent text={text} />)).toContain('<pre');
  expect(renderToStaticMarkup(<MessageContent text={text} presentation="description" reviewFileContext={context} />))
    .toContain('<pre');
  const unresolved = renderToStaticMarkup(<MessageContent text={text} reviewFileContext="" />);
  expect(unresolved).toContain('Files · 2');
  expect(unresolved).not.toContain('<a ');
  expect(unresolved).not.toContain('Passed');
});

function snapshot(requestPatch: Partial<RoomMessage> = {}): ChatsSnapshot {
  const createdAt = '2026-10-06T00:00:00Z';
  const message = (id: string, sender: string, value: string): RoomMessage => ({
    id, roomId: 'room', threadId: null, sender, recipient: null, kind: 'message', text: value, createdAt, taskId: 'task',
  });
  return {
    rooms: [{ id: 'room', name: 'Review', workspace: '/project', engineId: 'docker:test', defaultAgentId: 'reviewer',
      members: [{ id: 'reviewer', name: 'Review Specialist', accountId: 'account' }], createdAt }],
    messages: [
      { ...message('request', 'user', context), recipient: 'reviewer', ...requestPatch },
      message('review', 'reviewer', text), message('user-code', 'user', text), message('dev-code', 'dev', text),
    ],
  };
}

const registry = {
  list: async () => ({ workspaceRoot: '/project', agents: [{ ...specialistAgent(), id: 'reviewer', role: 'verification' as const,
    accountId: 'account', assignments: [{ workspaceRoot: '/project', instructions: '' }] }] }),
  onDidChange: () => () => {},
};

test('Chats enables evidence only for review replies and Copy retains the complete original', async () => {
  await withDOM(async ui => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { writes.push(value); } } });
    await ui.render(<ReportHarness data={snapshot()} />);
    const article = document.querySelector('[data-message-id="review"]')!;
    expect(article.textContent).toContain('Verification report');
    expect(article.textContent).not.toContain('Review complete.');
    expect(article.querySelector('[aria-label="Evidence files"]')).toBeNull();
    await ui.type('Message', 'Keep review draft');
    await openReport();
    const panel = document.querySelector('[aria-label="Verification review"]')!;
    expect(panel.querySelectorAll('[aria-label="Evidence files"] a').length).toBe(2);
    expect(panel.textContent).toContain('Review complete.');
    expect(panel.textContent).not.toContain(hash);
    expect(panel.textContent).not.toContain('SHA-256 details');
    expect(panel.querySelector('details')).toBeNull();
    await ui.click('Close verification review');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep review draft');
    expect(document.querySelector('[data-message-id="user-code"] pre')).not.toBeNull();
    expect(document.querySelector('[data-message-id="dev-code"] pre')).not.toBeNull();
    await act(async () => article.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    expect(writes).toEqual([text]);
  });
});

test.each<Partial<RoomMessage>>([{ taskId: 'other' }, { roomId: 'other' }, { recipient: 'other' }, { taskId: undefined }])(
  'Chats never uses unrelated request paths: %j', async patch => {
    await withDOM(async ui => {
      await ui.render(<ReportHarness data={snapshot(patch)} />);
      await openReport();
      const article = document.querySelector('[aria-label="Verification review"]')!;
      expect(article.querySelector('[aria-label="Evidence files"]')).not.toBeNull();
      expect(article.querySelectorAll('[aria-label="Evidence files"] a').length).toBe(0);
    });
  },
);

function ReportHarness({ data }: { data: ChatsSnapshot }) {
  const api = useMemo(() => ({ request: async () => data }), [data]);
  const [review, setReview] = useState<VerificationReview | null>(null);
  const open = useCallback((value: VerificationReview | null, activate = false) => {
    setReview(current => activate || !value || current?.id === value.id ? value : current);
  }, []);
  return <><ChatsView active api={api} registry={registry}
    reviewedVerificationId={review?.id} onReviewVerification={open} />
    <ReviewSidebar open={!!review} item={null} initialPath={null} verification={review} onCloseReview={() => setReview(null)} /></>;
}

test('report recognition leaves ordinary reviewer messages and other authors inline without inferring verdicts', async () => {
  const data = snapshot(), message = data.messages[1]!;
  const agents = (await registry.list()).agents;
  for (const value of ['I will verify the changes.', '검증을 시작하겠습니다.', 'Passed is one possible outcome.', '```ts\nconst result = "Passed";\n```']) {
    const progress = { ...message, text: value };
    expect(verificationReview(progress, data.messages, verificationReportContext(progress, data.messages, agents))).toBeNull();
  }
  const report = { ...message, text: '| 기준 | 판정 | 근거 |\n| --- | --- | --- |\n| 테스트 | **Passed** | 실행 완료 |' };
  const parsed = verificationReview(report, data.messages, verificationReportContext(report, data.messages, agents));
  expect(parsed?.report?.message.text).toBe(report.text);
  expect(parsed?.result).toBeUndefined();
  expect(parsed?.status).toBe('Report');
  expect(verificationReportContext({ ...report, sender: 'dev' }, data.messages, agents)).toBeUndefined();
  await withDOM(async ui => {
    await ui.render(<ReportHarness data={{ ...data, messages: [...data.messages, { ...message, id: 'progress', text: '검증을 시작하겠습니다.' }] }} />);
    expect(document.querySelector('[data-message-id="progress"]')?.textContent).toContain('검증을 시작하겠습니다.');
    expect(document.querySelector('[data-message-id="progress"]')?.textContent).not.toContain('Verification report');
  });
});

async function openReport() {
  const card = [...document.querySelectorAll<HTMLButtonElement>('[data-message-id="review"] button')]
    .find(button => button.textContent?.includes('Verification report'))!;
  expect(card).toBeDefined();
  await act(async () => card.click());
}
