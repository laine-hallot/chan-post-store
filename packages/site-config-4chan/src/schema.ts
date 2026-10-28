import * as z from 'zod';

export const BoardEventSchema = z.intersection(
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('created'),
        'post-number': z.optional(z.string()),
      })
      .transform(({ 'post-number': postNumber, ...event }) => ({
        ...event,
        postNumber,
      })),
    z.object({
      type: z.literal('removed'),
    }),
    z.object({
      type: z.literal('renamed'),
    }),
    z
      .object({
        type: z.literal('post'),
        'post-number': z.string(),
      })
      .transform(({ 'post-number': postNumber, ...event }) => ({
        ...event,
        postNumber,
      })),
  ]),
  z.object({
    datetime: z.union([
      z.iso.datetime({ offset: true }),
      z.iso.datetime({ offset: true, precision: -1 }),
    ]),
    citations: z.array(z.string()),
    note: z.optional(z.string()),
  })
);
export type BoardEvent = z.infer<typeof BoardEventSchema>;

export const BoardSchema = z.object({
  id: z.string(),
  events: z.array(BoardEventSchema),
});

export type Board = z.infer<typeof BoardSchema>;

export const CitationSchema = z.intersection(
  z.discriminatedUnion('type', [
    z.object({
      id: z.string(),
      type: z.literal('url'),
      domain: z.string(),
      url: z.string(),
    }),
    z.object({
      id: z.string(),
      type: z.literal('screenshot'),
      file: z.string(),
    }),
  ]),
  z.object({
    description: z.optional(z.string()),
  })
);

export type Citation = z.infer<typeof CitationSchema>;

const SiteOutageSchema = z.object({
  start: z.string(),
  end: z.string(),
  note: z.string(),
  citations: z.array(z.string()),
});

export type SiteOutage = z.infer<typeof CitationSchema>;

const SiteEventsSchema = z.object({
  siteOutages: z.array(SiteOutageSchema),
});

export type SiteEvents = z.infer<typeof SiteEventsSchema>;
