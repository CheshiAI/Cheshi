import { describe, expect, test } from 'bun:test';

import {
  PRESENTATION_ACCOUNT_LABEL,
  presentationAccountName,
  presentationMode,
  presentationUserName,
  presentationWorkspaceRoot,
} from '../frontend/src/shared/presentation';
import { chatGreeting } from '../frontend/src/features/chat/chatGreeting';

describe('presentation mode', () => {
  test('is off outside the desktop bridge', () => {
    expect(presentationMode).toBe(false);
  });

  test('passes identity through when not hidden', () => {
    expect(presentationUserName('raymond', false)).toBe('raymond');
    expect(presentationWorkspaceRoot('/Users/raymond/Projects/Cheshi', 'Cheshi', false)).toBe('/Users/raymond/Projects/Cheshi');
    expect(presentationAccountName('someone@example.com', false)).toBe('someone@example.com');
  });

  test('hides the user name, home path, and account email when hidden', () => {
    expect(presentationUserName('raymond', true)).toBe('');
    expect(chatGreeting(new Date(2026, 0, 1, 14), presentationUserName('raymond', true))).toBe('Good afternoon.');
    expect(presentationWorkspaceRoot('/Users/raymond/Projects/Cheshi', 'Cheshi', true)).toBe('…/Cheshi');
    expect(presentationAccountName('someone@example.com', true)).toBe(PRESENTATION_ACCOUNT_LABEL);
  });
});
