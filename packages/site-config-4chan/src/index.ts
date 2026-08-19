import timeline from '../4chan-board-lifespans.json' with { type: 'json' };

/**
 * 4chan's board timeline, and the slugs derived from it.
 *
 * Published as a package so a prepare script can depend on it and bundle it,
 * rather than reaching into the repo -- a prepare script runs on the machine
 * holding the archives, where this checkout does not exist.
 */

export { timeline };

/** Slashes are how the timeline writes a board; the set stores bare slugs. */
const stripSlashes = (slug: string): string => slug.replace(/\//g, '');

/**
 * Guards against a URL-shape parse that has started yielding junk. Anchored
 * and ASCII-only, so a slug is a slug and not a fragment of markup.
 */
const SLUG = /^[a-z0-9]+$/;

/**
 * Every board slug the timeline cites, at any point in its history.
 *
 * The question this answers is "was this ever a board", not "which one":
 * boards are created, deleted and recreated, and telling the incarnations
 * apart needs the dates. A caller that needs that should read the events.
 *
 * Throws rather than returning empty. An empty set is not a neutral result --
 * it says every board is unrecognised, and a consumer acting on that would
 * treat the whole of 4chan as foreign.
 */
export const boardSlugs = (): Set<string> => {
  const { cited } = timeline as { cited?: unknown };
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
      'no cited board slugs in the timeline\n' +
        '  expected {"cited":[{"type":"created","slug":"/b/","date":...},...]}'
    );
  }
  return slugs;
};
