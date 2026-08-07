/**
 * Per-source board exclusion, applied inside the adapters.
 *
 * Archives carry boards that are not 4chan boards. Three kinds turn up:
 *
 * - the archive's **own** discussion board (Desuarchive's `meta`), whose posts
 *   are real but were made on the archive site, not on 4chan;
 * - **other imageboards** swept up by a broad crawl (`may.not4chan.org`,
 *   `orly.yi.org` in the ten-billion archive);
 * - **parse artifacts** that were never boards at all -- collection titles
 *   read into the board column (`bay of pigs`, `law and order hack`), or bare
 *   numbers (`7898`).
 *
 * WHY THIS IS NOT A GLOBAL WHITELIST. The obvious design -- one canonical
 * board list per site, checked centrally -- catches only the third kind. It
 * asks "is this board valid for site X", but the defect in the first kind is
 * the *site attribution itself*: an archive's own board named `meta` or `qa`
 * is a perfectly valid 4chan board name, so a whitelist keyed on the name
 * passes it through unchanged. The check has to happen where the adapter
 * knows how it derived the board -- from a table name, a thread URL, or
 * markup -- because only there is it known whether the site label can be
 * trusted. That is source-specific knowledge, so it lives with the adapter.
 *
 * NOTHING IS DROPPED SILENTLY. Every adapter folds `summary()` into its final
 * line. A filter that quietly discards rows is the exact failure mode this
 * codebase keeps getting bitten by -- an ingest that exits 0 having stored
 * less than it should looks identical to one with nothing left to store.
 */
export interface BoardFilter {
  /**
   * True when `board` is excluded and the caller should skip it. Tallies the
   * rejection, so this must be called once per skipped unit (table, thread or
   * page), not once per post -- see `count` on what the number means.
   */
  reject(board: string): boolean;
  /** e.g. ", excluded boards: meta, con" -- empty when nothing was excluded. */
  summary(): string;
  /** How many units were rejected, keyed by board. */
  readonly counts: ReadonlyMap<string, number>;
}

const NONE: BoardFilter = {
  reject: () => false,
  summary: () => '',
  counts: new Map(),
};

/**
 * Builds a filter from a manifest's `ingest.exclude-boards`. Matching is on
 * the bare board name, case-insensitively; an `_deleted` suffix is the
 * caller's to strip (the SQL adapters already do, to get a board from a
 * table).
 *
 * With no list this returns a shared no-op whose `reject` is a constant
 * false, so sources that exclude nothing -- almost all of them -- pay nothing
 * per row.
 */
export const makeBoardFilter = (exclude?: readonly string[]): BoardFilter => {
  if (!exclude || exclude.length === 0) return NONE;
  const set = new Set(exclude.map((b) => b.toLowerCase()));
  const counts = new Map<string, number>();
  return {
    reject(board: string): boolean {
      const key = board.toLowerCase();
      if (!set.has(key)) return false;
      // Keyed on the normalized name, not the raw one: a dump that writes the
      // same board both ways would otherwise report it as two separate
      // exclusions, understating each.
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return true;
    },
    summary(): string {
      if (counts.size === 0) return '';
      const parts = [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([b, n]) => `${b} (${n})`);
      return `, excluded boards: ${parts.join(', ')}`;
    },
    counts,
  };
};
