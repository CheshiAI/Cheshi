import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { normalizeCodeActionResult } from '../lib/language-server-results.mts';

const workspaceRoot = path.resolve('/test-workspace');
const textEdit = {
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  },
  newText: 'const value = 1;\n',
};
const edit = {
  changes: {
    [pathToFileURL(path.join(workspaceRoot, 'main.ts')).href]: [textEdit],
  },
};
const normalizedEdit = { files: [{ path: 'main.ts', edits: [textEdit] }] };

test('skips disabled action resolution while still resolving applicable actions', async () => {
  const disabled = {
    title: 'Extract function',
    kind: 'refactor.extract',
    disabled: { reason: 'Select more than a single identifier.' },
    data: { id: 'extract' },
  };
  const applicable = { title: 'Add declaration', data: { id: 'declare' } };
  const calls: unknown[] = [];
  const result = await normalizeCodeActionResult([disabled, applicable], workspaceRoot, {
    async resolveCodeAction(action: unknown) {
      calls.push(action);
      return { ...applicable, edit };
    },
  });

  assert.deepEqual(calls, [applicable]);
  assert.deepEqual(result.actions, [
    {
      title: disabled.title,
      kind: disabled.kind,
      preferred: false,
      disabledReason: disabled.disabled.reason,
      edit: null,
    },
    {
      title: applicable.title,
      kind: null,
      preferred: false,
      disabledReason: null,
      edit: normalizedEdit,
    },
  ]);
});

test('treats an empty string reason as disabled without resolving', async () => {
  let calls = 0;
  const result = await normalizeCodeActionResult([
    { title: 'Unavailable action', disabled: { reason: '' }, data: {} },
  ], workspaceRoot, {
    async resolveCodeAction() {
      calls += 1;
      return null;
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.actions[0]?.disabledReason, '');
});

test('does not mistake a malformed disabled reason for a disabled action', async () => {
  const action = { title: 'Add declaration', disabled: { reason: false }, data: {} };
  let calls = 0;
  const result = await normalizeCodeActionResult([action], workspaceRoot, {
    async resolveCodeAction() {
      calls += 1;
      return { ...action, edit };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.actions[0]?.disabledReason, null);
  assert.deepEqual(result.actions[0]?.edit, normalizedEdit);
});

test('preserves the disabled reason returned by action resolution', async () => {
  const action = { title: 'Extract function', data: {} };
  const result = await normalizeCodeActionResult([action], workspaceRoot, {
    async resolveCodeAction() {
      return { ...action, disabled: { reason: 'The selection is not supported.' } };
    },
  });

  assert.equal(result.actions[0]?.disabledReason, 'The selection is not supported.');
  assert.equal(result.actions[0]?.edit, null);
});
