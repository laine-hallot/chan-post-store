import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';

import { isDir, listHtmlPages } from './html-tree.ts';

/**
 * The staging step for `sources/archives-yotsubasociety-org.json`: reconciles
 * that mirror's `<board>/<threadno>.html` tree against what each page says it
 * is, before ingest reads it.
 *
 * ONE MODULE PER SOURCE, like `adapters/` -- and for the same reason. What
 * looks like a general "check the directory against the page" utility is built
 * entirely out of this archive's particulars: which markup generations it
 * spans, which directories are hand-named collections rather than boards, how
 * the same thread came to be filed twice. Another mirror laid out the same way
 * will have different ones, and a shared implementation would either
 * accumulate every archive's exceptions or quietly apply this archive's to a
 * tree that does not have them.
 *
 * A nested mirror gives the reader exactly one signal for the board -- the
 * directory name -- and `html-to-ndjson` takes it on trust. On the Yotsuba
 * Society mirror that trust is misplaced: it was assembled by hand, and 530 of
 * its 23,295 pages sit in a directory the page itself contradicts. A /tv/
 * thread filed under `r9k/` ingests as a /r9k/ post, and a thread filed under
 * *two* board directories ingests twice -- once per label, which the
 * `UNIQUE (site, board, post_no)` constraint cannot catch because `board` is
 * part of the key. That is the one duplication the store is supposed to be
 * incapable of, so it is fixed here rather than documented as an exception.
 *
 * This runs in `prepare`, between `extracted/` and `out/`, which is why those
 * are separate directories: `extracted/` stays a faithful copy of the upstream
 * tarball and `out/` is what ingest is allowed to believe. Nothing here can
 * lose a page: misfiled ones are moved, and the only deletion is of a copy
 * whose identical bytes are proven to remain elsewhere in the tree. `out/` is
 * rebuilt from `extracted/` by the preceding step regardless, so a mistake
 * costs a re-run rather than data.
 *
 * THE BOARD COMES FROM THE PAGE'S LINKS, NOT ITS `<title>`. This is the whole
 * design, and it was learned the expensive way -- an earlier version of this
 * step trusted the title and was wrong in both directions:
 *
 * - **A title is a display name, and 4chan renames boards as a joke.** For the
 *   2010 World Cup /sp/ was relabelled `/wc/`, its name tracking the
 *   tournament (`English Goalkeeping`, `Malian Refereeing`, `DEUTSCHLAND`);
 *   /r9k/ has appeared as `/g9k/` and /a/ as `/ɐ/` on April Fools; and /vp/
 *   spent a spell as `/tr/ - Team Rocket`. None of those is a board. The
 *   pages are filed correctly and must not move.
 * - **A title can carry a thread abbreviation** -- `/dpt/`, `/bmg/` and the
 *   like are general-thread names, not boards, and a hand-archiver naming
 *   files after them propagates the confusion into the tree.
 * - **Titles are missing far more often than links are.** 8.1% of this mirror
 *   has no usable title tag; only 0.6% has no usable link evidence.
 *
 * A `<form action="//sys.4chan.org/sp/post">` is the page stating where it
 * posts to, which a costume name cannot alter and a thread subject cannot
 * fake. Measured over the whole mirror: link evidence exists for 99.4% of
 * pages, and where a title also exists the two agree 99.5% of the time -- the
 * 101 exceptions being precisely the costumes above. In the 530 genuine
 * misfilings the title agreed with the links 501 times and with the directory
 * ZERO times, so nothing is lost by demoting it.
 *
 * The title is still read, but only to be REPORTED when it disagrees. That is
 * how a costume nobody has catalogued yet makes itself visible.
 */

/**
 * The page's own post target: `<form action="//sys.4chan.org/sp/post">`.
 *
 * The strongest evidence a page carries, and present on 99.2% of this mirror.
 * A form action cannot be affected by a board's display name, cannot be
 * quoted from another board the way a link in a post body can, and survives
 * every markup generation here -- the host has been `sys`, `bin`, `tmp`,
 * `dat`, `nov` and `test` over the years, so the host is deliberately not
 * pinned.
 */
const FORM_BOARD =
  /<form[^>]*action="[^"]*?(?:[a-z0-9-]+\.)?4chan(?:nel)?\.org\/([a-z0-9]+)\/(?:post|imgboard)/gi;

