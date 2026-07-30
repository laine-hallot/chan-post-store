import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { parse, type HTMLElement, type Node } from "node-html-parser";
import { cleanBodyText } from "../html.ts";
import { listHtmlPages } from "../html-tree.ts";
import { PostInserter } from "../ingest.ts";
import { nyWallToUtc } from "../mysqldump.ts";

/**
 * Ingests fybertech.com's rendered 4chan thread pages (2008-2014).
 *
 * Files are `<board>_<threadno>.html`. The item ships **three** markup
 * generations, and only two of them are this adapter's business:
 *
 *  - **classic** (420 pages): replies in `<td class="reply" id="<postno>">`,
 *    the OP loose at body level with `<span id="nothread<postno>">`.
 *  - **later** (197 pages): every post, OP included, is a
 *    `<div class="post">` with `post_no`/`post_now`/`post_name`/`post_sub`/
 *    `post_com` children.
 *  - 20 further pages are 4chan's *own* markup, which `chan-html` reads; this
 *    adapter skips them so the two do not disagree about the same file. One
 *    page (`co_68816611.html`) is a fybertech error page with no posts.
 *
 * Unlike `chan-html` there is no `data-utc`: the timestamp is the displayed
 * `04/08/08(Tue)03:16`, which is 4chan's America/New_York wall clock, so it
 * goes through `nyWallToUtc` exactly as the Fuuka-family dumps do. Pages from
 * before ~2013 show no seconds, so those timestamps are minute-precision --
 * recorded as :00 rather than guessed.
 */

interface IngestStats {
  files: number;
  threads: number;
  posts: number;
  skippedDup: number;
  badFiles: number;
  skippedNative: number;
}

interface ParsedPost {
  postNo: number;
  isOp: boolean;
  tsUtc: number | null;
  name: string | null;
  tripcode: string | null;
  subject: string | null;
  bodyText: string | null;
  mediaFilename: string | null;
}

/** `04/08/08(Tue)03:16` or `07/27/14(Sun)14:30:43` -> epoch seconds (UTC).
 *
 * Two-digit years: 4chan launched in 2003 and fybertech's crawl stops in 2015,
 * so every value is 20xx. Seconds are absent on the older pages and default to
 * zero, which loses precision but never invents it. */
const DATE = /(\d{2})\/(\d{2})\/(\d{2})\((?:\w{3})\)(\d{2}):(\d{2})(?::(\d{2}))?/;

export function parseFyberDate(s: string): number | null {
  const m = DATE.exec(s);
  if (!m) return null;
  const [, mo, dd, yy, hh, mi, ss] = m;
  const wall = Date.UTC(
    2000 + Number(yy),
    Number(mo) - 1,
    Number(dd),
    Number(hh),
    Number(mi),
    ss ? Number(ss) : 0,
  ) / 1000;
  // The displayed clock is New York wall time, not UTC.
  return nyWallToUtc(wall);
}

