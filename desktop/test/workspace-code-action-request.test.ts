import { describe, expect, it } from 'bun:test';
import type { Dispatch, SetStateAction } from 'react';

import type { WorkspaceEditorAssistState } from '../frontend/src/features/editor/workspaceEditorAssistState';
import { requestWorkspaceCodeActions } from '../frontend/src/features/editor/workspaceCodeActionRequest';
import type { LanguageServerCodeAction } from '../frontend/src/cheshiDesktop';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createPanel() {
  let state: WorkspaceEditorAssistState | null = null;
  const setAssistState: Dispatch<SetStateAction<WorkspaceEditorAssistState | null>> = (next) => {
    state = typeof next === 'function' ? next(state) : next;
  };
  return { read: () => state, setAssistState };
}

function action(title: string, preferred = false): LanguageServerCodeAction {
  return {
    title, preferred, kind: 'quickfix', disabledReason: null,
    edit: { files: [{ path: 'file.ts', edits: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      newText: 'fixed',
    }] }] },
  };
}

describe('code action panel requests', () => {
  it('opens a loading panel before the server responds and preserves action ordering', async () => {
    const panel = createPanel();
    const deferred = createDeferred<LanguageServerCodeAction[]>();
    const request = requestWorkspaceCodeActions({ ...panel, load: () => deferred.promise, isCurrent: () => true });
    expect(panel.read()).toEqual({ kind: 'actions', actions: [], loading: true, error: null });
    const disabled = { ...action('Disabled', true), disabledReason: 'Unavailable' };
    const zebra = action('Zebra');
    const preferred = action('Preferred', true);
    const alpha = action('Alpha');
    const actions = [zebra, disabled, preferred, alpha];
    deferred.resolve(actions);
    await request;
    expect(panel.read()).toEqual({
      kind: 'actions', loading: false, error: null,
      actions: [preferred, alpha, zebra, disabled],
    });
    expect(actions.map((item) => item.title)).toEqual(['Zebra', 'Disabled', 'Preferred', 'Alpha']);
  });

  it('clears the loading state for an empty result', async () => {
    const panel = createPanel();
    await requestWorkspaceCodeActions({ ...panel, load: async () => [], isCurrent: () => true });
    expect(panel.read()).toEqual({ kind: 'actions', actions: [], loading: false, error: null });
  });

  it('shows a request failure in the panel and stops loading', async () => {
    const panel = createPanel();
    await requestWorkspaceCodeActions({
      ...panel, isCurrent: () => true,
      load: async () => { throw new Error('Language server timed out'); },
    });
    expect(panel.read()).toEqual({ kind: 'actions', actions: [], loading: false, error: 'Language server timed out' });
  });

  it('does not reopen a closed panel for either a success or a failure', async () => {
    for (const fails of [false, true]) {
      const panel = createPanel();
      const deferred = createDeferred<LanguageServerCodeAction[]>();
      const request = requestWorkspaceCodeActions({ ...panel, load: () => deferred.promise, isCurrent: () => true });
      panel.setAssistState(null);
      if (fails) deferred.reject(new Error('Late failure'));
      else deferred.resolve([action('Late result')]);
      await request;
      expect(panel.read()).toBeNull();
    }
  });

  it('keeps a newer request when an older one finishes later', async () => {
    const panel = createPanel();
    const first = createDeferred<LanguageServerCodeAction[]>();
    const second = createDeferred<LanguageServerCodeAction[]>();
    const request1 = requestWorkspaceCodeActions({ ...panel, load: () => first.promise, isCurrent: () => true });
    const request2 = requestWorkspaceCodeActions({ ...panel, load: () => second.promise, isCurrent: () => true });
    const current = [action('Current result')];
    second.resolve(current);
    await request2;
    first.reject(new Error('Old failure'));
    await request1;
    expect(panel.read()).toEqual({ kind: 'actions', actions: current, loading: false, error: null });
  });

  it('does not overwrite a different assistant panel', async () => {
    const panel = createPanel();
    const deferred = createDeferred<LanguageServerCodeAction[]>();
    const request = requestWorkspaceCodeActions({ ...panel, load: () => deferred.promise, isCurrent: () => true });
    const rename: WorkspaceEditorAssistState = { kind: 'rename', value: 'Name', placeholder: 'Name', submitting: false };
    panel.setAssistState(rename);
    deferred.resolve([]);
    await request;
    expect(panel.read()).toBe(rename);
  });

  it('discards results when the source document or editor is no longer current', async () => {
    const panel = createPanel();
    const deferred = createDeferred<LanguageServerCodeAction[]>();
    let current = true;
    const request = requestWorkspaceCodeActions({ ...panel, load: () => deferred.promise, isCurrent: () => current });
    current = false;
    deferred.resolve([action('Stale edit')]);
    await request;
    expect(panel.read()).toBeNull();
  });
});
