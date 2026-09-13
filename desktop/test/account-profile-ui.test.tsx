import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountProfileUsage } from '../frontend/src/features/account/AccountProfileUsage';
import type { CodexAccountProfile } from '../shared/codex-accounts';

const profile: CodexAccountProfile = {
  id: 'default', label: 'Default account', email: 'account@example.com',
  usage: { state: 'ready', authenticated: true, plan: 'pro', rateLimits: [], error: null },
  login: { state: 'signed_in', error: null },
};

function render(options: { active?: boolean; pending?: boolean; selectionDisabledReason?: string; signedOut?: boolean; usageError?: string } = {}) {
  return renderToStaticMarkup(<AccountProfileUsage
    profile={options.signedOut ? { ...profile, email: null,
      usage: { ...profile.usage, state: 'login_required', authenticated: false, plan: null },
      login: { state: 'signed_out', error: null } } : options.usageError
      ? { ...profile, usage: { ...profile.usage, state: 'error', error: options.usageError } } : profile}
    active={options.active ?? false} pending={options.pending ?? false}
    selectionDisabledReason={options.selectionDisabledReason}
    onLogin={() => {}} onLogout={() => {}} onCancel={() => {}} onSelect={() => {}} />);
}

function button(html: string, label: string): string | undefined {
  return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(value =>
    value.includes(`aria-label="${label}"`) || value.endsWith(`>${label}</button>`));
}

test('active account offers logout and a noninteractive active indicator', () => {
  const html = render({ active: true });
  expect(button(html, 'Log out')).toBeDefined();
  expect(button(html, 'Log out')).not.toContain('disabled');
  expect(button(html, 'Active')).toContain('disabled');
  expect(button(html, 'Use account')).toBeUndefined();
});

test('workspace restrictions block active logout and account switching but allow inactive logout', () => {
  const active = render({ active: true, selectionDisabledReason: 'Finish the response first.' });
  expect(button(active, 'Log out')).toContain('disabled');
  expect(button(active, 'Log out')).toContain('Finish the response first.');
  const inactive = render({ selectionDisabledReason: 'Finish the response first.' });
  expect(button(inactive, 'Log out')).not.toContain('disabled');
  expect(button(inactive, 'Use account')).toContain('disabled');
});

test('pending operations prevent repeated logout and selection', () => {
  const html = render({ pending: true });
  expect(button(html, 'Log out')).toContain('disabled');
  expect(button(html, 'Use account')).toContain('disabled');
});

test('usage authentication errors remain visible and allow logout while blocking selection', () => {
  const error = 'Usage authentication failed (401). Log out of this account and sign in again.';
  const html = render({ usageError: error });
  expect(html).toContain(error);
  expect(button(html, 'Log out')).not.toContain('disabled');
  expect(button(html, 'Use account')).toContain('disabled');
});

test('signed out accounts offer sign in and cancellation instead of authenticated actions', () => {
  const html = render({ signedOut: true });
  expect(button(html, 'Sign in')).toBeDefined();
  expect(button(html, 'Cancel')).toBeDefined();
  expect(button(html, 'Log out')).toBeUndefined();
  expect(button(html, 'Use account')).toBeUndefined();
});
