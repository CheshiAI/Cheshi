import type { KeyboardEvent } from 'react';
import { chatImportLabel, type ChatImportAttachment } from '../../../../shared/chat-imports';

interface ImportRange { start: number; end: number }

function containsCaret(range: ImportRange, caret: number) {
  return range.start < caret && caret < range.end;
}

/** Keep the native textarea while moving across connected references as a unit. */
export function handleChatImportNavigation(event: KeyboardEvent<HTMLTextAreaElement>, attachments: readonly ChatImportAttachment[]) {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    || event.altKey || event.ctrlKey || event.metaKey || !attachments.length
    || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;

  const input = event.currentTarget;
  if (input.disabled) return;
  const labels = new Set(attachments.flatMap(attachment => attachment.importNumber === undefined
    ? [] : [chatImportLabel(attachment.importNumber)]));
  const ranges: ImportRange[] = [];
  for (const match of input.value.matchAll(/\[import [1-9]\d*\]/g)) {
    if (labels.has(match[0])) ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  const start = input.selectionStart, end = input.selectionEnd;
  const left = event.key === 'ArrowLeft';
  const backward = input.selectionDirection === 'backward';
  const collapsing = !event.shiftKey && start !== end;
  const focus = collapsing ? (left ? start : end) : (backward ? start : end);
  const range = ranges.find(candidate => collapsing ? containsCaret(candidate, focus)
    : left ? candidate.start < focus && focus <= candidate.end
      : candidate.start <= focus && focus < candidate.end);
  if (!range) return;

  const target = left ? range.start : range.end;
  let anchor = event.shiftKey ? (backward ? end : start) : target;
  // A mouse selection may start inside a reference; Shift selects the full label.
  const anchorRange = event.shiftKey ? ranges.find(candidate => containsCaret(candidate, anchor)) : undefined;
  if (anchorRange) anchor = target < anchor ? anchorRange.end : anchorRange.start;
  event.preventDefault();
  input.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target),
    target === anchor ? 'none' : target < anchor ? 'backward' : 'forward');
}