/**
 * Board-scoped URLs anywhere in the page: thread links, image sources, board
 * scripts. The fallback for the 0.2% of pages carrying no form.
 *
 * THE TRAILING PATH SEGMENT IS REQUIRED, and is the entire reason this is
 * usable. A bare `boards.4chan.org/<b>/` is the navigation bar, which lists
 * every board on the site -- 37,733 such links in a 489-page sample, evidence
 * about nothing. Requiring `res`/`src`/`imgboard`/`index` keeps only URLs that
 * address a board's content, and incidentally excludes the non-board paths
 * that would otherwise parse as slugs (`static.4chan.org/image/...`,
 * `content.4chan.org/tmp/...`).
 */
const SELF_BOARD =
  /(?:[a-z0-9-]+\.)?4chan(?:nel)?\.org\/([a-z0-9]+)\/(?:res|src|imgboard|index|thread)/gi;

/** Anchored, ASCII-only, separator required. Reported, never acted on. */
const TITLE_BOARD = /^\/([a-z0-9]+)\/ - /;

const TITLE_TAG = /<title>([\s\S]*?)<\/title>/i;

/**
 * Collapses the whitespace inside a title before the board tag is read.
 *
 * ONE MARKUP GENERATION PRETTY-PRINTS THE TITLE ACROSS LINES:
 *
 *     <title>/ck/
 *      - Food &amp; Cooking</title>
 *
 * so the separator the pattern above anchors on is `\n - `, not ` - `. That is
 * 3,376 of this mirror's 23,295 pages -- every page a line-wise scan reported
 * as having no title at all. It no longer decides anything, but an
 * unnormalised title would make the costume report wrong in the same way.
 */
const normalizeTitle = (title: string): string =>
  title.replace(/\s+/g, ' ').trim();

export type Disposition =
  | 'matched'
  | 'relocated'
  | 'relocated-snapshot'
  | 'duplicate-removed'
  | 'undetermined';

export interface ReconcileStats {
  scanned: number;
  matched: number;
  relocated: number;
  relocatedSnapshot: number;
  /** Byte-identical copies removed. See the note at that branch. */
  duplicateRemoved: number;
  /**
   * The links resolved to a board the timeline does not know. Left in place
   * and reported. Zero on this mirror, and that is the point: it asserts the
   * URL parsing is not inventing slugs, which is the failure a tree-shaped
   * heuristic would otherwise hide.
   */
  unknownBoard: number;
  /** Counts per unrecognised slug, so the report can name them. */
  unknownTags: Map<string, number>;
  /** No usable link evidence. Left in place. */
  undetermined: number;
  /**
   * Pages whose `<title>` names a different board than their links do, keyed
   * `"/title/ -> /links/"`. Never acted on -- this is the costume report, and
   * an entry appearing here that is NOT a known joke rename is the signal
   * that something new needs looking at.
   */
  costumes: Map<string, number>;
}

export interface ReconcileOptions {
  /** Tree root holding the board directories, e.g. `<dir>/out/4chan`. */
  root: string;
  /**
   * Slugs that are real boards of this site, from `board-timeline.ts`.
   *
   * A GUARD, NOT THE AUTHORITY. The board is decided by the page's links; this
   * only refuses to act when those links resolve to something the timeline has
   * never heard of, which on this mirror is nothing at all -- all 58 boards the
   * links produce are attested. It exists so that a URL-shape parse that starts
   * yielding junk reports rather than creates directories named after junk.
   *
   * It therefore does not need to be complete, and a slug missing from it costs
   * a line of output rather than a moved page. Note that the joke names this
   * mirror carries -- `/wc/`, `/g9k/`, `/tr/`, `/ɐ/` -- are NOT examples of
   * incompleteness and must never be added: they are display names over a real
   * board, and the links already resolve those pages correctly.
   */
  knownBoards: ReadonlySet<string>;
  /** Called per planned page, for logging. */
  onAction?: (what: Disposition, from: string, to: string) => void;
}

