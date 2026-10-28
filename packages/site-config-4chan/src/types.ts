import type { Board, Citation, SiteEvents } from './schema.ts';

export type SiteConfig = {
  siteEvents: SiteEvents;
  citations: Citation[];
  boards: Board[];
};
