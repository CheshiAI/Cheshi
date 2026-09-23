import { describe, expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { EditorState } from '@codemirror/state';

import { bracketPairGuideLines } from '../frontend/src/features/editor/bracketPairGuides';

describe('bracket pair guides', () => {
  it('shares CodeMirror modules between the test harness and the editor', () => {
    const testRequire = createRequire(import.meta.url);
    const editorRequire = createRequire(new URL('../frontend/src/features/editor/bracketPairGuides.ts', import.meta.url));
    // Separate copies can accidentally share state-field IDs until another test
    // allocates a field, masking the mismatch when this file runs on its own.
    for (const name of ['state', 'language', 'view', 'lang-javascript']) {
      const packageName = `@codemirror/${name}`;
      expect(realpathSync(editorRequire.resolve(packageName))).toBe(realpathSync(testRequire.resolve(packageName)));
    }
  });

  it('tracks multiline syntax-tree block braces and highlights the innermost scope', () => {
    const doc = [
      'function example() {',
      '  if (ready) {',
      '    return value;',
      '  }',
      '}',
    ].join('\n');
    const cursor = doc.indexOf('value');
    const state = EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [javascript({ typescript: true })],
    });

    expect(bracketPairGuideLines(state)).toEqual([
      { line: 2, guides: [{ column: 0, depth: 0, active: false }] },
      {
        line: 3,
        guides: [
          { column: 0, depth: 0, active: false },
          { column: 2, depth: 1, active: true },
        ],
      },
      { line: 4, guides: [{ column: 0, depth: 0, active: false }] },
    ]);
  });

  it('ignores braces inside strings and comments', () => {
    const state = EditorState.create({
      doc: 'const value = "{ not a scope }";\n// { neither }\n',
      extensions: [javascript()],
    });
    expect(bracketPairGuideLines(state)).toEqual([]);
  });

  it('keeps multiline function guides separate from nested callback guides', () => {
    const doc = [
      'export function installDragCopy(document: Document, write: (text: string) => void,',
      '  read: SelectionReader): () => void {',
      '  const view = document.defaultView;',
      '  const observe = () => {',
      '    read(view);',
      '  };',
      '}',
    ].join('\n');
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('read(view)') },
      extensions: [javascript({ typescript: true })],
    });

    expect(bracketPairGuideLines(state)).toEqual([
      { line: 3, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 4, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 5, guides: [
        { column: 0, depth: 0, active: false },
        { column: 2, depth: 1, active: true },
      ] },
      { line: 6, guides: [{ column: 0, depth: 0, active: false }] },
    ]);
  });

  it.each([
    { name: 'condition', doc: '  if (ready\n    && enabled) {\n    run();\n  }', line: 3, column: 2 },
    { name: 'loop', doc: '  for (const item\n    of items) {\n    run(item);\n  }', line: 3, column: 2 },
    { name: 'arrow function', doc: '  const run = (value: string,\n    index: number) => {\n    work();\n  };', line: 3, column: 2 },
    { name: 'class', doc: 'class Example\n  extends Base {\n  value = 1;\n}', line: 3, column: 0 },
    { name: 'tabs', doc: '\tif (ready\n\t\t&& enabled) {\n\t\trun();\n\t}', line: 3, column: 4 },
  ])('aligns multiline $name guides with the starting line', ({ doc, line, column }) => {
    const state = EditorState.create({
      doc,
      extensions: [javascript({ typescript: true }), EditorState.tabSize.of(4)],
    });
    expect(bracketPairGuideLines(state)).toEqual([
      { line, guides: [{ column, depth: 0, active: false }] },
    ]);
  });

  it('preserves standalone and switch-case block indentation', () => {
    const doc = [
      'function example() {',
      '  {',
      '    run();',
      '  }',
      '  switch (value',
      '    || fallback) {',
      '    case 0: {',
      '      work();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const state = EditorState.create({ doc, extensions: [javascript()] });
    const lines = bracketPairGuideLines(state);
    expect(lines.find(({ line }) => line === 3)?.guides).toEqual([
      { column: 0, depth: 0, active: false },
      { column: 2, depth: 1, active: false },
    ]);
    expect(lines.find(({ line }) => line === 8)?.guides).toEqual([
      { column: 0, depth: 0, active: false },
      { column: 2, depth: 1, active: false },
      { column: 4, depth: 2, active: false },
    ]);
  });

  it('keeps a top-level standalone block at its own indentation', () => {
    const state = EditorState.create({
      doc: 'const ready = true;\n  {\n    run(ready);\n  }',
      extensions: [javascript()],
    });
    expect(bracketPairGuideLines(state)).toEqual([
      { line: 3, guides: [{ column: 2, depth: 0, active: false }] },
    ]);
  });

  it('draws guides through multiline interface members', () => {
    const state = EditorState.create({
      doc: [
        'export interface IssuePage {',
        '  repository: string;',
        '  issues: GitHubIssue[];',
        '  total: number;',
        '  hasMore: boolean;',
        '}',
      ].join('\n'),
      extensions: [javascript({ typescript: true })],
    });
    expect(bracketPairGuideLines(state)).toEqual([
      { line: 2, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 3, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 4, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 5, guides: [{ column: 0, depth: 0, active: false }] },
    ]);
  });

  it('aligns and highlights an interface with a continued inheritance declaration', () => {
    const doc = [
      'namespace Results {',
      '  export interface Page<T>',
      '    extends Base<T> {',
      '    value: T;',
      '  }',
      '}',
    ].join('\n');
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('value') },
      extensions: [javascript({ typescript: true })],
    });
    expect(bracketPairGuideLines(state)).toEqual([
      { line: 2, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 3, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 4, guides: [
        { column: 0, depth: 0, active: false },
        { column: 2, depth: 1, active: true },
      ] },
      { line: 5, guides: [{ column: 0, depth: 0, active: false }] },
    ]);
  });

  it('includes nested object types and type aliases alongside interface guides', () => {
    const state = EditorState.create({
      doc: [
        'export interface Result {',
        '  nested: {',
        '    value: string;',
        '  };',
        '  total: number;',
        '}',
        'type Other = {',
        '  value: string;',
        '};',
        'interface Inline { value: string; }',
        'interface Empty {}',
      ].join('\n'),
      extensions: [javascript({ typescript: true })],
    });
    expect(bracketPairGuideLines(state)).toEqual([
      { line: 2, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 3, guides: [
        { column: 0, depth: 0, active: false },
        { column: 2, depth: 1, active: false },
      ] },
      { line: 4, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 5, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 8, guides: [{ column: 0, depth: 0, active: false }] },
    ]);
  });

  it('includes nested object literals without closing their surrounding block guides', () => {
    const doc = [
      'function example() {',
      '  const value = {',
      '    nested: {',
      '      count: 1,',
      '    },',
      '  };',
      '  if (ready) {',
      '    return value;',
      '  }',
      '}',
    ].join('\n');
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.lastIndexOf('value') },
      extensions: [javascript({ typescript: true })],
    });

    expect(bracketPairGuideLines(state)).toEqual([
      { line: 2, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 3, guides: [
        { column: 0, depth: 0, active: false },
        { column: 2, depth: 1, active: false },
      ] },
      { line: 4, guides: [
        { column: 0, depth: 0, active: false },
        { column: 2, depth: 1, active: false },
        { column: 4, depth: 2, active: false },
      ] },
      { line: 5, guides: [
        { column: 0, depth: 0, active: false },
        { column: 2, depth: 1, active: false },
      ] },
      { line: 6, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 7, guides: [{ column: 0, depth: 0, active: false }] },
      {
        line: 8,
        guides: [
          { column: 0, depth: 0, active: false },
          { column: 2, depth: 1, active: true },
        ],
      },
      { line: 9, guides: [{ column: 0, depth: 0, active: false }] },
    ]);
  });

  it.each([
    {
      name: 'typed API object with a method',
      lines: ['const api: UsagePopoverApi = {', '  read: () => ipc.read(),', '  onChange(listener) {',
        '    const receive = () => listener();', '    return () => { receive(); };', '  },', '};'],
      expected: [[2, [0]], [3, [0]], [4, [0, 2]], [5, [0, 2]], [6, [0]]],
    },
    {
      name: 'constant error map',
      lines: ['export const CALENDAR_ERRORS = {', '  unsupported: "Unavailable",',
        '  conflict: "Refresh and retry",', '} as const;'],
      expected: [[2, [0]], [3, [0]]],
    },
    {
      name: 'nested objects passed to calls',
      lines: ['const background = createBackground({', '  acquire: () => getProfiles({',
        '    directory: root,', '    cwd: current,', '  }),', '  onError: reportError,', '});'],
      expected: [[2, [0]], [3, [0, 2]], [4, [0, 2]], [5, [0]], [6, [0]]],
    },
    {
      name: 'returned object with methods',
      lines: ['function create() {', '  return {', '    async start() {', '      return window;',
        '    },', '    dispose: () => {', '      cleanup();', '    },', '  };', '}'],
      expected: [[2, [0]], [3, [0, 2]], [4, [0, 2, 4]], [5, [0, 2]],
        [6, [0, 2]], [7, [0, 2, 4]], [8, [0, 2]], [9, [0]]],
    },
    {
      name: 'conditional factory arguments in a try block',
      lines: ['try { runtime = ready', '  ? createRuntime(options, {', '    app,',
        '    onShow: () => startup.close(),', '  }) : other(); }'],
      expected: [[2, [0]], [3, [0, 2]], [4, [0, 2]]],
    },
    {
      name: 'object on a continued argument line',
      lines: ['const result = create(', '  {', '    value: true,', '  },', ');'],
      expected: [[3, [2]]],
    },
    {
      name: 'default object in a continued function signature',
      lines: ['function create(', '  options = {', '    enabled: true,', '  },',
        ') {', '  run(options);', '}'],
      expected: [[3, [2]], [6, [0]]],
    },
    {
      name: 'destructuring pattern',
      lines: ['const {', '  item,', '  nested: {', '    value,', '  },', '} = source;'],
      expected: [[2, [0]], [3, [0]], [4, [0, 2]], [5, [0]]],
    },
    {
      name: 'multiline imports',
      lines: ['import {', '  first,', '  second,', '} from "module";'],
      expected: [[2, [0]], [3, [0]]],
    },
  ])('draws all brace guides for $name', ({ lines, expected }) => {
    const state = EditorState.create({ doc: lines.join('\n'), extensions: [javascript({ typescript: true })] });
    const actual: readonly (readonly [number, readonly number[]])[] = bracketPairGuideLines(state)
      .map(({ line, guides }) => [line, guides.map(guide => guide.column)] as const);
    expect(actual).toEqual(expected);
  });

  it('highlights the innermost object and limits its guides to the visible range', () => {
    const doc = 'const config = {\n  nested: {\n    enabled: true,\n  },\n};';
    const state = EditorState.create({
      doc, selection: { anchor: doc.indexOf('enabled') }, extensions: [javascript()],
    });
    expect(bracketPairGuideLines(state, state.doc.line(3).from, state.doc.line(3).to)).toEqual([
      { line: 3, guides: [
        { column: 0, depth: 0, active: false },
        { column: 2, depth: 1, active: true },
      ] },
    ]);
  });

  it('does not pair template interpolation endings or text braces with surrounding code', () => {
    const doc = ['function example() {', '  const template = `', '    {', '      ignored', '    }',
      '    ${value}', '  `;', '  const pattern = /[{}]/;', '  // }', '  /* { ignored } */', '  run();', '}'].join('\n');
    const state = EditorState.create({ doc, extensions: [javascript()] });
    expect(bracketPairGuideLines(state)).toEqual(Array.from({ length: 10 }, (_, index) => ({
      line: index + 2, guides: [{ column: 0, depth: 0, active: false }],
    })));
  });

  it('supports JSON object braces using the same syntax-token rule', () => {
    const doc = '{\n  "name": "{ ignored }",\n  "nested": {\n    "enabled": true\n  }\n}';
    const state = EditorState.create({ doc, extensions: [json()] });
    expect(bracketPairGuideLines(state).map(({ line, guides }) => [line, guides.map(guide => guide.column)]))
      .toEqual([[2, [0]], [3, [0]], [4, [0, 2]], [5, [0]]]);
  });

  it('does not draw guides for multiline parentheses or square brackets', () => {
    const doc = [
      'function App() {',
      '  return (',
      '    values[',
      '      0',
      '    ]',
      '  );',
      '}',
    ].join('\n');
    const state = EditorState.create({
      doc,
      extensions: [javascript({ typescript: true })],
    });

    expect(bracketPairGuideLines(state)).toEqual([
      { line: 2, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 3, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 4, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 5, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 6, guides: [{ column: 0, depth: 0, active: false }] },
    ]);
  });
});
