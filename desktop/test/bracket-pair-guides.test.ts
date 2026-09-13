import { describe, expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { javascript } from '@codemirror/lang-javascript';
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

  it('ignores object literals without closing their surrounding block guides', () => {
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
      { line: 3, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 4, guides: [{ column: 0, depth: 0, active: false }] },
      { line: 5, guides: [{ column: 0, depth: 0, active: false }] },
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
