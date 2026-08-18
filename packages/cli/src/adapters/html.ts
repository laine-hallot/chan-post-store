import type { Pool } from 'pg';

import { parse, type HTMLElement } from 'node-html-parser';
import { readFileSync } from 'node:fs';

import { makeBoardFilter } from '../boards.ts';
import { listHtmlPages } from '../html-tree.ts';
import { cleanBodyText } from '../html.ts';
import { collectPending, PostInserter } from '../ingest.ts';
import { makeBar } from '../progress.ts';

/**
 * Ingests saved pages in 4chan's own HTML -- the markup `boards.4chan.org`
 * serves, as captured by perma.cc, Wayback, BASC-Archiver and similar
 * whole-page archivers.
 *
 * Reads the standard staged layout and nothing else:
 *
 *     out/<board>/<threadno>.html    thread number asserted by the filename
 *     out/<board>/<anything>.html    thread number taken from the markup
 *
 * The directory names the board, so this adapter does no identity guessing.
 * It used to, and the guessing was wrong: the rule was "leading digits of the
 * filename", which on 4chan-vp-2015-threads -- staged as
 * `<date>_<threadno>.html`, so that captures of the same thread on
 * consecutive days do not collide -- read the YEAR as the thread number and
 * filed 859,937 posts under thread 2015.
 *
 * A filename must now be digits IN FULL to assert a thread number. Any other
 * name defers to the page, whose every OP supplies its own number. That
 * covers both cases that need it: a board index, which names no single
 * thread, and a multi-capture name like vp's, which names one but not in a
 * form worth trusting over the markup.
 *
 * Rendered third-party archives -- fybertech's own templates, the classic
 * Futaba markup -- are NOT this format. `prepare` parses those into NDJSON,
 * so by the time a tree reaches here it holds native markup only and a page
 * without `.postContainer` is a staging bug rather than a routine skip.
 *
 * What makes this format pleasant: every post carries
 * `<span class="dateTime" data-utc="1639552011">`, a true UTC epoch. There is
 * no timezone guesswork of the kind the Fuuka-family dumps need.
 *
 * Parsed as a DOM rather than with regexes, which is what makes the format's
 * two traps tractable:
 *
 *  - Every post is emitted twice, once as `postInfo desktop` and once as
 *    `postInfoM mobile`, so a document-wide field scan double-counts. Querying
 *    within one post container and preferring the desktop block handles it.
 *  - Field order differs between OPs and replies: an OP puts its `.file` block
 *    before `postInfo`, a reply after. Selectors do not care.
 *
 * A board index also abbreviates long comments and appends its own notice
 * inside the blockquote (`<span class="abbr">Comment too long...`). That is
 * archive chrome, not post text, so the element is removed before the body is
 * read -- the kind of artifact that is a one-line subtree removal here and was
 * a bug when the body was matched as a string.
 */

interface IngestStats {
  files: number;
  /** Distinct threads seen, however each page's number was arrived at. */
  threads: number;
  posts: number;
  skippedDup: number;
  badFiles: number;
}

/** Text of the first match, or null when absent or empty. */
const text = (root: HTMLElement, sel: string): string | null => {
  const el = root.querySelector(sel);
  if (!el) {
    return null;
  }
  const t = el.textContent;
  return t === '' ? null : t;
};

/** Reads one post's fields out of its container. Thread attribution is the
 * caller's job -- on a board index it depends on which OP came before. */
const readPost = (
  container: HTMLElement
): {
  postNo: number;
  isOp: boolean;
  tsUtc: number | null;
  name: string | null;
  tripcode: string | null;
  subject: string | null;
  bodyText: string | null;
  mediaFilename: string | null;
  mediaMd5: string | null;
} | null => {
  // id is pc<postno> on the wrapper.
  const id = container.getAttribute('id') ?? '';
  const postNo = Number(id.replace(/^pc/, ''));
  if (!Number.isInteger(postNo) || postNo <= 0) {
    return null;
  }

  const isOp = container.classList.contains('opContainer');

  // Prefer the desktop block; the mobile one carries the same values, so
  // either will do, but picking deterministically avoids reading half the
  // fields from one and half from the other.
  const info =
    container.querySelector('.postInfo.desktop') ??
    container.querySelector('.postInfoM.mobile') ??
    container;

  const utcAttr =
    info.querySelector('[data-utc]')?.getAttribute('data-utc') ??
    container.querySelector('[data-utc]')?.getAttribute('data-utc');
  const utc = utcAttr != null && /^\d+$/.test(utcAttr) ? Number(utcAttr) : null;

  // The poster's original filename is the anchor's title when it was truncated
  // for display, and the link text otherwise.
  const fileLink = container.querySelector('.fileText a');
  const mediaFilename =
    fileLink?.getAttribute('title') ??
    (fileLink?.textContent === '' ? null : (fileLink?.textContent ?? null));

  const body = container.querySelector('blockquote.postMessage');
  let bodyText: string | null = null;
  if (body) {
    // Drop the truncation notice before reading the text, so it is not stored
    // as though the poster had written it.
    for (const abbr of body.querySelectorAll('.abbr')) {
      abbr.remove();
    }
    // <br> carries the line breaks; textContent would run the lines together.
    // cleanBodyText then sweeps up markup the parser left as literal text --
    // broken or unclosed tags inside a post survive textContent otherwise.
    const withBreaks = body.innerHTML.replace(/<br\s*\/?>/gi, '\n');
    bodyText = cleanBodyText(parse(withBreaks).textContent);
  }

  return {
    postNo,
    isOp,
    tsUtc: utc,
    name: text(info, '.name') ?? text(container, '.name'),
    tripcode: text(info, '.postertrip') ?? text(container, '.postertrip'),
    subject: text(info, '.subject') ?? text(container, '.subject'),
    bodyText,
    mediaFilename,
    mediaMd5:
      container.querySelector('[data-md5]')?.getAttribute('data-md5') ?? null,
  };
};

