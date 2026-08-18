// Part of a prepare payload: this file is uploaded to whichever machine holds
// the archives and run there. It may import only `node:` builtins and its own
// siblings -- nothing from this repo is resolvable at that point, which is why
// these are copies rather than imports.
//
// Node strips the types at load; no build step, so no syntax that emits code.

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decodeEntities = (s: string): string => {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(
      /&([a-z]+);/gi,
      (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m
    )
    .replace(/&amp;/g, '&');
};

/**
 * Convert 4chan API comment HTML to plain text. Line breaks become \n,
 * greentext quotes keep their leading ">".
 */
export const stripHtml = (html: string): string => {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<wbr\s*\/?>/gi, '')
      .replace(/<[^>]+>/g, '')
  );
};
