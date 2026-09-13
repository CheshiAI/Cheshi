import type {
  LanguageServerPosition,
  LanguageServerTextEdit,
} from '../../cheshiDesktop';

export interface WorkspaceTextEditPreview {
  line: number;
  before: string;
  after: string;
}

export interface AppliedWorkspaceTextEdits {
  content: string;
  previews: WorkspaceTextEditPreview[];
}

interface OffsetEdit {
  from: number;
  to: number;
  newText: string;
  line: number;
  index: number;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionOffset(
  content: string,
  starts: readonly number[],
  position: LanguageServerPosition,
): number {
  if (position.line < 0 || position.line >= starts.length) {
    throw new Error('Language server edit points outside the file.');
  }
  const start = starts[position.line] ?? 0;
  let end = starts[position.line + 1] ?? content.length;
  if (end > start && content.charCodeAt(end - 1) === 10) end -= 1;
  if (end > start && content.charCodeAt(end - 1) === 13) end -= 1;
  if (position.character < 0 || position.character > end - start) {
    throw new Error('Language server edit points outside its source line.');
  }
  return start + position.character;
}

function previewText(value: string): string {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}…`;
}

export function applyLanguageServerTextEdits(
  content: string,
  edits: readonly LanguageServerTextEdit[],
): AppliedWorkspaceTextEdits {
  const starts = lineStarts(content);
  const offsetEdits: OffsetEdit[] = edits.map((edit, index) => {
    const from = positionOffset(content, starts, edit.range.start);
    const to = positionOffset(content, starts, edit.range.end);
    if (to < from) throw new Error('Language server edit range is reversed.');
    return {
      from,
      to,
      newText: edit.newText,
      line: edit.range.start.line + 1,
      index,
    };
  }).sort((left, right) => left.from - right.from || left.to - right.to || left.index - right.index);

  for (let index = 1; index < offsetEdits.length; index += 1) {
    const previous = offsetEdits[index - 1]!;
    const current = offsetEdits[index]!;
    if (
      current.from < previous.to
      || (current.from === previous.from && current.to === previous.to)
    ) {
      throw new Error('Language server returned overlapping edits.');
    }
  }

  let nextContent = content;
  for (const edit of [...offsetEdits].reverse()) {
    nextContent = `${nextContent.slice(0, edit.from)}${edit.newText}${nextContent.slice(edit.to)}`;
  }
  return {
    content: nextContent,
    previews: offsetEdits.map((edit) => ({
      line: edit.line,
      before: previewText(content.slice(edit.from, edit.to)),
      after: previewText(edit.newText),
    })),
  };
}
