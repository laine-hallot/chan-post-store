import { readFileSync } from 'node:fs';

/**
 * Reader for `4chan-board-lifespans.json`, the committed timeline of board
 * creations and deletions.
 *
 * The file is a repo-level asset rather than any one source's business -- it
 * describes 4chan, not an archive of it. `site-config-4chan` is what the
 * staging packages read it through today, and all they take from it is the
 * slug set (`boardSlugs()`); the events carry dates and citations, and a
 * consumer that wants era-awareness (which incarnation of /r9k/ a 2011 post
 * belongs to, say) should read them rather than re-parsing the file
 * elsewhere.
 *
 * TWO BUCKETS, AND ONLY ONE IS EVIDENCE:
 *
 * - `cited` -- event and date come from the Bibliotheca Anonoma wiki or
 *   better, each entry graded A/B/C and pointing at entries in `citations`.
 * - `citation_needed` -- from general knowledge only, with no date. The file's
 *   own `meta.confidence` says not to use these until they are promoted with a
 *   real source, and that instruction is honoured here.
 *
 * Excluding `citation_needed` errs in the safe direction for every current
 * consumer: a slug missing from the set is one nothing is claimed about, and
 * the reconcile step treats an unrecognised board tag as ambiguity to report
 * rather than a verdict to act on. Erring the other way -- treating a
 * hearsay board as established -- is what would move pages on bad evidence.
 *
 * As of the 2026-08-12 timeline the exclusion costs nothing: its one entry is
 * `/fk/`, whose *deletion* is cited even though its creation is not, so the
 * slug arrives through `cited` anyway. Don't read a behaviour difference into
 * the bucket split that isn't there yet -- it is a policy for when the file
 * grows, not a filter doing work today.
 */

/** `/b/` in the file; `b` as a board column value. */
const stripSlashes = (slug: string): string => slug.replace(/\//g, '');

/**
 * Slugs that could occur as a board directory or a `board` column value.
 *
 * The timeline records two events under `oekaki.4chan.net`, a hostname rather
 * than a slug -- 4chan's oekaki lived on its own subdomain before boards were
 * paths. It is a real thing that happened and belongs in the timeline; it is
 * not a value any consumer will match against, so it is dropped here rather
 * than left to produce a set member nothing can ever equal.
 */
const SLUG = /^[a-z0-9]+$/;

/**
 * Every board slug the timeline attests to, across all incarnations.
 *
 * Deliberately flattens the timeline: a slug reused by two different boards
 * (`/r9k/` 2008 and 2011, `/n/` News and New) appears once, because the
 * question this answers is "was this ever a board", not "which one". Telling
 * the incarnations apart needs the dates, and callers that need that should
 * read the events rather than this set.
 *
 * Throws rather than returning empty. An empty set is not a neutral result:
 * it says every board is unrecognised, and a consumer acting on that would
 * treat the whole of 4chan as foreign.
 */
export const readBoardSlugs = (path: string): Set<string> => {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(
      `${path}: cannot read board timeline\n  ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const cited = (doc as { cited?: unknown })?.cited;
  const slugs = new Set<string>();
  if (Array.isArray(cited)) {
    for (const e of cited) {
      const slug = (e as { slug?: unknown })?.slug;
      if (typeof slug === 'string') {
        const bare = stripSlashes(slug);
        if (SLUG.test(bare)) {
          slugs.add(bare);
        }
      }
    }
  }

  if (slugs.size === 0) {
    throw new Error(
      `${path}: no cited board slugs found\n` +
        `  expected {"cited":[{"type":"created","slug":"/b/","date":...},...]}`
    );
  }
  return slugs;
};
