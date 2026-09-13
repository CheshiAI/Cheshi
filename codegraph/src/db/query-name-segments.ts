import {
  fullTableDelete
} from './query-rows';
import type { QueryState } from './query-state';

// ===========================================================================
// Name-segment vocabulary (prompt-hook graph-derived gate)
// ===========================================================================

/** Wipe the segment vocabulary. A full index calls this at its start; the
 *  node write path repopulates it as files (re-)index, so the end state is
 *  exactly the current names with no orphan rows. */
export function clearNameSegmentVocab(this: QueryState): void {
  this.db.exec(fullTableDelete('name_segment_vocab'));
  this.segmentedNames.clear();
}

/** True when the vocab has no rows — an index built before the table existed.
   *  `sync` uses this to heal such databases (see rebuildNameSegmentVocabFrom). */
export function isNameSegmentVocabEmpty(this: QueryState): boolean {
  const row = this.db.prepare('SELECT 1 FROM name_segment_vocab LIMIT 1').get();
  return row === undefined;
}

/** One page of distinct segmentable node names, for batched vocab rebuilds
   *  (file basenames and import specifiers are excluded from the vocab — see
   *  insertNode). */
export function getDistinctNodeNames(this: QueryState, limit: number, offset: number): string[] {
  const rows = this.db
    .prepare("SELECT DISTINCT name FROM nodes WHERE kind NOT IN ('file', 'import') ORDER BY name LIMIT ? OFFSET ?")
    .all(limit, offset) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Insert segments for a batch of names in one transaction (vocab heal path). */
export function insertNameSegmentsBatch(this: QueryState, names: string[]): void {
  this.db.transaction(() => {
    const rows: unknown[][] = [];
    for (const name of names) this.collectNameSegmentRows(name, rows);
    this.runBatched(
      {
        key: 'insertNameSegments',
        table: 'name_segment_vocab',
        columns: ['segment', 'name'],
        conflict: 'IGNORE',
      },
      rows,
    );
  })();
}

/**
   * Names whose segments cover at least `minWords` distinct PROMPT WORDS —
   * the co-occurrence probe behind the prompt hook's medium tier: the words
   * "state" and "machine" both being segments of `OrderStateMachine` is strong
   * evidence the prompt names that symbol in prose. Ordered by coverage.
   *
   * Takes (segment variant → original word) pairs and folds variants back to
   * their word INSIDE the SQL: a name matching both `service` and `services`
   * counts ONE word, not two. Counting raw variants let plural-variant pairs
   * of a single word tie with genuine two-word matches and — because ORDER
   * BY/LIMIT run here, before any JS-side re-check — crowd a real match past
   * the LIMIT on vocab-heavy repos (#1146).
   */
export function getSegmentCoOccurrence(this: QueryState, variants: Array<{ segment: string; word: string }>, minWords: number, limit: number): Array<{ name: string; matches: number }> {
  if (variants.length === 0) return [];
  const placeholders = variants.map(() => '?').join(', ');
  const whens = variants.map(() => 'WHEN ? THEN ?').join(' ');
  return this.db
    .prepare(
      `SELECT name, COUNT(DISTINCT CASE segment ${whens} END) AS matches
         FROM name_segment_vocab
         WHERE segment IN (${placeholders})
         GROUP BY name
         HAVING matches >= ?
         ORDER BY matches DESC, length(name)
         LIMIT ?`,
    )
    .all(
      ...variants.flatMap((v) => [v.segment, v.word]),
      ...variants.map((v) => v.segment),
      minWords,
      limit,
    ) as Array<{ name: string; matches: number }>;
}

/** How many distinct names each segment appears in — the rarity signal that
   *  separates a discriminative word ("checkout") from a ubiquitous one ("state"). */
export function getSegmentNameCounts(this: QueryState, segments: string[]): Map<string, number> {
  if (segments.length === 0) return new Map();
  const placeholders = segments.map(() => '?').join(', ');
  const rows = this.db
    .prepare(
      `SELECT segment, COUNT(*) AS n FROM name_segment_vocab
         WHERE segment IN (${placeholders}) GROUP BY segment`,
    )
    .all(...segments) as Array<{ segment: string; n: number }>;
  return new Map(rows.map((r) => [r.segment, r.n]));
}

/** Names containing the given segment (rare-single-word tier). */
export function getNamesForSegment(this: QueryState, segment: string, limit: number): string[] {
  const rows = this.db
    .prepare('SELECT name FROM name_segment_vocab WHERE segment = ? ORDER BY length(name) LIMIT ?')
    .all(segment, limit) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
