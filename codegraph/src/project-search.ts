import type { CodeGraphState } from './project-state';
import { SEGMENT_RARITY_CEILING } from './project-state-constants';
import { createYielder } from './resolution/cooperative-yield';
import { segmentLookupVariants, splitIdentifierSegments } from './search/identifier-segments';
import {
  SegmentMatch
} from './types';

/**
   * Graph-derived prompt matching for the front-load hook's MEDIUM tier:
   * which indexed symbols do these prose words name? "state machine des
   * commandes" → `OrderStateMachine`, in any human language whose technical
   * nouns are Latin script — no keyword list involved.
   *
   * Precision comes from the repo's own naming statistics, not vocabulary:
   * - CO-OCCURRENCE: ≥2 words that are segments of the SAME name ("state" +
   *   "machine" → OrderStateMachine) is strong evidence and always qualifies.
   * - RARITY: a single matched word qualifies only when its segment is
   *   discriminative here (≤ {@link SEGMENT_RARITY_CEILING} distinct names) —
   *   "checkout" in a shop backend yes, "state" in a react app no.
   * Every candidate is re-verified against `nodes` before being returned
   * (vocab rows are proposals; deletions leave orphans by design), so a
   * returned symbol is guaranteed to exist right now.
   */
export function getSegmentMatches(this: CodeGraphState, words: string[], limit: number = 6): SegmentMatch[] {
  if (words.length === 0) return [];
  // Variant → original word (plural folding), for coverage accounting.
  const variantToWord = new Map<string, string>();
  for (const word of words) {
    for (const variant of segmentLookupVariants(word)) {
      if (!variantToWord.has(variant)) variantToWord.set(variant, word);
    }
  }
  const variants = [...variantToWord.keys()];

  // Tier A: co-occurrence. The SQL folds variants back to their original
  // word (#1146), so minWords=2 means two distinct PROMPT WORDS — a name
  // matching both `service` and `services` can't tie with (or crowd past
  // the LIMIT) a genuine two-word match. The JS re-check below recomputes
  // the fold from live segments as the honesty layer.
  const variantPairs = [...variantToWord.entries()].map(([segment, word]) => ({ segment, word }));
  const candidates: Array<{ name: string; matchedWords: Set<string> }> = [];
  for (const hit of this.queries.getSegmentCoOccurrence(variantPairs, 2, 24)) {
    const matched = this.wordsMatchingName(hit.name, variantToWord);
    if (matched.size >= 2) candidates.push({ name: hit.name, matchedWords: matched });
  }

  // Tier B: single rare word. Only when co-occurrence found nothing — a
  // co-occurring name is categorically stronger evidence — and under
  // stricter rules, because one word is thin: the word must be ≥5 chars
  // (measured FPs: "this", "typo"); the segment must appear in AT LEAST TWO
  // names (a concept the codebase is about clusters across names —
  // CheckoutService/CheckoutController — while a prose coincidence is a
  // singleton: measured FP "deploy to PRODUCTION" → the one name
  // matchesNonProductionDir); and the candidate name must have ≥2 segments
  // (a bare common verb matching a bare function name — "write" → `write` —
  // is prose coincidence, not the user naming a symbol).
  if (candidates.length === 0) {
    const singleWordVariants = variants.filter((v) => variantToWord.get(v)!.length >= 5);
    const counts = this.queries.getSegmentNameCounts(singleWordVariants);
    const rare = [...counts.entries()]
      .filter(([, n]) => n >= 2 && n <= SEGMENT_RARITY_CEILING)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 2);
    for (const [variant] of rare) {
      const word = variantToWord.get(variant)!;
      for (const name of this.queries.getNamesForSegment(variant, 12)) {
        if (splitIdentifierSegments(name).length < 2) continue;
        candidates.push({ name, matchedWords: new Set([word]) });
      }
    }
  }

  // Verify against nodes (the honesty gate) and pick a representative
  // definition per name. A name whose only nodes are file/import kind has
  // no real definition to point at — surfacing the import statement instead
  // reads as a matched symbol but isn't one (#1144) — so it's skipped, the
  // same way an orphaned vocab row is. (Import names no longer enter the
  // vocab at write time, but rows written before that exclusion persist
  // until the next full index.)
  const out: SegmentMatch[] = [];
  const seen = new Set<string>();
  candidates.sort((a, b) => b.matchedWords.size - a.matchedWords.size || a.name.length - b.name.length);
  for (const candidate of candidates) {
    if (out.length >= limit) break;
    if (seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    const nodes = this.queries.getNodesByName(candidate.name);
    if (nodes.length === 0) continue; // orphaned vocab row — name no longer exists
    const rep = nodes.find((n) => n.kind !== 'file' && n.kind !== 'import');
    if (!rep) continue; // no real definition — don't surface an import/file as one
    out.push({
      name: candidate.name,
      kind: rep.kind,
      filePath: rep.filePath,
      startLine: rep.startLine ?? 0,
      matchedWords: [...candidate.matchedWords].sort(),
    });
  }
  return out;
}

/** Which of the prompt's original words match `name`'s segments (via
   *  variants). Segments are recomputed in JS — a name-keyed vocab lookup
   *  would scan the (segment, name) primary key. */
export function wordsMatchingName(this: CodeGraphState, name: string, variantToWord: Map<string, string>): Set<string> {
  const segments = new Set(splitIdentifierSegments(name));
  const matched = new Set<string>();
  for (const [variant, word] of variantToWord) {
    if (segments.has(variant)) matched.add(word);
  }
  return matched;
}

/**
   * One-shot upgrade heal for callers that open the graph WITHOUT syncing —
   * concretely the prompt hook, whose MEDIUM tier reads the segment
   * vocabulary: a database migrated from before the vocab table existed
   * starts with it empty, and the only other backfill lives inside `sync()`,
   * which such callers never run (#1142). Returns true when the vocab is
   * usable (already populated — the overwhelmingly common one-SELECT case —
   * or healed here); false when it isn't (empty graph, or another process
   * holds the index lock — that process's own sync heals it).
   */
export async function healSegmentVocabIfEmpty(this: CodeGraphState): Promise<boolean> {
  this.assertWritable('heal the segment vocabulary');
  const empty = (() => {
    try { return this.queries.isNameSegmentVocabEmpty(); } catch { return false; }
  })();
  if (!empty) return true;
  if (this.queries.getNodeAndEdgeCount().nodes === 0) return false;
  return this.indexMutex.withLock(async () => {
    try {
      this.fileLock.acquire();
    } catch {
      return false; // an index/sync is running — it backfills the vocab itself
    }
    try {
      if (!this.queries.isNameSegmentVocabEmpty()) return true; // raced: healed meanwhile
      await this.rebuildNameSegmentVocab();
      return true;
    } finally {
      this.fileLock.release();
    }
  });
}

/**
   * Rebuild the segment vocabulary from the current graph, batched and
   * yielding — the upgrade-heal path for indexes built before the vocab table
   * existed. Runs inside the index mutex/lock (sync and
   * healSegmentVocabIfEmpty hold them).
   */
export async function rebuildNameSegmentVocab(this: CodeGraphState): Promise<void> {
  const maybeYield = createYielder();
  const BATCH = 2000;
  for (let offset = 0; ; offset += BATCH) {
    const names = this.queries.getDistinctNodeNames(BATCH, offset);
    if (names.length === 0) break;
    this.queries.insertNameSegmentsBatch(names);
    await maybeYield();
  }
}
