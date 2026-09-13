import { describe, expect, it } from 'bun:test';
import { handleWorkspaceEntryEditKeyDown } from '../frontend/src/features/navigation/workspaceEntryEditInteraction';

function pressKey(key: string, { busy = false, composing = false, keyCode = 0 } = {}) {
  let prevented = false;
  let cancelled = false;
  handleWorkspaceEntryEditKeyDown({
    key,
    nativeEvent: { isComposing: composing, keyCode },
    preventDefault: () => { prevented = true; },
  }, busy, () => { cancelled = true; });
  return { prevented, cancelled };
}

describe('workspace entry edit keyboard interactions', () => {
  it('allows normal Enter to submit the form', () => {
    expect(pressKey('Enter')).toEqual({ prevented: false, cancelled: false });
  });

  it('does not submit when Enter confirms IME composition, including WebKit fallback', () => {
    expect(pressKey('Enter', { composing: true })).toEqual({ prevented: true, cancelled: false });
    expect(pressKey('Enter', { keyCode: 229 })).toEqual({ prevented: true, cancelled: false });
  });

  it('blocks repeat submission while a filesystem mutation is pending', () => {
    expect(pressKey('Enter', { busy: true })).toEqual({ prevented: true, cancelled: false });
  });

  it('cancels on Escape bubbled from either input or clear button', () => {
    expect(pressKey('Escape')).toEqual({ prevented: true, cancelled: true });
  });

  it('leaves Escape to the IME while composing', () => {
    expect(pressKey('Escape', { composing: true })).toEqual({ prevented: false, cancelled: false });
    expect(pressKey('Escape', { keyCode: 229 })).toEqual({ prevented: false, cancelled: false });
  });

  it('does not dismiss an operation that is already writing to disk', () => {
    expect(pressKey('Escape', { busy: true })).toEqual({ prevented: true, cancelled: false });
  });
});
