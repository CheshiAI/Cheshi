/** Shared line-offset helpers for embedded script/style blocks. */

export function embeddedContentStartLine(source: string, matchIndex: number, matchText: string): number {
  const beforeTag = source.substring(0, matchIndex);
  const openingTag = matchText.substring(0, matchText.indexOf('>') + 1);
  return (beforeTag.match(/\n/g) || []).length + (openingTag.match(/\n/g) || []).length;
}

export function embeddedBlockRanges(source: string, pattern: RegExp): Array<[number, number]> {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const ranges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const startLine = (source.substring(0, match.index).match(/\n/g) || []).length;
    const endLine = startLine + (match[0].match(/\n/g) || []).length;
    ranges.push([startLine, endLine]);
  }
  return ranges;
}
