import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/**
 * Minimal WARC 1.0 reader for the Perma.cc captures.
 *
 * Only what those items need: response records, de-chunked and
 * content-decoded. Records are located by byte offset rather than parsed
 * into a stream, which is fine at these sizes (single-digit MB).
 */

export interface WarcRecord {
  type: string;
  uri?: string;
  date?: string;
  /** HTTP status line + headers, for response records. */
  httpHeaders: string;
  contentType?: string;
  /** Fully decoded body (de-chunked, un-gzipped/brotli'd). */
  body: Buffer;
}

const SEP = "WARC/1.0\r\n";

/** Undoes HTTP chunked transfer-encoding. */
const deChunk = (buf: Buffer): Buffer => {
  const out: Buffer[] = [];
  let i = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", i, "latin1");
    if (nl < 0) break;
    const size = parseInt(buf.subarray(i, nl).toString("latin1").split(";")[0], 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out.push(buf.subarray(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
};

const decode = (payload: Buffer, httpHeaders: string): Buffer => {
  let out = payload;
  if (/transfer-encoding:\s*chunked/i.test(httpHeaders)) out = deChunk(out);
  const enc = /content-encoding:\s*([\w-]+)/i.exec(httpHeaders)?.[1]?.toLowerCase();
  try {
    // 4chan is behind Cloudflare, so captures are usually brotli.
    if (enc === "br") return brotliDecompressSync(out);
    if (enc === "gzip") return gunzipSync(out);
    if (enc === "deflate") return inflateSync(out);
  } catch {
    // A body we can't decode is returned as-is; callers filter by content.
  }
  return out;
};

/**
 * Iterates the response records of an uncompressed WARC.
 *
 * The buffer is scanned as latin1 so string offsets map 1:1 onto bytes;
 * decoding as utf8 first would shift them and corrupt the slices.
 */
export const readResponses = function* (warc: Buffer): Generator<WarcRecord> {
  const s = warc.toString("latin1");
  let pos = 0;
  while (pos < s.length) {
    const start = s.indexOf(SEP, pos);
    if (start < 0) break;
    let next = s.indexOf(SEP, start + SEP.length);
    if (next < 0) next = s.length;
    pos = next;

    const recStart = start + SEP.length;
    const he = s.indexOf("\r\n\r\n", recStart);
    if (he < 0 || he > next) continue;

    const hdr = s.slice(recStart, he);
    const type = /^WARC-Type:\s*(\S+)/im.exec(hdr)?.[1] ?? "";
    if (type !== "response") continue;

    const body = warc.subarray(he + 4, next);
    const bs = body.toString("latin1");
    const hh = bs.indexOf("\r\n\r\n");
    if (hh < 0) continue;
    const httpHeaders = bs.slice(0, hh);

    yield {
      type,
      uri: /^WARC-Target-URI:\s*(\S+)/im.exec(hdr)?.[1],
      date: /^WARC-Date:\s*(\S+)/im.exec(hdr)?.[1],
      httpHeaders,
      contentType: /^content-type:\s*([^\r\n;]+)/im.exec(httpHeaders)?.[1]?.trim(),
      body: decode(body.subarray(hh + 4), httpHeaders),
    };
  }
};

/**
 * Response records that carry HTML from the given host.
 *
 * Non-2xx responses are dropped: error pages (Cloudflare's, for instance)
 * are served as text/html and would otherwise be written out alongside the
 * real captures — /robots.txt and /favicon.ico both come back this way.
 */
export const htmlPages = function* (
  warc: Buffer,
  hostPattern: RegExp,
): Generator<WarcRecord> {
  for (const r of readResponses(warc)) {
    if (!r.uri || !hostPattern.test(r.uri)) continue;
    if (!/text\/html/i.test(r.contentType ?? "")) continue;
    const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(r.httpHeaders)?.[1]);
    if (!(status >= 200 && status < 300)) continue;
    yield r;
  }
};

/** Filename-safe slug for a captured URL. */
export const uriToFilename = (uri: string): string => {
  const u = uri.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `${u.replace(/[^A-Za-z0-9._-]+/g, "_")}.html`;
};
