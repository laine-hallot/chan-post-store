// Part of a prepare payload: this file is uploaded to whichever machine holds
// the archives and run there. It may import only `node:` builtins and its own
// siblings -- nothing from this repo is resolvable at that point, which is why
// the helpers below are copies rather than imports.
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
 * Sweep leftover markup out of text already extracted from a DOM.
 *
 * A DOM parser's `textContent` only drops what it recognised *as* markup.
 * Handmade archive pages contain broken and unclosed tags inside post bodies,
 * and those survive as literal characters -- `<span class="quote"` sitting in
 * the middle of a sentence -- which would then be stored as though the poster
 * had typed them. Returns null when nothing but markup was there.
 */
export const cleanBodyText = (text: string): string | null => {
  const t = decodeEntities(
    text
      // A whole tag the parser left behind, then any unterminated one at the
      // end: a truncated page can stop mid-tag.
      .replace(/<[^<>]*>/g, '')
      .replace(/<[^<>]*$/, '')
  ).trimEnd();
  return t === '' ? null : t;
};
