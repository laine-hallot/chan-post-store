const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&amp;/g, "&");
}

/**
 * Sweep leftover markup out of text already extracted from a DOM.
 *
 * A DOM parser's `textContent` only drops what it recognised *as* markup.
 * Handmade archive pages contain broken and unclosed tags inside post bodies,
 * and those survive as literal characters -- `<span class="quote"` sitting in
 * the middle of a sentence -- which would then be stored as though the poster
 * had typed them. Returns null when nothing but markup was there.
 */
export function cleanBodyText(text: string): string | null {
  const t = decodeEntities(
    text
      // A whole tag the parser left behind, then any unterminated one at the
      // end: a truncated page can stop mid-tag.
      .replace(/<[^<>]*>/g, "")
      .replace(/<[^<>]*$/, ""),
  ).trimEnd();
  return t === "" ? null : t;
}

/**
 * Convert 4chan API comment HTML to plain text. Line breaks become \n,
 * greentext quotes keep their leading ">".
 */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<wbr\s*\/?>/gi, "")
      .replace(/<[^>]+>/g, ""),
  );
}