/** The mode of a capture group over a whole file, or null if it never matched. */
const modeOf = (text: string, re: RegExp): string | null => {
  const counts = new Map<string, number>();
  // `re` is a module constant with /g, so lastIndex must not carry over.
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const b = m[1].toLowerCase();
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [slug, k] of counts) {
    if (k > n) {
      best = slug;
      n = k;
    }
  }
  return best;
};

interface PageEvidence {
  /** Board the page's own links resolve to, or null if it carries none. */
  board: string | null;
  /** Board its `<title>` claims, for the costume report only. */
  titleBoard: string | null;
}

/**
 * What a page says it is.
 *
 * READ WHOLE AND AS LATIN-1. Whole because the evidence is not in `<head>` --
 * the post form sits below the thread in several of this mirror's markup
 * generations, so a prefix read misses it. Latin-1 because a byte-preserving
 * decode cannot throw on the mis-encoded pages this hand-made mirror contains,
 * and every pattern here is ASCII, so nothing is lost by not decoding UTF-8.
 *
 * The mode rather than the first match: a post body can quote another board's
 * thread or hotlink its images, and on two pages of this mirror those
 * cross-board links outnumber nothing but each other. The form action wins
 * outright where present for the same reason -- it is the only URL on the page
 * that is about the page.
 */
const readEvidence = (path: Buffer): PageEvidence => {
  let text: string;
  try {
    text = readFileSync(path, 'latin1');
  } catch {
    return { board: null, titleBoard: null };
  }
  const tm = TITLE_TAG.exec(text);
  const title = tm ? normalizeTitle(tm[1]) : null;
  const tb = title === null ? null : TITLE_BOARD.exec(title);
  return {
    board: modeOf(text, FORM_BOARD) ?? modeOf(text, SELF_BOARD),
    titleBoard: tb ? tb[1] : null,
  };
};

const sha1 = (path: Buffer | string): string | null => {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
};

const bytes = (s: string): Buffer => Buffer.from(s);

const joinB = (dir: string, name: Buffer): Buffer =>
  Buffer.concat([bytes(dir.endsWith('/') ? dir : `${dir}/`), name]);

/** Splits `4026079.html` into `4026079` and `.html`; `x.htm` into `x`, `.htm`. */
const splitExt = (name: string): [string, string] => {
  const m = /^(.*?)(\.html?)$/i.exec(name);
  return m ? [m[1], m[2]] : [name, ''];
};

/**
 * One filesystem change, with paths relative to the reconcile root.
 *
 * THE STEP PLANS BUT DOES NOT ACT, which is forced by where the archives live.
 * The NFS export is read-only -- deliberately, since CLAUDE.md's `soft` mount
 * makes "give up and error" the response to a stuck request, and that is only
 * safe for a workload that never writes. So this module reads over the mount,
 * which it may, and hands the caller a list of changes to apply through the
 * runner over SSH, which is the only writable path to the array. An earlier
 * version called `renameSync` here and died on the first page with EROFS.
 *
 * Planning separately buys two things beyond working at all: `--dry-run`
 * becomes exactly the real run minus the last step rather than a
 * reimplementation of it, and the whole change set crosses the network as one
 * script instead of 1,000 SSH round-trips.
 */
export interface ReconcileOp {
  kind: 'move' | 'remove';
  /** Source, relative to `root`. Bytes, not a string -- see the note on `run`. */
  from: Buffer;
  /** Destination, relative to `root`. Absent for `remove`. */
  to?: Buffer;
  /** Failure is tolerable: true for asset directories, never for pages. */
  optional?: boolean;
}

export interface ReconcilePlan {
  stats: ReconcileStats;
  ops: ReconcileOp[];
}

/**
 * A free name for `name` in `destDir`, or null if a hundred are taken.
 *
 * The suffix goes *after* the stem and before the extension so the leading
 * digits survive: `html-to-ndjson`'s `nestedThreadNo` reads the thread number
 * with `^(\d+)` off
 * the filename, so `4026079.snap1.html` still parses as thread 4026079, while
 * `snap1.4026079.html` would parse as nothing.
 */
