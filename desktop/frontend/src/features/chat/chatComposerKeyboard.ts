import type { KeyboardEvent } from 'react';

interface ComposerKeyboardOptions {
  locked: boolean;
  menuOpen: boolean;
  goalOpen: boolean;
  pickerOpen: boolean;
  closeMenu(): void;
  saveGoal(): void;
  moveOption(offset: number): void;
  activateOption(): void;
  enqueue(): boolean;
  submit(): void;
}

export function handleChatComposerKey(event: KeyboardEvent<HTMLTextAreaElement>, options: ComposerKeyboardOptions) {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  if (options.locked && ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab')) {
    if (event.key === 'Enter') event.preventDefault();
    return;
  }
  if (options.menuOpen) {
    if (event.key === 'Escape') { event.preventDefault(); options.closeMenu(); return; }
    if (options.goalOpen && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); options.saveGoal(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); options.moveOption(event.key === 'ArrowDown' ? 1 : -1); return;
    }
    if (((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') && options.pickerOpen) {
      event.preventDefault(); options.activateOption(); return;
    }
  }
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    && !options.menuOpen && options.enqueue()) { event.preventDefault(); return; }
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault(); options.submit();
}

/** Both Enter and the send button use the same delivery policy. */
export function submitChatComposerDraft(options: {
  streaming: boolean;
  enqueue(): boolean;
  send(): void;
}): void {
  if (options.streaming) { options.enqueue(); return; }
  options.send();
}

export function handleChatEscape(event: KeyboardEvent<HTMLElement>, options: {
  active: boolean;
  locked: boolean;
  overlayFocused: boolean;
  menuOpen: boolean;
  configurationOpen: boolean;
  closeMenu(): void;
  closeConfiguration(): void;
  cancelAll(): boolean;
}): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing
    || event.nativeEvent.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || !options.active) return;
  if (options.menuOpen) options.closeMenu();
  else if (options.configurationOpen) options.closeConfiguration();
  else if (options.locked || options.overlayFocused || !options.cancelAll()) return;
  event.preventDefault();
  event.stopPropagation();
}
