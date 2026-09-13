import { describe, expect, it } from 'bun:test';

import { applyLanguageServerTextEdits } from '../frontend/src/features/editor/workspaceTextEdits';

describe('workspace text edits', () => {
  it('applies non-overlapping LSP edits from the end of the document', () => {
    const result = applyLanguageServerTextEdits('const first = 1;\nconst second = 2;\n', [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        newText: 'renamedFirst',
      },
      {
        range: { start: { line: 1, character: 15 }, end: { line: 1, character: 16 } },
        newText: '20',
      },
    ]);
    expect(result.content).toBe('const renamedFirst = 1;\nconst second = 20;\n');
    expect(result.previews).toEqual([
      { line: 1, before: 'first', after: 'renamedFirst' },
      { line: 2, before: '2', after: '20' },
    ]);
  });

  it('uses UTF-16 character offsets used by LSP and CodeMirror', () => {
    const result = applyLanguageServerTextEdits('const emoji = "😀value";\n', [{
      range: { start: { line: 0, character: 17 }, end: { line: 0, character: 22 } },
      newText: 'updated',
    }]);
    expect(result.content).toBe('const emoji = "😀updated";\n');
  });

  it('rejects overlapping or out-of-bounds edits', () => {
    expect(() => applyLanguageServerTextEdits('value\n', [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: 'one',
      },
      {
        range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
        newText: 'two',
      },
    ])).toThrow('overlapping');
    expect(() => applyLanguageServerTextEdits('value\n', [{
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
      newText: 'nope',
    }])).toThrow('outside the file');
  });
});
