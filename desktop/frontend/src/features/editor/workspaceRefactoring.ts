const RECOMMENDED_FILE_LINE_LIMIT = 1_000;

export function fileRefactoringRecommendation(content: string, filePath = ''): string | null {
  if (filePath.split(/[\\/]/).at(-1) === 'bun.lock') return null;

  let lineCount = content.length > 0 ? 1 : 0;
  for (const match of content.matchAll(/\r\n|\r|\n/g)) {
    if (match.index + match[0].length < content.length) lineCount += 1;
  }

  if (lineCount <= RECOMMENDED_FILE_LINE_LIMIT) return null;
  return `This file has ${lineCount.toLocaleString('en-US')} lines (recommended maximum: ${RECOMMENDED_FILE_LINE_LIMIT.toLocaleString('en-US')}). Consider splitting it into smaller files by responsibility.`;
}
