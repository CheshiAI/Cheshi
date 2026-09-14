import type { KeyboardEvent } from 'react';

interface ComposerKeys {
  interactionsLocked: boolean;
  commandMenuOpen: boolean;
  goalEditorOpen: boolean;
  optionPickerOpen: boolean;
  closeCommandMenu: () => void;
  saveGoal: () => void;
  moveHighlightedOption: (direction: number) => void;
  activateHighlightedOption: () => void;
  queueDraft: () => boolean;
  submit: () => void;
}

export function handleChatComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, options: ComposerKeys) {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  if (options.interactionsLocked && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    return;
  }
  if (options.commandMenuOpen) {
    if (event.key === 'Escape') {
      event.preventDefault();
      options.closeCommandMenu();
      return;
    }
    if (options.goalEditorOpen && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      options.saveGoal();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      options.moveHighlightedOption(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') && options.optionPickerOpen) {
      event.preventDefault();
      options.activateHighlightedOption();
      return;
    }
  }
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.repeat
    && !options.interactionsLocked && !options.commandMenuOpen && options.queueDraft()) {
    event.preventDefault();
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  options.submit();
}