const freeName = (
  name: string,
  taken: (candidate: string) => boolean
): string | null => {
  const [stem, ext] = splitExt(name);
  for (let i = 1; i < 100; i++) {
    const candidate = `${stem}.snap${i}${ext}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * Walks the tree and puts every unambiguously misfiled page where it belongs.
 *
 * Idempotent, which `prepare` requires: after a pass no page's links disagree
 * with its directory, so a second run finds nothing to do.
 */
export const reconcileYotsubasocietyBoards = (
  opts: ReconcileOptions
): ReconcilePlan => {
  const { root, knownBoards } = opts;
  const unknownTags = new Map<string, number>();
  const costumes = new Map<string, number>();
  const act = opts.onAction ?? ((): void => {});
  const ops: ReconcileOp[] = [];
  const stats: ReconcileStats = {
    scanned: 0,
    matched: 0,
    relocated: 0,
    relocatedSnapshot: 0,
    duplicateRemoved: 0,
    unknownBoard: 0,
    unknownTags,
    undetermined: 0,
    costumes,
  };

  // THE PLAN MUST SEE ITSELF. Deciding what to do with a page means asking
  // whether its destination is occupied, and once nothing is applied during
  // the walk, the disk no longer answers that question: two pages heading for
  // the same name would both be planned as plain moves and the second `mv`
  // would overwrite the first. These two track the tree as the plan will
  // leave it -- `filled` maps a destination to the file that will occupy it
  // (still readable at its current path, which is what the duplicate check
  // hashes), and `emptied` remembers paths a planned move has vacated.
  const filled = new Map<string, Buffer>();
  const emptied = new Set<string>();
  const key = (rel: Buffer): string => rel.toString('latin1');

  /** The file that will occupy `rel` once the plan runs, or null if free. */
  const occupant = (rel: Buffer): Buffer | null => {
    const k = key(rel);
    const planned = filled.get(k);
    if (planned !== undefined) {
      return planned;
    }
    if (emptied.has(k)) {
      return null;
    }
    const abs = joinB(root, rel);
    return existsSync(abs) ? abs : null;
  };

  for (const page of listHtmlPages(root)) {
    // Root-level pages (the mirror's 53 board index pages) have no directory
    // to disagree with, so there is nothing to reconcile.
    if (page.board === null) {
      continue;
    }
    stats.scanned++;

    const { board: declared, titleBoard } = readEvidence(page.path);

    // Recorded, never acted on. A disagreement here means the board was
    // wearing a display name when the page was saved -- /sp/ as `/wc/` for the
    // 2010 World Cup, /vp/ as `/tr/ - Team Rocket`, /r9k/ as `/g9k/`, /a/ as
    // `/ɐ/` -- or that a hand-archiver named the file after a general-thread
    // abbreviation like /dpt/ or /bmg/. In every such case the LINKS are
    // right and the title is decoration, so the page stays where the links
    // put it. An unfamiliar pair showing up in this report is the cue to go
    // and look, which is exactly how `/wc/` was caught being not-a-board.
    if (declared !== null && titleBoard !== null && titleBoard !== declared) {
      const k = `/${titleBoard}/ -> /${declared}/`;
      costumes.set(k, (costumes.get(k) ?? 0) + 1);
    }

    const srcDir = `${root}/${page.board}`;
    const from = `${page.board}/${page.name}`;

    // The page could not prove which board it belongs to, so it stays put:
    // unreadable is not the same as wrong. Pages left sitting in a directory
    // that is not a board -- this mirror's hand-named `bay of pigs` and
    // `law and order hack` collections -- are `ingest.exclude-boards`'
    // business, not this step's. Moving files is what prepare is for;
    // deciding which board labels are legitimate is what ingest is for.
    if (declared === null) {
      stats.undetermined++;
      continue;
    }
    if (declared === page.board) {
      stats.matched++;
      continue;
    }

    // A LAST GUARD, not the decision. The links resolved to something, but if
    // the timeline has never heard of it the likelier explanation is that the
    // URL patterns above have started matching something that is not a board
    // path than that a new board exists. Report rather than create a
    // directory named after a parse artifact. Zero pages hit this on the
    // current mirror -- all 58 boards the links produce are attested.
    if (!knownBoards.has(declared)) {
      stats.unknownBoard++;
      unknownTags.set(declared, (unknownTags.get(declared) ?? 0) + 1);
      continue;
    }

    const raw = page.path.subarray(bytes(srcDir).length + 1);
    const srcRel = joinB(page.board, raw);

    /**
     * Emits the move, plus the `<stem>_files/` asset directory the mirror puts
     * beside each page, keeping the two named consistently.
     *
     * The assets are never ingested -- `html-tree.ts` skips `_files` when
     * walking -- but leaving them behind orphans them in a directory the page
     * has left, and the mirror stays browsable if they travel together. Their
     * move is `optional`: an asset directory that will not move must not abort
     * the run, because the page is what ingest reads.
     */
    const planMove = (destName: string): void => {
      const destRel = joinB(declared, bytes(destName));
      ops.push({ kind: 'move', from: srcRel, to: destRel });
      filled.set(key(destRel), page.path);
      emptied.add(key(srcRel));

      const [srcStem] = splitExt(page.name);
      const [destStem] = splitExt(destName);
      if (isDir(`${srcDir}/${srcStem}_files`)) {
        const destAssets = `${declared}/${destStem}_files`;
        if (!isDir(`${root}/${destAssets}`)) {
          ops.push({
            kind: 'move',
            from: bytes(`${page.board}/${srcStem}_files`),
            to: bytes(destAssets),
            optional: true,
          });
        }
      }
    };

    const destRel = joinB(declared, raw);
    const taken = occupant(destRel);

    if (taken === null) {
      planMove(page.name);
      stats.relocated++;
      act('relocated', from, `${declared}/${page.name}`);
      continue;
    }

    // The destination is taken. Same board and same thread number cannot be
    // two different threads, so this is the same thread twice -- verified on
    // this mirror: all 96 such pairs carry an identical <title>.
    if (sha1(taken) === sha1(page.path)) {
      // Byte-identical, so removable without loss: the same bytes remain at
      // the destination, and `out/` is hardlinked from `extracted/`, which
      // keeps the upstream tree whole regardless. Deleted rather than moved
      // aside -- a quarantine directory of provably redundant copies is a
      // list of filenames wearing a filesystem, and the log is the list.
      ops.push({ kind: 'remove', from: srcRel });
      emptied.add(key(srcRel));
      stats.duplicateRemoved++;
      act('duplicate-removed', from, `${declared}/${page.name}`);
      continue;
    }

    // Two captures of one thread at different moments. Both are kept: the
    // later one holds replies the earlier lacks, ingest dedupes at post
    // level, and discarding either would lose posts rather than duplicates.
    const destName = freeName(
      page.name,
      (candidate) => occupant(joinB(declared, bytes(candidate))) !== null
    );
    if (destName === null) {
      stats.undetermined++;
      continue;
    }
    planMove(destName);
    stats.relocatedSnapshot++;
    act('relocated-snapshot', from, `${declared}/${destName}`);
  }

  return { stats, ops };
};

/**
 * Plans the reconciliation and applies it, in one call.
 *
 * The planning half is unchanged; what used to happen after it is not. This
 * ran as a CLI builtin that read the tree through the NFS mount and then sent
 * the moves back over SSH as a generated shell script. Reading 23,295 files
 * over that mount is what took it down -- `readdir` began returning empty
 * while `stat` still worked, so the tree looked deleted rather than broken.
 *
 * As part of a prepare script the whole thing runs on the archive host, so
 * both halves are ordinary local filesystem calls and no script generation is
 * needed. Paths stay Buffers throughout: one filename in this mirror is not
 * valid UTF-8, and decoding it to build a destination would name a file that
 * does not exist.
 */
export const reconcileBoards = (opts: ReconcileOptions): ReconcileStats => {
  const { stats, ops } = reconcileYotsubasocietyBoards(opts);
  const root = Buffer.from(opts.root);
  const at = (rel: Buffer): Buffer =>
    Buffer.concat([root, Buffer.from('/'), rel]);

  for (const op of ops) {
    const from = at(op.from);
    if (op.kind === 'remove') {
      rmSync(from, { force: true });
      continue;
    }
    const to = at(op.to!);
    const slash = to.lastIndexOf(0x2f);
    if (slash > 0) {
      mkdirSync(to.subarray(0, slash), { recursive: true });
    }
    try {
      renameSync(from, to);
    } catch (e) {
      // Asset directories may legitimately already be gone; a page may not.
      if (!op.optional) {
        throw e;
      }
    }
  }
  return stats;
};
