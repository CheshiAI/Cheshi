export interface LocalHistoryDiffLine {
  text: string;
  number: number;
}

export interface LocalHistoryDiffRow {
  previous: LocalHistoryDiffLine | null;
  current: LocalHistoryDiffLine | null;
  changed: boolean;
}

interface DiffResult {
  rows: LocalHistoryDiffRow[];
  simplified: boolean;
  truncated: boolean;
}

const MAX_LCS_CELLS = 1_000_000;
const MAX_DISPLAY_ROWS = 10_000;

function lines(content: string): string[] {
  return content.length ? content.replace(/\r\n|\r/g, '\n').split('\n') : [];
}

/** Bound comparison work for heavily rewritten files; unchanged ends stay aligned. */
export function localHistoryDiff(previousText: string, currentText: string): DiffResult {
  const previous = lines(previousText);
  const current = lines(currentText);
  const rows: LocalHistoryDiffRow[] = [];
  let rowCount = 0;
  const addRow = (oldIndex: number | null, newIndex: number | null, changed: boolean): void => {
    rowCount += 1;
    if (rows.length === MAX_DISPLAY_ROWS) return;
    rows.push({
      previous: oldIndex === null ? null : { text: previous[oldIndex]!, number: oldIndex + 1 },
      current: newIndex === null ? null : { text: current[newIndex]!, number: newIndex + 1 },
      changed,
    });
  };
  let prefix = 0;
  while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) {
    addRow(prefix, prefix, false);
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < current.length - prefix
    && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix += 1;
  const oldLength = previous.length - prefix - suffix;
  const newLength = current.length - prefix - suffix;
  const simplified = (oldLength + 1) * (newLength + 1) > MAX_LCS_CELLS;
  const addChangedBlock = (oldStart: number, oldEnd: number, newStart: number, newEnd: number): void => {
    for (let offset = 0; offset < Math.max(oldEnd - oldStart, newEnd - newStart); offset += 1) {
      addRow(oldStart + offset < oldEnd ? oldStart + offset : null,
        newStart + offset < newEnd ? newStart + offset : null, true);
    }
  };
  if (simplified) {
    addChangedBlock(prefix, previous.length - suffix, prefix, current.length - suffix);
  } else {
    const width = newLength + 1;
    const matches = new Uint32Array((oldLength + 1) * width);
    for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
        matches[oldIndex * width + newIndex] = previous[prefix + oldIndex] === current[prefix + newIndex]
          ? 1 + matches[(oldIndex + 1) * width + newIndex + 1]!
          : Math.max(matches[(oldIndex + 1) * width + newIndex]!, matches[oldIndex * width + newIndex + 1]!);
      }
    }
    let oldIndex = 0;
    let newIndex = 0;
    let oldStart = 0;
    let newStart = 0;
    while (oldIndex < oldLength || newIndex < newLength) {
      if (oldIndex < oldLength && newIndex < newLength
        && previous[prefix + oldIndex] === current[prefix + newIndex]) {
        addChangedBlock(prefix + oldStart, prefix + oldIndex, prefix + newStart, prefix + newIndex);
        addRow(prefix + oldIndex, prefix + newIndex, false);
        oldStart = ++oldIndex;
        newStart = ++newIndex;
      } else if (oldIndex < oldLength && (newIndex === newLength
        || matches[(oldIndex + 1) * width + newIndex]! >= matches[oldIndex * width + newIndex + 1]!)) {
        oldIndex += 1;
      } else {
        newIndex += 1;
      }
    }
    addChangedBlock(prefix + oldStart, prefix + oldIndex, prefix + newStart, prefix + newIndex);
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    addRow(previous.length - offset, current.length - offset, false);
  }
  return { rows, simplified, truncated: rowCount > MAX_DISPLAY_ROWS };
}
