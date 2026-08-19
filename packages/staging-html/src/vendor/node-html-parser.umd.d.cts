// The vendored bundle has no types of its own; the parsers declare the shape
// they use structurally in fybertech-markup.ts.
declare const parser: { parse: (html: string) => unknown };
export = parser;
