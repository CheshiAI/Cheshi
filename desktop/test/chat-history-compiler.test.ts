import { describe, expect, test } from 'bun:test';
import { compileChatHistoryThread, normalizeChatHistoryFilePath } from '../lib/chat-history-compiler.mts';
import { timelineFromThread } from '../lib/codex-chat-thread-data.mts';

const cwd = '/workspace/프로젝트';

function thread(items: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return { id: 'thread-1', cwd, turns: [{ id: 'turn-1', status: 'completed', items }], ...overrides };
}

describe('chat history compiler', () => {
  test('preserves exact source ids, Korean text and relationships deterministically without mutating the source', () => {
    const input = thread([
      { id: 'user-1', type: 'userMessage', content: [
        { type: 'text', text: '세션 검색을 구현합니다. `src/검색.ts`' },
        { type: 'mention', name: 'Browser' },
        { type: 'skill', name: 'example' },
      ] },
      { id: 'plan-1', type: 'plan', text: '1. 경로 추출\n2. 원본 턴 이동' },
      { id: 'assistant-1', type: 'agentMessage', text: '적용했습니다.' },
    ], { parentThreadId: 'parent-1', forkedFromId: 'source-1' });
    const before = JSON.stringify(input);
    const result = compileChatHistoryThread({ thread: input }, cwd);
    expect(result).toEqual({
      threadId: 'thread-1', parentThreadId: 'parent-1', forkedFromId: 'source-1',
      entries: [
        { turnId: 'turn-1', itemId: 'user-1', kind: 'user', text: '세션 검색을 구현합니다. `src/검색.ts`\n@Browser\n$example', files: [{ path: 'src/검색.ts', kind: 'mentioned' }] },
        { turnId: 'turn-1', itemId: 'plan-1', kind: 'plan', text: '1. 경로 추출\n2. 원본 턴 이동', files: [] },
        { turnId: 'turn-1', itemId: 'assistant-1', kind: 'assistant', text: '적용했습니다.', files: [] },
      ],
    });
    expect(compileChatHistoryThread(input, cwd)).toEqual(result);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('uses the existing timeline fallback ids, including turn errors', () => {
    const input = thread([], { turns: [{ items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
      { type: 'agentMessage', text: 'world' },
      { type: 'reasoning', summary: [{ text: 'private' }] },
    ], error: { message: 'Failed to load src/main.ts:3' } }] });
    const result = compileChatHistoryThread(input, cwd);
    const timelineIds = timelineFromThread(input)
      .flatMap((item) => item.kind !== 'reasoning' && typeof item.id === 'string' ? [item.id] : []);
    expect(result.entries.map((entry) => entry.itemId)).toEqual(timelineIds);
    expect(result.entries.map((entry) => entry.turnId)).toEqual(['turn-0', 'turn-0', 'turn-0']);
    expect(result.entries[2]).toMatchObject({
      itemId: 'turn-0:error', text: 'Response failed\nFailed to load src/main.ts:3',
      files: [{ path: 'src/main.ts', kind: 'mentioned' }],
    });
  });

  test('extracts Korean, quoted spaces, Markdown links, inline code and line locations within the workspace', () => {
    const text = [
      '`src/한글 파일.ts:12:3`',
      '[검토](</workspace/프로젝트/docs/설계 노트.md:20>)',
      '[source](/workspace/프로젝트/src/main.ts#L3-L9)',
      '[encoded](/workspace/프로젝트/docs/encoded%20note.md)',
      '[parenthesis](/workspace/프로젝트/src/copy(2).ts)',
      '"src/another file.ts"',
      'src/plain.ts:4:8, .gitignore',
      '[outside](/workspace/other/secret.ts)',
      '`../outside.ts`',
      'https://example.com/src/remote.ts user@example.com',
    ].join('\n');
    expect(compileChatHistoryThread(thread([{ type: 'agentMessage', text }]), cwd).entries[0]?.files).toEqual([
      { path: '.gitignore', kind: 'mentioned' },
      { path: 'docs/encoded note.md', kind: 'mentioned' },
      { path: 'docs/설계 노트.md', kind: 'mentioned' },
      { path: 'src/another file.ts', kind: 'mentioned' },
      { path: 'src/copy(2).ts', kind: 'mentioned' },
      { path: 'src/main.ts', kind: 'mentioned' },
      { path: 'src/plain.ts', kind: 'mentioned' },
      { path: 'src/한글 파일.ts', kind: 'mentioned' },
    ]);
  });

  test('does not treat narrative statements, shell commands or guessed tool arguments as read/change evidence', () => {
    const result = compileChatHistoryThread(thread([
      { type: 'agentMessage', text: 'Read `src/read.ts` and changed `src/write.ts`.' },
      { type: 'commandExecution', command: 'cat src/read.ts && touch src/write.ts',
        status: 'completed', exitCode: 0, aggregatedOutput: 'src/read.ts',
        commandActions: [{ type: 'read', path: 'src/read.ts' }] },
      { type: 'mcpToolCall', tool: 'read_file', server: 'filesystem', status: 'completed',
        arguments: { path: 'src/private.ts' }, result: { content: 'private payload' } },
    ]), cwd);
    expect(result.entries[0]?.files).toEqual([
      { path: 'src/read.ts', kind: 'mentioned' }, { path: 'src/write.ts', kind: 'mentioned' },
    ]);
    expect(result.entries[1]?.files).toEqual(result.entries[0]?.files);
    expect(result.entries[1]?.text).toContain('exit code: 0');
    expect(result.entries[2]?.files).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private payload');
    expect(JSON.stringify(result)).not.toContain('src/private.ts');
  });

  test.each(['`', '"', "'"])('extracts file arguments instead of an entire %s quoted command', quote => {
    const command = 'wc -l desktop/preload.cts desktop/workspace-runtime.mts desktop/lib/codex-chat-service.mts';
    const text = `Run ${quote}${command}${quote} to count the lines.`;
    const entry = compileChatHistoryThread(thread([{ type: 'agentMessage', text }]), cwd).entries[0];
    expect(entry?.text).toBe(text);
    expect(entry?.files).toEqual([
      { path: 'desktop/lib/codex-chat-service.mts', kind: 'mentioned' },
      { path: 'desktop/preload.cts', kind: 'mentioned' },
      { path: 'desktop/workspace-runtime.mts', kind: 'mentioned' },
    ]);
  });

  test('keeps quoted file arguments intact within commands and excludes external paths', () => {
    const text = [
      '`sed -n \'420,550p\' desktop/lib/codex-chat-service.mts`',
      '`rg -n "needle" "src/한글 파일.ts"`',
      '`cat "docs/설계 노트.md"`',
      '`wc -l \'src/another file.ts\' /outside/secret.ts`',
      '`LC_ALL=C /usr/bin/wc -l "src/custom file.customformat"`',
      '`sudo wc -l README.md | tee "docs/count report.txt"`',
    ].join('\n');
    expect(compileChatHistoryThread(thread([{ type: 'agentMessage', text }]), cwd).entries[0]?.files).toEqual([
      { path: 'README.md', kind: 'mentioned' },
      { path: 'desktop/lib/codex-chat-service.mts', kind: 'mentioned' },
      { path: 'docs/count report.txt', kind: 'mentioned' },
      { path: 'docs/설계 노트.md', kind: 'mentioned' },
      { path: 'src/another file.ts', kind: 'mentioned' },
      { path: 'src/custom file.customformat', kind: 'mentioned' },
      { path: 'src/한글 파일.ts', kind: 'mentioned' },
    ]);
  });

  test('preserves spaced paths containing command names or option-like words', () => {
    const text = '`docs/wc -l report.md`, "src/cat notes.ts", `설계 자료.customformat`, [file](<wc -l notes.md>)';
    expect(compileChatHistoryThread(thread([{ type: 'agentMessage', text }]), cwd).entries[0]?.files).toEqual([
      { path: 'docs/wc -l report.md', kind: 'mentioned' },
      { path: 'src/cat notes.ts', kind: 'mentioned' },
      { path: 'wc -l notes.md', kind: 'mentioned' },
      { path: '설계 자료.customformat', kind: 'mentioned' },
    ]);
  });

  test('indexes explicit extensionless paths and known filenames without treating ordinary prose as paths', () => {
    const text = [
      '`Dockerfile`, "Makefile", [launch](scripts/launch), and `bin/worker` need review.',
      'README explains deployment. Update the build and launch commands.',
      '`review` and "deployment" are regular words; bare scripts/guess is ambiguous.',
      '[outside](../outside/launch) and [website](https://example.com/start) are excluded.',
    ].join('\n');
    expect(compileChatHistoryThread(thread([{ type: 'agentMessage', text }]), cwd).entries[0]?.files).toEqual([
      { path: 'Dockerfile', kind: 'mentioned' },
      { path: 'Makefile', kind: 'mentioned' },
      { path: 'README', kind: 'mentioned' },
      { path: 'bin/worker', kind: 'mentioned' },
      { path: 'scripts/launch', kind: 'mentioned' },
    ]);
  });

  test('rejects quoted prose containing slashes while retaining explicit file paths', () => {
    const text = [
      '"Use for Codex models/pricing, scheduled tasks, skills, settings, setup, troubleshooting, customization, automations, and self-knowledge—including \'you,\' \'your,\' \'this app,\' or \'this coding agent\' when they refer to Codex—and for OpenAI APIs/products and ChatGPT Work. Also use for model choice/migration, prompting, SDKs, Responses, Realtime, agents, evals, and Chat/Work/Codex comparisons. Do not use for generic app/software tasks that merely mention Codex."',
      '"Use the model APIs/pricing" and `Review the app/software guide` are instructions.',
      '"docs/설계 노트.md" is a path.',
      '`scripts/launch` and "bin/실행" are explicit extensionless paths.',
    ].join('\n');
    expect(compileChatHistoryThread(thread([{ type: 'agentMessage', text }]), cwd).entries[0]?.files).toEqual([
      { path: 'bin/실행', kind: 'mentioned' },
      { path: 'docs/설계 노트.md', kind: 'mentioned' },
      { path: 'scripts/launch', kind: 'mentioned' },
    ]);
  });

  test('requires recognizable filenames for bare root tokens instead of code expressions, selectors, versions or hosts', () => {
    const text = [
      'Array.isArray process.arch process.env value.id Number.MAX_VALUE .circle 1.5 v1.5.0 developers.openai.com',
      'Review package.json, ChatView.module.css:12, README.md, bun.lock, 설계.md, .gitignore, .env.local and .prettierrc.',
    ].join('\n');
    expect(compileChatHistoryThread(thread([{ type: 'agentMessage', text }]), cwd).entries[0]?.files).toEqual([
      { path: '.env.local', kind: 'mentioned' },
      { path: '.gitignore', kind: 'mentioned' },
      { path: '.prettierrc', kind: 'mentioned' },
      { path: 'ChatView.module.css', kind: 'mentioned' },
      { path: 'README.md', kind: 'mentioned' },
      { path: 'bun.lock', kind: 'mentioned' },
      { path: 'package.json', kind: 'mentioned' },
      { path: '설계.md', kind: 'mentioned' },
    ]);
  });

  test('keeps unknown extensions when a quote, Markdown target or directory establishes path intent', () => {
    const text = [
      'root.customformat is ambiguous; `quoted.customformat` and "설계 자료.customformat" are explicit.',
      '[source](linked.customformat), data/schema.customformat and `scripts/launch` are paths.',
    ].join('\n');
    expect(compileChatHistoryThread(thread([{ type: 'agentMessage', text }]), cwd).entries[0]?.files).toEqual([
      { path: 'data/schema.customformat', kind: 'mentioned' },
      { path: 'linked.customformat', kind: 'mentioned' },
      { path: 'quoted.customformat', kind: 'mentioned' },
      { path: 'scripts/launch', kind: 'mentioned' },
      { path: '설계 자료.customformat', kind: 'mentioned' },
    ]);
  });

  test('marks only successfully completed structured file changes and moved paths as changed', () => {
    const result = compileChatHistoryThread(thread([
      { type: 'fileChange', id: 'changed', status: 'completed', changes: [
        { path: `${cwd}/src/old.ts`, kind: { type: 'update', move_path: `${cwd}/src/new.ts` }, diff: '@@\n-old\n+new' },
        { path: 'src/deleted.ts', kind: { type: 'delete' } },
        { path: '/workspace/other/ignored.ts', kind: { type: 'add' } },
      ] },
      { type: 'fileChange', id: 'failed', status: 'failed', changes: {
        'src/failed.ts': { type: 'update', unified_diff: '@@\n-before\n+after' },
      } },
      { type: 'fileChange', id: 'unknown', changes: [{ path: 'src/unknown.ts', kind: 'add' }] },
    ]), cwd);
    expect(result.entries[0]?.files).toEqual([
      { path: 'src/deleted.ts', kind: 'changed' },
      { path: 'src/new.ts', kind: 'changed' },
      { path: 'src/old.ts', kind: 'changed' },
    ]);
    expect(result.entries[1]?.files).toEqual([{ path: 'src/failed.ts', kind: 'mentioned' }]);
    expect(result.entries[2]?.files).toEqual([{ path: 'src/unknown.ts', kind: 'mentioned' }]);
    expect(result.entries[0]?.text).toContain('@@\n-old\n+new');
    expect(result.entries[1]?.text).toContain('status: failed');
  });

  test('retains recorded error/output and interruption status without claiming a successful result', () => {
    const result = compileChatHistoryThread(thread([], { turns: [{ id: 'turn-1', status: 'interrupted', items: [
      { type: 'commandExecution', command: 'bun test src/test.ts', status: 'inProgress', aggregatedOutput: 'Error: timeout', exitCode: null },
      { type: 'commandExecution', command: 'bun test src/test.ts', status: 'completed', aggregatedOutput: '', exitCode: '0' },
    ] }] }), cwd);
    expect(result.entries[0]?.text).toContain('status: interrupted');
    expect(result.entries[0]?.text).toContain('Error: timeout');
    expect(result.entries[1]?.text).not.toContain('exit code:');
  });

  test.each(['completed', 'failed'])('preserves exact spaced change paths and diff mentions for %s changes', status => {
    const result = compileChatHistoryThread(thread([
      { type: 'fileChange', status, cwd: `${cwd}/src`, changes: [
        { path: '한글 원본.ts', kind: { type: 'update', move_path: '한글 대상.ts' },
          diff: '@@\n-import "한글 원본.ts"\n+import "한글 대상.ts"\n+// See "../docs/참고 문서.md"' },
        { path: '/workspace/outside/비밀 파일.ts', kind: 'add' },
      ] },
    ]), cwd);
    const kind = status === 'completed' ? 'changed' : 'mentioned';
    expect(result.entries[0]?.files).toEqual([
      { path: 'docs/참고 문서.md', kind: 'mentioned' },
      { path: 'src/한글 대상.ts', kind },
      { path: 'src/한글 원본.ts', kind },
    ]);
    expect(result.entries[0]?.text).toContain('update: 한글 원본.ts\nmove: 한글 대상.ts');
  });

  test('excludes reasoning, compaction, system context, authentication records and attachment payloads', () => {
    const result = compileChatHistoryThread(thread([
      { type: 'reasoning', text: 'reasoning-only', summary: ['reasoning-summary'] },
      { type: 'contextCompaction', text: 'compacted-private-context' },
      { type: 'systemMessage', content: 'system-private-context' },
      { type: 'authentication', credentials: 'private-auth-value' },
      { type: 'userMessage', content: [
        { type: 'localImage', path: '/outside/private.png' },
        { type: 'audio', data: 'private-audio-data' },
        { type: 'text', text: 'visible user message' },
      ] },
      { type: 'agentMessage', text: 'visible reply', auth: 'private-auth-value' },
    ], { auth: 'private-auth-value', systemContext: 'system-private-context' }), cwd);
    expect(result.entries.map((entry) => entry.text)).toEqual(['visible user message', 'visible reply']);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('reasoning');
  });

  test('resolves relative structured paths against the recorded working directory', () => {
    const result = compileChatHistoryThread(thread([
      { type: 'fileChange', status: 'completed', cwd: `${cwd}/nested`, changes: [
        { path: 'local.ts', kind: 'add' }, { path: '../root.ts', kind: 'update' },
      ] },
    ]), cwd);
    expect(result.entries[0]?.files).toEqual([
      { path: 'nested/local.ts', kind: 'changed' }, { path: 'root.ts', kind: 'changed' },
    ]);
  });

  test('rejects malformed boundaries and duplicate source identifiers instead of returning an empty success', () => {
    const invalid: unknown[] = [
      null, [], {}, { id: 'id' }, { id: 3, turns: [] }, { id: 'id', turns: {} },
      { thread: null }, thread([], { turns: [null] }), thread([], { turns: [{}] }),
      thread([], { cwd: true }), thread([], { cwd: 'relative' }),
      thread([{ type: 'agentMessage', text: 'bad directory', cwd: true }]),
      thread([{}]), thread([{ type: 'userMessage', content: 'text' }]),
      thread([{ type: 'userMessage', content: [null] }]),
      thread([{ type: 'agentMessage', text: false }]),
      thread([{ type: 'commandExecution', command: {} }]),
      thread([{ type: 'fileChange', changes: false }]),
      thread([{ type: 'fileChange', changes: [{ path: 'src/a.ts', kind: 'guess' }] }]),
      thread([{ type: 'agentMessage', id: 3, text: 'bad id' }]),
      thread([{ type: 'agentMessage', id: 'same', text: 'first' }, { type: 'agentMessage', id: 'same', text: 'second' }]),
    ];
    for (const value of invalid) expect(() => compileChatHistoryThread(value, cwd)).toThrow();
    expect(() => compileChatHistoryThread(thread([]), 'relative')).toThrow('absolute path');
    expect(compileChatHistoryThread(thread([]), cwd).entries).toEqual([]);
    expect(compileChatHistoryThread(thread([{ type: 'future-provider-event', payload: 'unknown' }]), cwd).entries).toEqual([]);
  });
});

describe('chat history file normalization', () => {
  test('normalizes deleted paths lexically, without reading the filesystem', () => {
    expect(normalizeChatHistoryFilePath('src/../deleted.ts:12:4', cwd)).toBe('deleted.ts');
    expect(normalizeChatHistoryFilePath(`"${cwd}/한글 파일.ts#L3-L8"`, cwd)).toBe('한글 파일.ts');
    expect(normalizeChatHistoryFilePath('Makefile', cwd)).toBe('Makefile');
    expect(normalizeChatHistoryFilePath('./a.ts', cwd, `${cwd}/subdir`)).toBe('subdir/a.ts');
  });

  test('rejects traversal, other workspaces, URLs, home expansion and control characters', () => {
    for (const value of [
      '../outside.ts', `${cwd}-other/file.ts`, '/private/auth.json', '~/secret.ts',
      'https://example.com/file.ts', 'file:///private/file.ts', 'C:\\other\\file.ts',
      'src/file.ts\0suffix', '', '.', 1, true, null,
    ]) expect(normalizeChatHistoryFilePath(value, cwd)).toBeNull();
    expect(normalizeChatHistoryFilePath('file.ts', cwd, 'relative')).toBeNull();
  });
});
