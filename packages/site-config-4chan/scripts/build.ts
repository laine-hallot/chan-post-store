import type { SiteEvents, Citation, Board } from '../src/schema.ts';
import type { SiteConfig } from '../src/types.ts';

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { BOARDS_PATH, ROOT_PATH } from '../src/constants.ts';

const siteEvents = JSON.parse(
  await fs.readFile(
    path.resolve(path.resolve(ROOT_PATH, './data/site-events.json')),
    'utf-8'
  )
) as SiteEvents;

const citations = JSON.parse(
  await fs.readFile(
    path.resolve(path.resolve(ROOT_PATH, './data/citations.json')),
    'utf-8'
  )
) as {
  citations: Citation[];
};

const boardList = await fs.readdir(BOARDS_PATH);

const boards: Board[] = await Promise.all(
  boardList.map(async (filename) => {
    const filePath = path.resolve(BOARDS_PATH, filename);
    const contents = await fs.readFile(path.resolve(filePath), 'utf-8');
    return JSON.parse(contents) as Board;
  })
);

const siteConfig: SiteConfig = {
  siteEvents,
  boards,
  ...citations,
};

const DIST_PATH = path.resolve(ROOT_PATH, './dist');
if (!fsSync.existsSync(DIST_PATH)) {
  await fs.mkdir(DIST_PATH);
}

await fs.writeFile(
  path.resolve(DIST_PATH, 'site-config.json'),
  JSON.stringify(siteConfig, null, 2)
);
