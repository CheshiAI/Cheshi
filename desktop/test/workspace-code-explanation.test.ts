import { describe, expect, test } from 'bun:test';
import { EditorSelection, EditorState } from '@codemirror/state';

import {
  captureCodeExplanationSelection,
  createCodeExplanationSession,
  type CodeExplanationState,
} from '../frontend/src/features/editor/workspaceCodeExplanation';
import type { CodeExplanationResult } from '../shared/workspace-code-explanation';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const selection = {
  path: 'src/draft.ts', startLine: 1, endLine: 1,
  selectedText: 'draft()', contextBefore: '', contextAfter: '',
};

function createSession() {
  const pending = new Map<string, ReturnType<typeof createDeferred<CodeExplanationResult>>>();
  const cancelled: string[] = [];
  const states: Array<CodeExplanationState | null> = [];
  let sequence = 0;
  const session = createCodeExplanationSession({
    createRequestId: () => `request-${++sequence}`,
    explain(request) {
      const deferred = createDeferred<CodeExplanationResult>();
      pending.set(request.requestId, deferred);
      return deferred.promise;
    },
    async cancel(requestId) { cancelled.push(requestId); },
    onChange: (state) => states.push(state),
  });
  return { session, pending, cancelled, states };
}

describe('selected code explanation', () => {
  test('captures the unsaved editor text, adjacent context, and actual excerpt lines', () => {
    const state = EditorState.create({
      doc: 'before\nunsaved()\nafter',
      selection: { anchor: 7, head: 17 },
    });
    expect(captureCodeExplanationSelection(state, 'src/draft.ts', 40)).toEqual({
      path: 'src/draft.ts', startLine: 41, endLine: 41,
      selectedText: 'unsaved()\n', contextBefore: 'before\n', contextAfter: 'after',
    });
  });

  test('bounds adjacent context and preserves the entire selection', () => {
    const state = EditorState.create({
      doc: `${'a'.repeat(9_000)}draft()${'z'.repeat(9_000)}`,
      selection: { anchor: 9_000, head: 9_007 },
    });
    const result = captureCodeExplanationSelection(state, 'draft.ts');
    expect(result.selectedText).toBe('draft()');
    expect(result.contextBefore).toHaveLength(8_000);
    expect(result.contextAfter).toHaveLength(8_000);
  });

  test('rejects empty, oversized, and discontinuous selections', () => {
    expect(() => captureCodeExplanationSelection(EditorState.create({ doc: 'code' }), 'draft.ts')).toThrow('Select the code');
    expect(() => captureCodeExplanationSelection(EditorState.create({
      doc: 'a'.repeat(32_001), selection: { anchor: 0, head: 32_001 },
    }), 'draft.ts')).toThrow('32,000');
    expect(() => captureCodeExplanationSelection(EditorState.create({
      doc: 'one two',
      extensions: EditorState.allowMultipleSelections.of(true),
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
    }), 'draft.ts')).toThrow('continuous');
  });

  test('shows loading immediately and retains the finished explanation', async () => {
    const { session, pending, states, cancelled } = createSession();
    const request = session.start(selection);
    expect(states.at(-1)?.loading).toBe(true);
    pending.get('request-1')!.resolve({ text: 'Explains draft.', model: 'gpt-5.6-luna' });
    await request;
    expect(states.at(-1)?.text).toBe('Explains draft.');
    session.dismiss();
    expect(states.at(-1)).toBeNull();
    expect(cancelled).toEqual([]);
  });

  test('dismissal cancels pending work and ignores a late response', async () => {
    const { session, pending, states, cancelled } = createSession();
    const request = session.start(selection);
    session.dismiss();
    pending.get('request-1')!.resolve({ text: 'Too late.', model: 'gpt-5.6-luna' });
    await request;
    expect(cancelled).toEqual(['request-1']);
    expect(states.at(-1)).toBeNull();
  });

  test('replacement cancels the earlier request and ignores its late error', async () => {
    const { session, pending, states, cancelled } = createSession();
    const first = session.start(selection);
    const second = session.start({ ...selection, selectedText: 'newer()' });
    pending.get('request-1')!.reject(new Error('Old failure'));
    await first;
    expect(states.at(-1)?.selection.selectedText).toBe('newer()');
    expect(states.at(-1)?.loading).toBe(true);
    pending.get('request-2')!.resolve({ text: 'New explanation.', model: 'gpt-5.6-luna' });
    await second;
    expect(states.at(-1)?.text).toBe('New explanation.');
    expect(cancelled).toEqual(['request-1']);
  });

  test('reports request failure and disposal prevents subsequent state updates', async () => {
    const { session, pending, states, cancelled } = createSession();
    const first = session.start(selection);
    pending.get('request-1')!.reject(new Error('Luna unavailable'));
    await first;
    expect(states.at(-1)?.error).toBe('Luna unavailable');
    const second = session.start(selection);
    const stateCount = states.length;
    session.dispose();
    pending.get('request-2')!.reject(new Error('Cancelled'));
    await second;
    expect(states).toHaveLength(stateCount);
    expect(cancelled).toEqual(['request-2']);
  });
});