/** Concatenated text of a node's own text children, trimmed. */
function looseText(el: Node): string {
  return el.childNodes
    .filter((n) => n.nodeType === 3)
    .map((n) => (n as unknown as { rawText: string }).rawText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The timestamp, wherever this page's generation put it.
 *
 * The classic template has two sub-variants: most pages leave the date as a
 * bare text node between the name and post-number spans, but some wrap it in
 * `<span class="posttime">`. Checking the span first and falling back to loose
 * text covers both -- reading only loose text silently lost the date on 7834
 * posts (5.4%), because the wrapped ones leave nothing but whitespace behind.
 */
function dateWithin(el: HTMLElement): number | null {
  const span = el.querySelector(".posttime")?.textContent;
  const fromSpan = parseFyberDate(span ?? "");
  if (fromSpan != null) return fromSpan;
  const fromLoose = parseFyberDate(looseText(el));
  if (fromLoose != null) return fromLoose;
  // Neither shape matched, so the date is nested inside another element. A
  // capcode post wraps the name in coloured spans and the date ends up inside
  // that block rather than beside it -- moot's `## Admin` posts do exactly
  // this. Search the header markup, stopping at the blockquote so a date
  // written in the post body can never be read as the post's own.
  const html = el.innerHTML;
  const bq = html.search(/<blockquote/i);
  return parseFyberDate(bq > 0 ? html.slice(0, bq) : html);
}

/**
 * The OP's date, for pages where it is a text node that belongs to no element
 * of its own.
 *
 * Walks the raw text up to the first reply cell and takes the first date in it.
 * Bounded that way because past that point every date belongs to a reply --
 * scanning the whole document would silently stamp the OP with reply #1's
 * timestamp.
 */
function firstDateBeforeReplies(el: HTMLElement): number | null {
  const html = el.innerHTML;
  const cut = html.search(/<td[^>]*class="reply"|<div class="post"/i);
  return parseFyberDate(cut > 0 ? html.slice(0, cut) : html);
}

/** Text of `sel` within `root`, or null when missing or blank. */
function pick(root: HTMLElement, sel: string): string | null {
  const t = root.querySelector(sel)?.textContent?.trim();
  return t ? t : null;
}

/**
 * Body text with <br> turned into newlines, matching the other adapters.
 *
 * The result is swept for leftover tags before being returned. `textContent`
 * only drops markup the parser recognised as markup: a post containing broken
 * or unclosed HTML -- which these handmade pages do contain -- leaves fragments
 * like `<span class="quote"` sitting in the text as literal characters, and
 * those would otherwise be stored as though the poster had typed them.
 */
function bodyOf(el: HTMLElement | null): string | null {
  if (!el) return null;
  const text = parse(el.innerHTML.replace(/<br\s*\/?>/gi, "\n")).textContent;
  return cleanBodyText(text);
}

/**
 * fybertech prints the file line as
 * `File :1207638981.jpg-(51 KB, 287x700, chibi rei.jpg)`.
 * The trailing parenthesised field is the poster's original filename; the
 * leading token is the server's timestamp name. Prefer the original, since
 * that is what the other adapters store.
 */
function fileNameFrom(text: string | null): string | null {
  if (!text) return null;
  const paren = /\(([^)]*)\)\s*$/.exec(text);
  if (paren) {
    const parts = paren[1].split(",").map((p) => p.trim());
    const last = parts[parts.length - 1];
    // "51 KB, 287x700" alone means no original name was recorded.
    if (last && !/^\d+x\d+$/.test(last) && !/^\d+(\.\d+)?\s*[KMG]?B$/i.test(last)) return last;
  }
  const served = /File\s*:?\s*([^\s-]+)/.exec(text);
  return served ? served[1] : null;
}

// ---- the two fybertech templates ----------------------------------------

/**
 * `<div class="post">` per post, OP included.
 *
 * The first post on the page is the OP -- this template renders a thread in
 * order. Matching `postNo === threadNo` instead would depend on the caller's
 * thread number being right, and on an annotated filename ("8 216.htm") it is
 * not, which left those pages with no OP at all.
 */
function readLater(doc: HTMLElement): ParsedPost[] {
  const out: ParsedPost[] = [];
  let first = true;
  for (const p of doc.querySelectorAll(".post")) {
    const noText = pick(p, ".post_no");
    const postNo = Number(noText);
    if (!Number.isInteger(postNo) || postNo <= 0) continue;
    const isOp = first;
    first = false;
    out.push({
      postNo,
      isOp,
      tsUtc: parseFyberDate(pick(p, ".post_now") ?? ""),
      name: pick(p, ".post_name"),
      // post_id holds a tripcode when there is one; empty on every sampled page.
      tripcode: pick(p, ".post_id"),
      subject: pick(p, ".post_sub"),
      bodyText: bodyOf(p.querySelector(".post_com")),
      mediaFilename: pick(p, ".post_filename"),
    });
  }
  return out;
}

/**
 * Replies in `td.reply`; the OP is loose at body level, so it is read from
 * whatever precedes the first reply table rather than from a container.
 */
function readClassic(doc: HTMLElement, threadNo: number): ParsedPost[] {
  const out: ParsedPost[] = [];

  // --- the OP ---
  // Not every page has a <body> tag; where it is missing the parser hangs the
  // content off <html>, so anchor on whichever exists rather than assuming.
  const body = doc.querySelector("body") ?? doc.querySelector("html") ?? doc;
  const opNoEl = body
    .querySelectorAll("span[id]")
    .find((s) => /^nothread\d+$/.test(s.getAttribute("id") ?? ""));
  const opNo = opNoEl
    ? Number((opNoEl.getAttribute("id") ?? "").replace("nothread", ""))
    : threadNo;
  // The OP's date follows its name span as a loose text node -- or sits in a
  // .posttime span on the pages that wrap it. Take the first date that appears
  // before the first reply, since scanning the whole document would otherwise
  // pick up a reply's date on pages with no <body> element (the OP's own text
  // node is a child of <html> there, not of any post container).
  const opDate = dateWithin(body) ?? firstDateBeforeReplies(body);
  const opBq = body.querySelector("blockquote");
  out.push({
    postNo: opNo,
    isOp: true,
    tsUtc: opDate,
    name: pick(body, "span.postername"),
    tripcode: pick(body, "span.postertrip"),
    subject: pick(body, "span.filetitle"),
    bodyText: bodyOf(opBq),
    mediaFilename: fileNameFrom(pick(body, "span.filesize")),
  });

  // --- the replies ---
  for (const td of doc.querySelectorAll("td.reply")) {
    const postNo = Number(td.getAttribute("id"));
    if (!Number.isInteger(postNo) || postNo <= 0) continue;
    out.push({
      postNo,
      isOp: false,
      tsUtc: dateWithin(td),
      name: pick(td, "span.commentpostername"),
      tripcode: pick(td, "span.postertrip"),
      subject: pick(td, "span.replytitle"),
      bodyText: bodyOf(td.querySelector("blockquote")),
      mediaFilename: fileNameFrom(pick(td, "span.filesize")),
    });
  }
  return out;
}

export function ingestFybertechHtml(
  db: DatabaseSync,
  opts: { root: string; sourceId: number; site: string; boards?: string[] },
): IngestStats {
  const inserter = new PostInserter(db, opts.sourceId);
  const stats: IngestStats = {
    files: 0,
    threads: 0,
    posts: 0,
    skippedDup: 0,
    badFiles: 0,
    skippedNative: 0,
  };

  db.exec("BEGIN");
  try {
    for (const page of listHtmlPages(opts.root, opts.boards)) {
      // Two layouts reach this adapter. Flat: fybertech's own crawl names
      // pages <board>_<threadno>.html, and the same directory holds its
      // index.cgi listing pages, which have no posts and no board to derive.
      // Nested: a mirrored site puts <threadno>.html inside a board directory,
      // so the board is the directory and the number is the filename.
      let board: string;
      let threadNoFromFile: number | null;
      if (page.board !== null) {
        const m = /^(\d+)/.exec(page.name);
        if (!m) {
          stats.badFiles++;
          continue;
        }
        board = page.board;
        threadNoFromFile = Number(m[1]);
      } else {
        const m = /^([a-z0-9]+)_(\d+)\.html?$/i.exec(page.name);
        if (!m) continue; // index.cgi and friends: not a thread page at all
        board = m[1];
        threadNoFromFile = Number(m[2]);
        if (opts.boards && !opts.boards.includes(board)) continue;
      }

      // An unopenable page must not end the run: handmade archives carry
      // filenames whose bytes are not valid UTF-8, and such a name survives
      // readdir but cannot be passed back to open().
      let raw: string;
      try {
        raw = readFileSync(page.path, "utf8");
      } catch {
        stats.badFiles++;
        continue;
      }
      const doc = parse(raw);

      // 4chan's own markup: chan-html's job, not this adapter's.
      if (doc.querySelector(".postContainer")) {
        stats.skippedNative++;
        continue;
      }

      // The page's own `nothread<id>` beats the filename. Handmade archives
      // annotate names -- `8 216.htm`, `1861111 2.htm` -- and a leading-digits
      // regex reads those as thread 8 and thread 1861111, which then collide
      // with, or misattribute, real threads. The markup is authoritative;
      // fall back to the filename only when the page carries no id.
      const idInMarkup = doc
        .querySelectorAll("span[id]")
        .map((s) => /^nothread(\d+)$/.exec(s.getAttribute("id") ?? "")?.[1])
        .find((v) => v != null);
      const threadNo = idInMarkup ? Number(idInMarkup) : threadNoFromFile;
      if (threadNo == null || !Number.isInteger(threadNo) || threadNo <= 0) {
        stats.badFiles++;
        continue;
      }

      const posts = doc.querySelector(".post_com")
        ? readLater(doc)
        : doc.querySelector("td.reply, span.postername")
          ? readClassic(doc, threadNo)
          : [];
      if (posts.length === 0) {
        stats.badFiles++;
        continue;
      }

      // The OP's own post number is the thread number, by definition. Prefer it
      // over anything derived from the filename, which the handmade archives
      // annotate.
      const opNo = posts.find((p) => p.isOp)?.postNo;
      const realThreadNo = opNo ?? threadNo;

      stats.files++;
      stats.threads++;
      for (const p of posts) {
        const ok = inserter.insert({
          site: opts.site,
          board,
          threadNo: realThreadNo,
          postNo: p.postNo,
          isOp: p.isOp,
          tsUtc: p.tsUtc,
          name: p.name,
          tripcode: p.tripcode,
          subject: p.subject,
          bodyText: p.bodyText,
          mediaFilename: p.mediaFilename,
          mediaMd5: null, // fybertech's pages do not carry file hashes
        });
        if (ok) stats.posts++;
        else stats.skippedDup++;
      }
      if (stats.files % 25 === 0) {
        process.stderr.write(`\rfiles=${stats.files} posts=${stats.posts}   `);
      }
    }
    // Flush tallies inside the same transaction as the posts they describe.
    inserter.finish();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  process.stderr.write(`\rfiles=${stats.files} posts=${stats.posts}   \n`);
  return stats;
}
