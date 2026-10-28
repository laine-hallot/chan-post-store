import type { Board, Citation, SiteEvents } from './schema.ts';
import type { SiteConfig } from './types.ts';

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT_PATH } from './constants.ts';

const deSerializeTimeline = async (data: string): Promise<SiteConfig> => {
  return JSON.parse(data) as SiteConfig;
};

const stripSlashes = (slug: string): string => slug.replace(/\//g, '');

const SLUG = /^[a-z0-9]+$/;

export const boardSlugs = (siteConfig: {
  boards: readonly { id: string }[];
}): Set<string> => {
  const slugs = new Set<string>();
  for (const { id } of siteConfig.boards) {
    const bare = stripSlashes(id);
    if (SLUG.test(bare)) {
      slugs.add(bare);
    }
  }
  if (slugs.size === 0) {
    throw new Error(
      'no board ids in the site config\n' +
        '  expected {"boards":[{"id":"b","events":[...]},...]}'
    );
  }
  return slugs;
};
