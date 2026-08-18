import type { Readable } from 'node:stream';

import { StringDecoder } from 'node:string_decoder';

/**
 * Split a dump into lines on "\n" and nothing else.
 *
 * `readline` cannot be used here. Node splits on U+2028 LINE SEPARATOR and
 * U+2029 PARAGRAPH SEPARATOR and a lone \r as well as on \n, and 4chan post
 * bodies contain all three. A dump's line structure is defined by \n alone,
 * so every other break lands INSIDE a quoted string and cuts the statement in
 * half.
 *
 * This was measured, not anticipated. laza-4chan-archive's `a` table has a
 * post whose comment carries a literal U+2028; `readline` returned the
 * 1,042,290-character INSERT as a 69,840-character fragment, and the old
 * line-wise reader parsed 260 of its 3,873 tuples, threw "unterminated
 * string", counted one bad line and dropped the other 3,613 posts. In a
 * 300MB slice that was 0.33% of the table, lost silently -- the run exited 0
 * and looked like any other.
 *
 * A trailing \r before the \n is still stripped, so CRLF dumps read the same
 * as they always did; a \r anywhere else is content and is preserved.
 */
export const readLines = async function* (
  input: Readable,
  onBytes?: (n: number) => void
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  for await (const chunk of input) {
    const bytes = chunk as Buffer;
    onBytes?.(bytes.length);
    buf += decoder.write(bytes);
    let start = 0;
    let nl = buf.indexOf('\n', start);
    while (nl !== -1) {
      const line = buf.slice(start, nl);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      start = nl + 1;
      nl = buf.indexOf('\n', start);
    }
    // One slice per chunk rather than one per line: these dumps reach a
    // megabyte per line and repeated head-trimming is quadratic.
    if (start > 0) {
      buf = buf.slice(start);
    }
  }
  buf += decoder.end();
  if (buf.length > 0) {
    yield buf.endsWith('\r') ? buf.slice(0, -1) : buf;
  }
};
