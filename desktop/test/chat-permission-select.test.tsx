import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatPermissionSelectView } from '../frontend/src/features/chat/ChatPermissionSelect';
import { chatPermissionChoices } from '../frontend/src/features/chat/useChatPermissions';
import type { ChatPermissionMode } from '../frontend/src/features/chat/model';

const readOnly: ChatPermissionMode = { id: 'read-only', profileId: ':read-only', label: 'Read only',
  description: 'Inspect without editing files.', access: 'Read only', allowed: true, dangerous: false };
const workspace: ChatPermissionMode = { ...readOnly, id: 'ask-for-approval', profileId: ':workspace',
  label: 'Ask for approval', access: 'Ask for approval', description: 'Edit workspace files and ask before additional access.' };
const unrestricted: ChatPermissionMode = { ...readOnly, id: 'full-access', profileId: ':danger-full-access',
  label: 'Full access', access: 'Full access', allowed: false, dangerous: true };
const render = (selected: ChatPermissionMode | null, overrides: { busy?: boolean; disabled?: boolean; error?: string | null } = {}) =>
  renderToStaticMarkup(<ChatPermissionSelectView choices={[readOnly, workspace, unrestricted]} selected={selected}
    busy={false} disabled={false} error={null} onChange={() => {}} onRetry={() => {}} {...overrides} />);

test('reflects the authoritative selected mode in the shared dropdown', () => {
  const html = render(workspace);
  expect(html).toContain('aria-label="Chat permissions"');
  expect(html).toContain('<span>Ask for approval</span>');
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('Edit workspace files and ask before additional access.');
});

test('starts with a read-only placeholder and prevents changes while loading or locked', () => {
  const html = render(null, { busy: true });
  expect(html).toMatch(/<button[^>]*aria-busy="true"[^>]*disabled=""/);
  expect(html).toContain('<span>Read only</span>');
  expect(render(readOnly, { disabled: true })).toMatch(/<button[^>]*disabled=""/);
});

test('retains the actual current mode and offers retry after an options request fails', () => {
  const html = render(workspace, { error: 'Permission profiles unavailable.' });
  expect(html).toContain('role="alert"');
  expect(html).toContain('Permission profiles unavailable.');
  expect(html).toContain('aria-label="Retry permission options"');
  expect(html).toContain('<span>Ask for approval</span>');
});

test('keeps a selected custom mode visible without confusing identical labels', () => {
  const custom = { ...workspace, id: 'custom:team', profileId: 'team' };
  expect(chatPermissionChoices([workspace], custom)).toEqual([custom, workspace]);
  expect(chatPermissionChoices([custom, workspace], custom)).toEqual([custom, workspace]);
});

test('passes forbidden profiles and custom identifiers to the shared menu without enabling them', () => {
  const custom = { ...workspace, id: 'custom:team' };
  const view = ChatPermissionSelectView({ choices: [readOnly, custom, unrestricted], selected: custom,
    busy: false, disabled: false, error: null, onChange: () => {}, onRetry: () => {} });
  const select = view.props.children[0];
  expect(select.props.value).toBe('custom:team');
  expect(select.props.options).toEqual([
    { value: readOnly.id, label: readOnly.label, disabled: false, description: readOnly.description },
    { value: custom.id, label: custom.label, disabled: false, description: custom.description },
    { value: unrestricted.id, label: unrestricted.label, disabled: true, description: unrestricted.description },
  ]);
});
