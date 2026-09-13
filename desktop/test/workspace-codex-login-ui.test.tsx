import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceCodexLoginView } from '../frontend/src/features/navigation/workspace-management/WorkspaceCodexLogin';
import type { WorkspaceCodexLoginState } from '../shared/workspace-management';

function render(state: WorkspaceCodexLoginState['state'], busy = false, ready = false) {
  return renderToStaticMarkup(<WorkspaceCodexLoginView status={{ state, error: state === 'error' ? 'Could not start Codex login.' : null }}
    busy={busy} ready={ready} onLogin={() => {}} onCancel={() => {}} onRetry={() => {}} />);
}

test('Codex login is offered only when signed out and disappears when authenticated', () => {
  expect(render('signed_out')).toContain('Continue with ChatGPT');
  expect(render('signed_out', true)).toContain('disabled=""');
  expect(render('signed_out')).toContain('Welcome to Cheshi');
  expect(render('signed_in')).toContain('Preparing...');
  expect(render('signed_in', false, true)).toBe('');
  expect(render('checking')).toContain('Checking Codex sign-in');
  expect(render('checking')).not.toContain('<button');
});

test('waiting sign-in can be cancelled and failures offer retry without displaying auth details', () => {
  const waiting = render('signing_in');
  expect(waiting).toContain('Complete sign-in in your browser');
  expect(waiting).toContain('Cancel');
  expect(waiting).not.toContain('Continue with ChatGPT');
  const error = render('error');
  expect(error).toContain('role="alert"');
  expect(error).toContain('Retry');
  expect(error).not.toContain('authUrl');
});
