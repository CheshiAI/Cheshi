import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileChangesActivity, FileChangesReviewPanel } from '../frontend/src/features/chat/FileChangesActivity';
import type { ChatActivityItem, ChatFileChange } from '../frontend/src/features/chat/model';

async function withChanges(changes: ChatFileChange[], check: (document: Window['document']) => void) {
  const item: ChatActivityItem = { id: 'files', kind: 'activity', activity: 'files', label: 'Files',
    detail: '', status: 'completed', changes };
  const window = new Window();
  try {
    window.document.body.innerHTML = renderToStaticMarkup(<>
      <FileChangesActivity item={item} onReview={() => {}} />
      <FileChangesReviewPanel item={item} initialPath={changes[0]?.path ?? null} onClose={() => {}} />
    </>);
    check(window.document);
  } finally {
    await window.happyDOM.close();
  }
}

const rawLines = [
  'export function example() {', '  return true;', '\t// tab indentation', '', '   ', '}',
  '+literal plus', '-literal minus', '--- literal', '+++ literal', 'diff --git literal',
  'index literal', '\\ No newline at end of file', '@@ literal source',
];

test.each(['add', 'delete'] as const)('whole-file %s preserves every line, marker and gutter', async kind => {
  const addition = kind === 'add';
  const stats = addition ? `${rawLines.length} additions, 0 deletions` : `0 additions, ${rawLines.length} deletions`;
  await withChanges([{ path: 'sample.ts', kind, diff: `${rawLines.join('\r\n')}\r\n`, movePath: null }], document => {
    // Card total, card file, review total and review file must agree.
    expect(document.querySelectorAll(`[aria-label="${stats}"]`)).toHaveLength(4);
    const rows = [...document.querySelectorAll('[role="region"] [data-kind]')];
    expect(rows).toHaveLength(rawLines.length);
    for (const [index, row] of rows.entries()) {
      expect(row.getAttribute('data-kind')).toBe(addition ? 'add' : 'remove');
      expect(row.querySelector('code')?.textContent).toBe(`${addition ? '+' : '−'}${rawLines[index]}`);
      expect([...row.querySelectorAll('span')].map(cell => cell.textContent)).toEqual(
        addition ? ['', String(index + 1)] : [String(index + 1), ''],
      );
    }
  });
});

test('58-line and 26-line new files include indentation and blank lines in file and total counts', async () => {
  const changes: ChatFileChange[] = [58, 26].map(count => ({ path: `${count}.ts`, kind: 'add', movePath: null,
    diff: `${Array.from({ length: count }, (_, index) => index % 3 === 0 ? '' : `  line ${index}`).join('\n')}\n` }));
  await withChanges(changes, document => {
    for (const count of [58, 26, 84]) {
      expect(document.querySelectorAll(`[aria-label="${count} additions, 0 deletions"]`)).toHaveLength(2);
    }
  });
});

test.each(['add', 'delete'] as const)('unified %s diffs retain headers, markers and line numbers', async kind => {
  const addition = kind === 'add';
  const diff = ['diff --git a/sample.ts b/sample.ts', 'index 0000000..1234567',
    `--- ${addition ? '/dev/null' : 'a/sample.ts'}`, `+++ ${addition ? 'b/sample.ts' : '/dev/null'}`,
    addition ? '@@ -0,0 +1,2 @@' : '@@ -1,2 +0,0 @@',
    `${addition ? '+' : '-'}  code`, addition ? '+' : '-', '\\ No newline at end of file'].join('\n');
  await withChanges([{ path: 'sample.ts', kind, diff, movePath: null }], document => {
    const stats = addition ? '2 additions, 0 deletions' : '0 additions, 2 deletions';
    expect(document.querySelectorAll(`[aria-label="${stats}"]`)).toHaveLength(4);
    const region = document.querySelector('[role="region"]')!;
    expect(region.querySelectorAll('[data-kind="header"]')).toHaveLength(6);
    const rows = [...region.querySelectorAll(`[data-kind="${addition ? 'add' : 'remove'}"]`)];
    expect(rows.map(row => row.querySelector('code')?.textContent)).toEqual(addition ? ['+  code', '+'] : ['−  code', '−']);
    expect(rows.map(row => [...row.querySelectorAll('span')].map(cell => cell.textContent))).toEqual(
      addition ? [['', '1'], ['', '2']] : [['1', ''], ['2', '']],
    );
  });
});

test.each(['add', 'delete'] as const)('empty and final-newline boundaries for whole-file %s', async kind => {
  for (const [diff, count] of [['', 0], ['\n', 1], ['  line', 1], ['  line\n', 1], ['  line\n\n', 2]] as const) {
    await withChanges([{ path: 'sample.ts', kind, diff, movePath: null }], document => {
      const stats = kind === 'add' ? `${count} additions, 0 deletions` : `0 additions, ${count} deletions`;
      expect(document.querySelectorAll(`[aria-label="${stats}"]`)).toHaveLength(4);
      expect(document.querySelectorAll('[role="region"] [data-kind]')).toHaveLength(count);
    });
  }
});

test('explicit plain historical content remains uncounted and retains its literal text', async () => {
  const diff = rawLines.join('\n');
  await withChanges([{ path: 'sample.ts', kind: 'unknown', diff, diffFormat: 'plain', movePath: null }], document => {
    expect(document.querySelector('[aria-label*="additions,"]')).toBeNull();
    expect(document.querySelector('pre')?.textContent).toBe(diff);
    expect(document.querySelector('[aria-label="Diff for sample.ts"]')).toBeNull();
  });
});

test('render truncation keeps complete whole-file counts and sequential visible gutters', async () => {
  await withChanges([{ path: 'long.ts', kind: 'add', diff: '  line\n'.repeat(1_201), movePath: null }], document => {
    expect(document.querySelectorAll('[aria-label="1201 additions, 0 deletions"]')).toHaveLength(4);
    const rows = document.querySelectorAll('[role="region"] [data-kind="add"]');
    expect(rows).toHaveLength(1_200);
    expect(rows[1_199]?.querySelector('span:nth-child(2)')?.textContent).toBe('1200');
    expect(document.body.textContent).toContain('Diff truncated after 1,200 lines.');
  });
});
