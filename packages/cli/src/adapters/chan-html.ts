import { opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stripHtml } from "../html.ts";
import { PostInserter } from "../ingest.ts";

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
 * Two traps in the markup:
 *
 *  - Every post is emitted twice, once as `postInfo desktop` and once as
 *    `postInfoM mobile`. A naive scan for `dateTime` or `nameBlock` counts each
 *    post twice, so fields are read from within one post container and the
 *    first match wins.
 *  - Field order differs between OPs and replies: an OP puts its `.file` block
 *    before `postInfo`, a reply after. Nothing may depend on ordering.
 */

interface IngestStats {
  files: number;
  threads: number;
  posts: number;
  skippedDup: number;
  badFiles: number;
}

/** A post container plus the id and kind taken from its wrapper. */
interface RawPost {
  postNo: number;
  isOp: boolean;
  html: string;
}

// The container id carries the post number: pc<no> on the outer wrapper. Split
// on the wrapper rather than a regex over the whole document so each post's
// fields stay scoped to it -- the desktop/mobile duplication makes any
// document-wide field scan wrong.
const CONTAINER = /<div class="postContainer (op|reply)Container" id="pc(\d+)"/g;

function splitPosts(html: string): RawPost[] {
  const out: RawPost[] = [];
  const starts: { at: number; isOp: boolean; postNo: number }[] = [];
  CONTAINER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONTAINER.exec(html)) !== null) {
    starts.push({ at: m.index, isOp: m[1] === "op", postNo: Number(m[2]) });
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].at : html.length;
    out.push({ postNo: s.postNo, isOp: s.isOp, html: html.slice(s.at, end) });
  }
  return out;
}

/** First capture of `re` in `s`, or null. */
function first(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m ? m[1] : null;
}

const RE_UTC = /<span class="dateTime[^"]*" data-utc="(\d+)"/;
const RE_NAME = /<span class="name">([^<]*)<\/span>/;
const RE_TRIP = /<span class="postertrip">([^<]*)<\/span>/;
const RE_SUBJECT = /<span class="subject">([^<]*)<\/span>/;
// The body runs to the closing tag; [\s\S] because posts contain newlines.
const RE_BODY = /<blockquote class="postMessage"[^>]*>([\s\S]*?)<\/blockquote>/;
// A board index abbreviates long comments and appends its own notice inside the
// blockquote: `<span class="abbr">Comment too long. <a ...>Click here</a> to
// view the full text.</span>`. Stripping tags alone would keep that sentence as
// though the poster had typed it, so drop the whole span before stripping. The
// body stays truncated -- the full text is only on the thread page -- but it no
// longer carries archive chrome into search and word counts.
const RE_ABBR = /<span class="abbr">[\s\S]*?<\/span>/g;
// The poster's original filename is the anchor's title when it was truncated
// for display, and the link text otherwise.
const RE_FILE_TITLE = /<div class="fileText"[^>]*>File: <a title="([^"]*)"/;
const RE_FILE_TEXT = /<div class="fileText"[^>]*>File: <a[^>]*>([^<]*)<\/a>/;
const RE_MD5 = /data-md5="([^"]*)"/;

/** Board and thread number from a saved page's filename or its own markup. */
function threadIdentity(
  fileName: string,
  html: string,
): { board: string; threadNo: number | null } | null {
  // warc-extract names files after the captured URL, e.g.
  // boards.4channel.org_a_thread_231722770.html or boards.4chan.org_pol.html
  const thread = /^boards\.4chan(?:nel)?\.org_([a-z0-9]+)_thread_(\d+)/i.exec(fileName);
  if (thread) return { board: thread[1], threadNo: Number(thread[2]) };
  const board = /^boards\.4chan(?:nel)?\.org_([a-z0-9]+)\b/i.exec(fileName);
  if (board) return { board: board[1], threadNo: null };
  // Fall back to the page's own canonical link when the filename is opaque.
  const canon = /<link rel="canonical" href="[^"]*?\/([a-z0-9]+)\/thread\/(\d+)/i.exec(html);
  if (canon) return { board: canon[1], threadNo: Number(canon[2]) };
  const bmeta = /<link rel="canonical" href="[^"]*?\/([a-z0-9]+)\/?"/i.exec(html);
  if (bmeta) return { board: bmeta[1], threadNo: null };
  return null;
}

/**
 * `threadNo` is the enclosing thread when the page is a thread, and null on a
 * board index -- there each OP begins its own thread, and replies shown in the
 * preview belong to the OP above them.
 */
function ingestPage(
  inserter: PostInserter,
  site: string,
  board: string,
  pageThreadNo: number | null,
  html: string,
  stats: IngestStats,
): void {
  let currentThread = pageThreadNo;
  for (const p of splitPosts(html)) {
    if (p.isOp) currentThread = pageThreadNo ?? p.postNo;
    const utc = first(p.html, RE_UTC);
    const fileTitle = first(p.html, RE_FILE_TITLE) ?? first(p.html, RE_FILE_TEXT);
    const rawBody = first(p.html, RE_BODY);
    // Trim after stripping, not before: dropping the abbr span leaves the <br>s
    // that preceded it, which only become trailing newlines once stripHtml has
    // converted them.
    const body =
      rawBody === null ? null : stripHtml(rawBody.replace(RE_ABBR, "")).trimEnd() || null;
    const subject = first(p.html, RE_SUBJECT);
    const name = first(p.html, RE_NAME);
    const ok = inserter.insert({
      site,
      board,
      // A reply on a board index with no OP above it would be orphaned;
      // fall back to its own number so thread_no is never bogus.
      threadNo: currentThread ?? p.postNo,
      postNo: p.postNo,
      isOp: p.isOp,
      tsUtc: utc ? Number(utc) : null,
      name: name ? stripHtml(name) : null,
      tripcode: first(p.html, RE_TRIP),
      subject: subject ? stripHtml(subject) : null,
      bodyText: body,
      mediaFilename: fileTitle ? stripHtml(fileTitle) : null,
      mediaMd5: first(p.html, RE_MD5),
    });
    if (ok) stats.posts++;
    else stats.skippedDup++;
  }
}

export function ingestChanHtml(
  db: DatabaseSync,
  opts: { root: string; sourceId: number; site: string; boards?: string[] },
): IngestStats {
  const inserter = new PostInserter(db, opts.sourceId);
  const stats: IngestStats = { files: 0, threads: 0, posts: 0, skippedDup: 0, badFiles: 0 };

  const files: string[] = [];
  const dir = opendirSync(opts.root);
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      if (entry.isFile() && /\.html?$/i.test(entry.name)) files.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  files.sort();

  db.exec("BEGIN");
  try {
    for (const name of files) {
      const html = readFileSync(join(opts.root, name), "utf8");
      const id = threadIdentity(name, html);
      if (!id) {
        // Not a recognizable board/thread page: a stylesheet, an error page,
        // or a capture of something else entirely.
        stats.badFiles++;
        continue;
      }
      if (opts.boards && !opts.boards.includes(id.board)) continue;
      stats.files++;
      if (id.threadNo != null) stats.threads++;
      ingestPage(inserter, opts.site, id.board, id.threadNo, html, stats);
      process.stderr.write(
        `\r/${id.board}/ files=${stats.files} posts=${stats.posts}   `,
      );
    }
    // Flush tallies inside the same transaction as the posts they describe.
    inserter.finish();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  process.stderr.write("\n");
  return stats;
}
