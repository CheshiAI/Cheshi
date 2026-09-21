import { Lexer, walkTokens } from 'marked';
import { SkillFlowValidationError } from './skill-flow-runtime.mts';

export interface ResearchIssue {
  code: 'invalid_json' | 'invalid_shape' | 'invalid_text' | 'invalid_citations' | 'forbidden_markup'
    | 'output_limit' | 'requirement_unmet' | 'unsupported_claim' | 'rendered_links';
  field: string;
}
export class ResearchValidationError extends SkillFlowValidationError {
  readonly issue: ResearchIssue;
  constructor(code: ResearchIssue['code'], field: string) {
    super();
    this.issue = { code, field };
  }
}
export function assertResearch(value: unknown, code: ResearchIssue['code'], field: string): asserts value {
  if (value !== true) throw new ResearchValidationError(code, field);
}

const placeholderPattern = /<[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+>/;

/** Tag each occurrence before lexing: normalized token text is not a source offset. */
function escapeProsePlaceholders(source: string, expectedCount: number, field: string): string {
  let prefix = 'cheshiplaceholder';
  while (source.includes(prefix)) prefix += 'x';
  const occurrences = new Map<string, { start: number; end: number; value: string }>();
  const tagged = source.replace(new RegExp(placeholderPattern.source, 'g'), (value: string, start: number) => {
    const marker = `<${prefix}_${occurrences.size}>`;
    occurrences.set(marker, { start, end: start + value.length, value });
    return marker;
  });
  const prose: Array<{ start: number; end: number; value: string }> = [];
  walkTokens(Lexer.lex(tagged, { gfm: true }), token => {
    if (token.type !== 'html') return;
    const occurrence = occurrences.get(token.raw);
    if (!occurrence) throw new ResearchValidationError('invalid_text', field);
    prose.push(occurrence);
  });
  assertResearch(prose.length === expectedCount, 'invalid_text', field);
  // Code and escaped literals never became HTML tokens, so their original bytes stay intact.
  let rendered = source;
  for (const item of prose.sort((a, b) => b.start - a.start)) rendered = rendered.slice(0, item.start)
    + item.value.replaceAll('<', '&lt;').replaceAll('>', '&gt;') + rendered.slice(item.end);
  return rendered;
}

/** Parse Markdown so literal code and arrays are not mistaken for executable links or HTML. */
function inspectedProse(value: unknown, limit: number, field: string): string {
  assertResearch(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, 'invalid_text', field);
  const result = (value as string).trim();
  const tokens = Lexer.lex(result, { gfm: true });
  let placeholderCount = 0;
  assertResearch(Object.keys(tokens.links).length === 0, 'forbidden_markup', field);
  walkTokens(tokens, token => {
    const placeholder = token.type === 'html' && token.raw.match(placeholderPattern)?.[0] === token.raw;
    assertResearch(!['link', 'image', 'def'].includes(token.type) && (token.type !== 'html' || placeholder), 'forbidden_markup', field);
    if (placeholder) placeholderCount++;
    // Only inspect leaf text. Code spans/blocks are literal and cannot introduce active links.
    if (token.type === 'text' && !token.tokens) {
      assertResearch(!/(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\[[^\]]*\]\s*\[[^\]]*\])/i.test(token.text),
        'forbidden_markup', field);
    }
  });
  return placeholderCount ? escapeProsePlaceholders(result, placeholderCount, field) : result;
}

export function researchProse(value: unknown, limit: number, field: string): string {
  inspectedProse(value, limit, field);
  return (value as string).trim();
}

/** Bare underscore placeholders are displayed as text; identical placeholders inside code retain their literal spelling. */
export function renderResearchProse(value: string): string { return inspectedProse(value, value.length, 'report'); }

export function escapeResearchLabel(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\\[\]`]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

/** Recheck the assembled document: independent fragments can interact across Markdown boundaries. */
export function validateRenderedResearch(markdown: string, expectedUrls: string[]): void {
  const links: string[] = [];
  walkTokens(Lexer.lex(markdown, { gfm: true }), token => {
    assertResearch(!['html', 'image', 'def'].includes(token.type), 'rendered_links', 'report');
    if (token.type === 'link') links.push(token.href);
  });
  assertResearch(links.length === expectedUrls.length && links.every((url, index) => url === expectedUrls[index]),
    'rendered_links', 'report');
}
