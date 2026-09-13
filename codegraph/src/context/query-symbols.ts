/**
 * Extract likely symbol names from a natural language query
 *
 * Identifies potential code symbols using patterns:
 * - CamelCase: UserService, signInWithGoogle
 * - snake_case: user_service, sign_in
 * - SCREAMING_SNAKE: MAX_RETRIES
 * - dot.notation: app.isPackaged (extracts both sides)
 * - Single words that look like identifiers (no spaces, not common English words)
 *
 * @param query - Natural language query
 * @returns Array of potential symbol names
 */
export function extractSymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();

  // Extract CamelCase identifiers (2+ chars, starts with letter)
  const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)*|[a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = camelCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 2) {
      symbols.add(match[1]);
    }
  }

  // Extract snake_case identifiers
  const snakeCasePattern = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  while ((match = snakeCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      symbols.add(match[1]);
    }
  }

  // Extract SCREAMING_SNAKE_CASE
  const screamingPattern = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
  while ((match = screamingPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Extract ALL_CAPS acronyms (2+ chars, e.g., REST, HTTP, LRU, API)
  const acronymPattern = /\b([A-Z]{2,})\b/g;
  while ((match = acronymPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Extract dot.notation and split into parts (e.g., "app.isPackaged" -> ["app", "isPackaged"])
  const dotPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g;
  while ((match = dotPattern.exec(query)) !== null) {
    if (match[1]) {
      // Add both the full path and individual parts
      symbols.add(match[1]);
      const parts = match[1].split('.');
      for (const part of parts) {
        if (part.length >= 2) {
          symbols.add(part);
        }
      }
    }
  }

  // Extract plain lowercase identifiers (3+ chars, not already matched)
  // Catches symbol names like "undo", "redo", "history", "render", "parse"
  const lowercasePattern = /\b([a-z][a-z0-9]{2,})\b/g;
  while ((match = lowercasePattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Filter out common English words that aren't likely symbol names
  const commonWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been',
    'will', 'would', 'could', 'should', 'does', 'done', 'make', 'made',
    'use', 'used', 'using', 'work', 'works', 'find', 'found', 'show',
    'call', 'called', 'calling', 'get', 'set', 'add', 'all', 'any',
    'how', 'what', 'when', 'where', 'which', 'who', 'why',
    'not', 'but', 'are', 'was', 'were', 'has', 'had', 'its',
    'can', 'did', 'may', 'also', 'into', 'than', 'then', 'them',
    'each', 'other', 'some', 'such', 'only', 'same', 'about',
    'after', 'before', 'between', 'through', 'during', 'without',
    'again', 'further', 'once', 'here', 'there', 'both', 'just',
    'more', 'most', 'very', 'being', 'having', 'doing',
    'system', 'need', 'needs', 'want', 'wants', 'like', 'look',
    'change', 'changes', 'changed', 'changing',
    // Common English nouns/verbs that match thousands of unrelated code symbols
    'layer', 'handle', 'handles', 'handling', 'incoming', 'outgoing',
    'data', 'flow', 'flows', 'level', 'levels', 'request', 'requests',
    'response', 'responses', 'implement', 'implements', 'implementation',
    'interface', 'interfaces', 'class', 'classes', 'method', 'methods',
    'trigger', 'triggers', 'affected', 'affect', 'affects',
    'else', 'code', 'failing', 'failed', 'silently', 'decide', 'decides',
    'return', 'returns', 'returned', 'take', 'takes', 'taken',
    'check', 'checks', 'checked', 'create', 'creates', 'created',
    'read', 'reads', 'write', 'writes', 'written',
    'start', 'starts', 'stop', 'stops', 'run', 'runs', 'running',
  ]);

  return Array.from(symbols).filter(s => !commonWords.has(s.toLowerCase()));
}
