import { normalizeSearchText as normalizeText } from './chat-search-grams.mts';

export function searchSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const normalized = normalizeText(flat);
  const match = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, (match.length ? Math.min(...match) : 0) - 60);
  return `${start ? '…' : ''}${flat.slice(start, start + 260)}${flat.length > start + 260 ? '…' : ''}`;
}

export function searchLineage(threadId: string, parents: Map<string, string | null>): string {
  const seen = new Set<string>();
  let current = threadId;
  while (parents.get(current) && !seen.has(current)) {
    seen.add(current);
    current = parents.get(current)!;
  }
  // Malformed cycles must not collapse independent conversations.
  return seen.has(current) ? threadId : current;
}
