// Part of a prepare payload: this file is uploaded to whichever machine holds
// the archives and run there. It may import only `node:` builtins and its own
// siblings -- nothing from this repo is resolvable at that point, which is why
// the helpers below are copies rather than imports.
//
// Node strips the types at load; no build step, so no syntax that emits code.

import { createRequire } from 'node:module';

import { cleanBodyText } from './text.ts';
import { nyWallToUtc } from './time.ts';

// The parser is vendored as a self-contained UMD bundle beside this file; see
// vendor/README. Named .cjs so it is unambiguously CommonJS: this repo sets
// "type": "module", which would otherwise make node read the UMD as ESM and
// silently hand back an empty namespace.
const require_ = createRequire(import.meta.url);
const { parse } = require_('./vendor/node-html-parser.umd.cjs') as {
  parse: (html: string) => HTMLElement;
};

// Structural stand-ins for node-html-parser's types, which cannot be imported
// from a vendored bundle. Only the members these parsers actually use.
export interface Node {
  nodeType: number;
  childNodes: Node[];
}
export interface HTMLElement extends Node {
  textContent: string;
  innerHTML: string;
  getAttribute(name: string): string | null;
  querySelector(sel: string): HTMLElement | null;
  querySelectorAll(sel: string): HTMLElement[];
}

export { parse };

