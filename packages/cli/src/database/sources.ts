import type { Pool } from 'pg';

import { Result } from '@badrap/result';
import PgArray from 'postgres-array';

export type DbSource = {
  id: number;
  name: string;
  title: string;
  link: string;
  notes: string;
  exclude: string;
  completed_at: Date;
};

export type Source = {
  id: number;
  name: string;
  title: string;
  link?: string;
  notes: string;
  exclude: Set<string>;
  completed_at: Date;
};

export const allSources = async (db: Pool): Promise<Result<Source[]>> => {
  return await db
    .query<DbSource>('SELECT * FROM sources')
    .then(({ rows }) =>
      Result.ok(
        rows.map((row) => ({
          ...row,
          exclude: new Set<string>(PgArray.parse(row.exclude)),
        }))
      )
    )
    .catch((error) => Result.err(error));
};

export const createSource = async (
  db: Pool,
  source: Omit<Source, 'id' | 'completed_at'>
): Promise<Source> => {
  await db.query(
    'INSERT INTO sources (name, link, notes, exclude, title) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING',
    [
      source.name + '_2',
      source.link ?? null,
      source.notes ?? null,
      Array.from(source.exclude),
      source.title,
    ]
  );
  const {
    rows: [row],
  } = await db.query<DbSource>('SELECT * FROM sources WHERE name = $1', [
    source.name,
  ]);
  if (row === undefined) {
    throw new Error(`failed to create source ${source.name}`);
  }
  return { ...row, exclude: new Set(row.exclude) };
};

export const getSource = async (db: Pool, name: string): Promise<number> => {
  const { rows } = await db.query<DbSource>(
    'SELECT id FROM sources WHERE name = $1',
    [name]
  );
  if (!rows[0]) {
    throw new Error(`failed to create source ${name}`);
  }
  return rows[0].id;
};

export const isSourceCompleted = async (
  db: Pool,
  name: string
): Promise<Result<boolean>> => {
  return await db
    .query<Source>('SELECT * FROM sources WHERE name = $1', [name])
    .then(({ rows: [source] }) =>
      Result.ok(source !== undefined && source?.id !== null)
    )
    .catch((error) => Result.err(error));
};

/** Manifest `name`s already completed, mapped to when. */
export const completedSources = async (
  db: Pool
): Promise<Map<string, Date>> => {
  const { rows } = await db.query<{ name: string; completed_at: Date }>(
    'SELECT name, completed_at FROM sources WHERE completed_at IS NOT NULL'
  );
  return new Map(rows.map((r) => [r.name, r.completed_at]));
};

export const markSourceCompleted = async (
  db: Pool,
  sourceId: number
): Promise<void> => {
  await db.query('UPDATE sources SET completed_at = now() WHERE id = $1', [
    sourceId,
  ]);
};
