import type { Pool } from 'pg';

import { parse, type HTMLElement } from 'node-html-parser';
import { readFileSync } from 'node:fs';

import { listHtmlPages } from '../html-tree.ts';
import { cleanBodyText } from '../html.ts';
import { collectPending, PostInserter } from '../ingest.ts';
import { makeBar } from '../progress.ts';

/**
 * Ingests saved 4chan board/thread pages in the site's own HTML — the markup
 * `boards.4chan.org` serves, as captured by perma.cc, Wayback and similar
 * whole-page archivers.
 *
 * Not the same as a rendered third-party archive (fybertech, BASC-Archiver);
 * those ship their own templates and need their own adapters.
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
 * inside the blockquote (`<span class="abbr">Comment too long…`). That is
 * archive chrome, not post text, so the element is removed before the body is
 * read — the kind of artifact that is a one-line subtree removal here and was
 * a bug when the body was matched as a string.
 */

interface IngestStats {
  files: number;
  threads: number;
  posts: number;
  skippedDup: number;
  badFiles: number;
  /** Pages that are not 4chan's own markup -- another adapter's business. */
  skippedForeign: number;
}

/** Text of the first match, or null when absent or empty. */
const text = (root: HTMLElement, sel: string): string | null => {
  const el = root.querySelector(sel);
  if (!el) return null;
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
  if (!Number.isInteger(postNo) || postNo <= 0) return null;

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
    for (const abbr of body.querySelectorAll('.abbr')) abbr.remove();
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
 * Thread number from a bare `<threadno>.html` filename, as used inside a
 * board directory. Tolerates a trailing annotation -- the handmade archives
 * name files like `1000000 ban.html` -- and returns null when the leading
 * token is not a number.
 */
const threadNoFromName = (fileName: string): number | null => {
  const m = /^(\d+)/.exec(fileName);
  return m ? Number(m[1]) : null;
};

/** Board and thread number from a saved page's filename or its own markup. */
const threadIdentity = (
  fileName: string,
  doc: HTMLElement
): { board: string; threadNo: number | null } | null => {
  // warc-extract names files after the captured URL, e.g.
  // boards.4channel.org_a_thread_231722770.html or boards.4chan.org_pol.html
  const thread = /^boards\.4chan(?:nel)?\.org_([a-z0-9]+)_thread_(\d+)/i.exec(
    fileName
  );
  if (thread) return { board: thread[1], threadNo: Number(thread[2]) };
  const board = /^boards\.4chan(?:nel)?\.org_([a-z0-9]+)\b/i.exec(fileName);
  if (board) return { board: board[1], threadNo: null };
  // <board>_<threadno>.html -- how third-party mirrors name their saved pages.
  // Some of those pages are the site's own markup rather than the mirror's own
  // template (fybertech has 20 such), so this adapter reads them; the mirror's
  // rendered pages are a different family and belong to their own adapter.
  const mirrored = /^([a-z0-9]+)_(\d+)\.html?$/i.exec(fileName);
  if (mirrored) return { board: mirrored[1], threadNo: Number(mirrored[2]) };
  // Fall back to the page's own canonical link when the filename is opaque.
  const href =
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '';
  const canon = /\/([a-z0-9]+)\/thread\/(\d+)/i.exec(href);
  if (canon) return { board: canon[1], threadNo: Number(canon[2]) };
  const bonly = /\/([a-z0-9]+)\/?$/i.exec(href);
  if (bonly) return { board: bonly[1], threadNo: null };
  return null;
};

export const ingestChanHtml = async (
  db: Pool,
  opts: { root: string; sourceId: number; site: string; boards?: string[] }
): Promise<IngestStats> => {
  const inserter = new PostInserter(db, opts.sourceId);
  const stats: IngestStats = {
    files: 0,
    threads: 0,
    posts: 0,
    skippedDup: 0,
    badFiles: 0,
    skippedForeign: 0,
  };

  const pages = listHtmlPages(opts.root, opts.boards);
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
    // In a nested tree the directory names the board, which beats anything
    // inferable from the filename; a flat tree has no directory to consult
    // and falls back to the filename or the page's canonical link.
    const id =
      page.board !== null
        ? { board: page.board, threadNo: threadNoFromName(page.name) }
        : threadIdentity(page.name, doc);
    if (!id) {
      // Not a recognizable board/thread page: a stylesheet, an error page,
      // or a capture of something else entirely.
      stats.badFiles++;
      continue;
    }
    if (opts.boards && !opts.boards.includes(id.board)) continue;

    // No postContainer means this is not 4chan's own markup: a third-party
    // mirror's rendered template, an error page, or something else. Counted
    // separately rather than as an empty success, because a directory can
    // legitimately hold both (fybertech's crawl mixes 20 native pages in
    // with 617 of its own) and each adapter must skip the other's files.
    if (!doc.querySelector('.postContainer')) {
      stats.skippedForeign++;
      continue;
    }
    stats.files++;
    if (id.threadNo != null) stats.threads++;

    let currentThread = id.threadNo;
    for (const container of doc.querySelectorAll('.postContainer')) {
      const isOp = container.classList.contains('opContainer');
      const provisional = Number(
        (container.getAttribute('id') ?? '').replace(/^pc/, '')
      );
      if (isOp) currentThread = id.threadNo ?? provisional;
      const p = readPost(container);
      if (!p) {
        stats.badFiles++;
        continue;
      }
      collectPending(
        pending,
        inserter
          .insert({
            site: opts.site,
            board: id.board,
            // A reply with no OP above it would be orphaned; fall back to its
            // own number so thread_no is never bogus.
            threadNo: currentThread ?? p.postNo,
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
            if (ok) stats.posts++;
            else stats.skippedDup++;
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
  await inserter.finish();
  await Promise.all(pending);
  bar.stop(`${stats.posts} posts from ${stats.files} page(s)`);
  return stats;
};