export interface ParsedPost {
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
const DATE =
  /(\d{2})\/(\d{2})\/(\d{2})\((?:\w{3})\)(\d{2}):(\d{2})(?::(\d{2}))?/;

export const parseFyberDate = (s: string): number | null => {
  const m = DATE.exec(s);
  if (!m) {
    return null;
  }
  const [, mo, dd, yy, hh, mi, ss] = m;
  const wall =
    Date.UTC(
      2000 + Number(yy),
      Number(mo) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      ss ? Number(ss) : 0
    ) / 1000;
  // The displayed clock is New York wall time, not UTC.
  return nyWallToUtc(wall);
};

/** Concatenated text of a node's own text children, trimmed. */
const looseText = (el: Node): string => {
  return el.childNodes
    .filter((n) => n.nodeType === 3)
    .map((n) => (n as unknown as { rawText: string }).rawText)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * The timestamp, wherever this page's generation put it.
 *
 * The classic template has two sub-variants: most pages leave the date as a
 * bare text node between the name and post-number spans, but some wrap it in
 * `<span class="posttime">`. Checking the span first and falling back to loose
 * text covers both -- reading only loose text silently lost the date on 7834
 * posts (5.4%), because the wrapped ones leave nothing but whitespace behind.
 */
const dateWithin = (el: HTMLElement): number | null => {
  const span = el.querySelector('.posttime')?.textContent;
  const fromSpan = parseFyberDate(span ?? '');
  if (fromSpan != null) {
    return fromSpan;
  }
  const fromLoose = parseFyberDate(looseText(el));
  if (fromLoose != null) {
    return fromLoose;
  }
  // Neither shape matched, so the date is nested inside another element. A
  // capcode post wraps the name in coloured spans and the date ends up inside
  // that block rather than beside it -- moot's `## Admin` posts do exactly
  // this. Search the header markup, stopping at the blockquote so a date
  // written in the post body can never be read as the post's own.
  const html = el.innerHTML;
  const bq = html.search(/<blockquote/i);
  return parseFyberDate(bq > 0 ? html.slice(0, bq) : html);
};

/**
 * The OP's date, for pages where it is a text node that belongs to no element
 * of its own.
 *
 * Walks the raw text up to the first reply cell and takes the first date in it.
 * Bounded that way because past that point every date belongs to a reply --
 * scanning the whole document would silently stamp the OP with reply #1's
 * timestamp.
 */
const firstDateBeforeReplies = (el: HTMLElement): number | null => {
  const html = el.innerHTML;
  const cut = html.search(/<td[^>]*class="reply"|<div class="post"/i);
  return parseFyberDate(cut > 0 ? html.slice(0, cut) : html);
};

/** Text of `sel` within `root`, or null when missing or blank. */
const pick = (root: HTMLElement, sel: string): string | null => {
  const t = root.querySelector(sel)?.textContent?.trim();
  return t ? t : null;
};

/**
 * Body text with <br> turned into newlines, matching the other adapters.
 *
 * The result is swept for leftover tags before being returned. `textContent`
 * only drops markup the parser recognised as markup: a post containing broken
 * or unclosed HTML -- which these handmade pages do contain -- leaves fragments
 * like `<span class="quote"` sitting in the text as literal characters, and
 * those would otherwise be stored as though the poster had typed them.
 */
const bodyOf = (el: HTMLElement | null): string | null => {
  if (!el) {
    return null;
  }
  const text = parse(el.innerHTML.replace(/<br\s*\/?>/gi, '\n')).textContent;
  return cleanBodyText(text);
};

/**
 * fybertech prints the file line as
 * `File :1207638981.jpg-(51 KB, 287x700, chibi rei.jpg)`.
 * The trailing parenthesised field is the poster's original filename; the
 * leading token is the server's timestamp name. Prefer the original, since
 * that is what the other adapters store.
 */
const fileNameFrom = (text: string | null): string | null => {
  if (!text) {
    return null;
  }
  const paren = /\(([^)]*)\)\s*$/.exec(text);
  if (paren) {
    const parts = paren[1].split(',').map((p) => p.trim());
    const last = parts[parts.length - 1];
    // "51 KB, 287x700" alone means no original name was recorded.
    if (
      last &&
      !/^\d+x\d+$/.test(last) &&
      !/^\d+(\.\d+)?\s*[KMG]?B$/i.test(last)
    ) {
      return last;
    }
  }
  const served = /File\s*:?\s*([^\s-]+)/.exec(text);
  return served ? served[1] : null;
};

// ---- the two fybertech templates ----------------------------------------

/**
 * `<div class="post">` per post, OP included.
 *
 * The first post on the page is the OP -- this template renders a thread in
 * order. Matching `postNo === threadNo` instead would depend on the caller's
 * thread number being right, and on an annotated filename ("8 216.htm") it is
 * not, which left those pages with no OP at all.
 */
const readLater = (doc: HTMLElement): ParsedPost[] => {
  const out: ParsedPost[] = [];
  let first = true;
  for (const p of doc.querySelectorAll('.post')) {
    const noText = pick(p, '.post_no');
    const postNo = Number(noText);
    if (!Number.isInteger(postNo) || postNo <= 0) {
      continue;
    }
    const isOp = first;
    first = false;
    out.push({
      postNo,
      isOp,
      tsUtc: parseFyberDate(pick(p, '.post_now') ?? ''),
      name: pick(p, '.post_name'),
      // post_id holds a tripcode when there is one; empty on every sampled page.
      tripcode: pick(p, '.post_id'),
      subject: pick(p, '.post_sub'),
      bodyText: bodyOf(p.querySelector('.post_com')),
      mediaFilename: pick(p, '.post_filename'),
    });
  }
  return out;
};

/**
 * Replies in `td.reply`; the OP is loose at body level, so it is read from
 * whatever precedes the first reply table rather than from a container.
 */
const readClassic = (doc: HTMLElement, threadNo: number): ParsedPost[] => {
  const out: ParsedPost[] = [];

  // --- the OP ---
  // Not every page has a <body> tag; where it is missing the parser hangs the
  // content off <html>, so anchor on whichever exists rather than assuming.
  const body = doc.querySelector('body') ?? doc.querySelector('html') ?? doc;
  const opNoEl = body
    .querySelectorAll('span[id]')
    .find((s) => /^nothread\d+$/.test(s.getAttribute('id') ?? ''));
  const opNo = opNoEl
    ? Number((opNoEl.getAttribute('id') ?? '').replace('nothread', ''))
    : threadNo;
  // The OP's date follows its name span as a loose text node -- or sits in a
  // .posttime span on the pages that wrap it. Take the first date that appears
  // before the first reply, since scanning the whole document would otherwise
  // pick up a reply's date on pages with no <body> element (the OP's own text
  // node is a child of <html> there, not of any post container).
  const opDate = dateWithin(body) ?? firstDateBeforeReplies(body);
  const opBq = body.querySelector('blockquote');
  out.push({
    postNo: opNo,
    isOp: true,
    tsUtc: opDate,
    name: pick(body, 'span.postername'),
    tripcode: pick(body, 'span.postertrip'),
    subject: pick(body, 'span.filetitle'),
    bodyText: bodyOf(opBq),
    mediaFilename: fileNameFrom(pick(body, 'span.filesize')),
  });

  // --- the replies ---
  for (const td of doc.querySelectorAll('td.reply')) {
    const postNo = Number(td.getAttribute('id'));
    if (!Number.isInteger(postNo) || postNo <= 0) {
      continue;
    }
    out.push({
      postNo,
      isOp: false,
      tsUtc: dateWithin(td),
      name: pick(td, 'span.commentpostername'),
      tripcode: pick(td, 'span.postertrip'),
      subject: pick(td, 'span.replytitle'),
      bodyText: bodyOf(td.querySelector('blockquote')),
      mediaFilename: fileNameFrom(pick(td, 'span.filesize')),
    });
  }
  return out;
};

/**
 * Picks the reader for this page's markup generation. The crawl spans two of
 * them (plus 4chan's own, handled by `chan-html`), so the layout is detected
 * per page rather than assumed for the tree; an empty result means neither
 * matched and the caller counts the page as unparsed.
 */
export const readAnyGeneration = (
  doc: HTMLElement,
  threadNo: number
): ParsedPost[] => {
  if (doc.querySelector('.post_com')) {
    return readLater(doc);
  }
  if (doc.querySelector('td.reply, span.postername')) {
    return readClassic(doc, threadNo);
  }
  return [];
};