/**
 * Thread number asserted by a staged filename, or null to defer to the page.
 *
 * Deliberately anchored at both ends. `/^(\d+)/` would accept
 * `2015-06-01_23433058.html` and call it thread 2015 -- see the note above.
 */
const threadNoFromName = (fileName: string): number | null => {
  const m = /^(\d+)\.html?$/i.exec(fileName);
  return m ? Number(m[1]) : null;
};

export const ingestHtml = async (
  db: Pool,
  opts: {
    root: string;
    sourceId: number;
    site: string;
    boards?: string[];
    excludeBoards?: string[];
  }
): Promise<IngestStats> => {
  const boardFilter = makeBoardFilter(opts.excludeBoards);
  const inserter = new PostInserter(db, opts.sourceId);
  const stats: IngestStats = {
    files: 0,
    threads: 0,
    posts: 0,
    skippedDup: 0,
    badFiles: 0,
  };

  const pages = listHtmlPages(opts.root, opts.boards);
  // Counted as distinct (board, thread) pairs rather than as pages naming a
  // thread: most staged names do not assert one, and a page count reported as
  // a thread count read as "0 thread page(s)" on a source with 17,252 of them.
  const threadKeys = new Set<string>();
  const pending: Promise<void>[] = [];
  const bar = makeBar({ max: pages.length });
  bar.start(`ingesting ${pages.length} page(s)`);

  for (const page of pages) {
    // Advance unconditionally, before any recognize/skip logic below, so the
    // bar's total advance always equals pages.length regardless of how many
    // pages get skipped -- otherwise a tree with lots of skipped/foreign
    // pages would leave the bar stalled short of 100%.
    bar.advance(1, `files=${stats.files} posts=${stats.posts}`);
    // A page that cannot even be opened must not end the run. Handmade
    // archives carry filenames with bytes that are not valid UTF-8, and such
    // a name survives readdir but cannot be passed back to open() -- one of
    // them killed an entire 23k-page pass before this guard existed.
    let raw: string;
    try {
      raw = readFileSync(page.path, 'utf8');
    } catch {
      stats.badFiles++;
      continue;
    }
    const doc = parse(raw);
    // The staged layout puts every page under its board's directory, so the
    // board is known before the markup is read. A page loose at the root did
    // not come from a correct staging run.
    if (page.board === null) {
      stats.badFiles++;
      continue;
    }
    const id = {
      board: page.board,
      threadNo: threadNoFromName(page.name),
    };
    if (opts.boards && !opts.boards.includes(id.board)) {
      continue;
    }
    // Tallied per page, not per post: the page is never parsed for posts.
    if (boardFilter.reject(id.board)) {
      continue;
    }

    // prepare stages native markup only, so this is a staging fault rather
    // than another adapter's file. Counted, and surfaced in the final line:
    // a non-zero value here means the tree holds pages this reader cannot
    // account for, which must not look like a clean run.
    if (!doc.querySelector('.postContainer')) {
      stats.badFiles++;
      continue;
    }
    stats.files++;

    let currentThread = id.threadNo;
    for (const container of doc.querySelectorAll('.postContainer')) {
      const isOp = container.classList.contains('opContainer');
      const provisional = Number(
        (container.getAttribute('id') ?? '').replace(/^pc/, '')
      );
      if (isOp) {
        currentThread = id.threadNo ?? provisional;
      }
      const p = readPost(container);
      if (!p) {
        stats.badFiles++;
        continue;
      }
      const threadNo = currentThread ?? p.postNo;
      threadKeys.add(`${id.board}\t${threadNo}`);
      collectPending(
        pending,
        inserter
          .insert({
            site: opts.site,
            board: id.board,
            // A reply with no OP above it would be orphaned; fall back to its
            // own number so thread_no is never bogus.
            threadNo,
            postNo: p.postNo,
            isOp: p.isOp,
            tsUtc: p.tsUtc,
            name: p.name,
            tripcode: p.tripcode,
            subject: p.subject,
            bodyText: p.bodyText,
            mediaFilename: p.mediaFilename,
            mediaMd5: p.mediaMd5,
          })
          .then((ok) => {
            if (ok) {
              stats.posts++;
            } else {
              stats.skippedDup++;
            }
          })
      );
    }
    bar.message(`/${id.board}/ files=${stats.files} posts=${stats.posts}`);
    // No periodic checkpoint existed here under SQLite (one transaction for
    // the whole run) -- a crash lost every tally since the process started.
    // Flushing every 25 files bounds that loss the same way the other HTML
    // adapter already does.
    if (stats.files % 25 === 0) {
      await inserter.finish();
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  stats.threads = threadKeys.size;
  await inserter.finish();
  await Promise.all(pending);
  bar.stop(
    `${stats.posts} posts from ${stats.files} page(s)` + boardFilter.summary()
  );
  return stats;
};
