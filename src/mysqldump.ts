/** Format-agnostic helpers for stream-parsing mysqldump files and for
 * normalizing Fuuka-family timestamps. */

// ---- America/New_York wall time -> UTC ----------------------------------

const nyFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  timeZoneName: "longOffset",
});
const offsetCache = new Map<number, number>();

/** UTC offset of America/New_York at the given UTC time, in seconds
 * (negative; -14400 for EDT, -18000 for EST). Cached per hour. */
function nyOffsetAt(utcSec: number): number {
  const hour = Math.floor(utcSec / 3600);
  const cached = offsetCache.get(hour);
  if (cached !== undefined) return cached;
  const tzName = nyFormat
    .formatToParts(utcSec * 1000)
    .find((p) => p.type === "timeZoneName")!.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!m) throw new Error(`cannot parse timezone offset: ${tzName}`);
  const sign = m[1] === "-" ? -1 : 1;
  const offset = sign * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60);
  offsetCache.set(hour, offset);
  return offset;
}

/** Interpret `wall` (epoch-encoded New York wall clock, as stored by
 * Fuuka/Asagi archivers) as true UTC. */
export function nyWallToUtc(wall: number): number {
  let utc = wall - nyOffsetAt(wall);
  utc = wall - nyOffsetAt(utc);
  return utc;
}

// ---- mysqldump INSERT tuple parsing -------------------------------------

const ESCAPES: Record<string, string> = {
  "0": "\0",
  n: "\n",
  r: "\r",
  t: "\t",
  Z: "\x1a",
  b: "\b",
};

export function* parseTuples(
  line: string,
  start: number,
): Generator<(string | null)[]> {
  let i = start;
  const n = line.length;
  while (i < n) {
    while (i < n && line[i] !== "(") i++;
    if (i >= n) return;
    i++;
    const vals: (string | null)[] = [];
    for (;;) {
      if (line[i] === "'") {
        i++;
        let out = "";
        let seg = i;
        for (;;) {
          const ch = line[i];
          if (ch === undefined) throw new Error("unterminated string");
          if (ch === "\\") {
            const esc = line[i + 1];
            out += line.slice(seg, i) + (ESCAPES[esc] ?? esc);
            i += 2;
            seg = i;
          } else if (ch === "'") {
            out += line.slice(seg, i);
            if (line[i + 1] === "'") {
              out += "'";
              i += 2;
              seg = i;
            } else {
              i++;
              break;
            }
          } else {
            i++;
          }
        }
        vals.push(out);
      } else {
        let j = i;
        while (j < n && line[j] !== "," && line[j] !== ")") j++;
        if (j >= n) throw new Error("unterminated tuple");
        const tok = line.slice(i, j);
        vals.push(tok === "NULL" ? null : tok);
        i = j;
      }
      if (line[i] === ",") {
        i++;
      } else if (line[i] === ")") {
        i++;
        break;
      } else {
        throw new Error(`unexpected character at offset ${i}`);
      }
    }
    yield vals;
  }
}
