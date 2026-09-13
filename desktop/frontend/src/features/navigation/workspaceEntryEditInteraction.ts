interface EntryEditKeyEvent {
  key: string;
  nativeEvent: { isComposing: boolean; keyCode: number };
  preventDefault: () => void;
}

export function handleWorkspaceEntryEditKeyDown(
  event: EntryEditKeyEvent,
  busy: boolean,
  onCancel: () => void,
): void {
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  if (event.key === 'Enter' && (busy || composing)) {
    event.preventDefault();
    return;
  }
  if (event.key !== 'Escape' || composing) return;
  event.preventDefault();
  if (!busy) onCancel();
}
