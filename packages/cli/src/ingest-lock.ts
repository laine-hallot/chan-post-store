import { Result } from '@badrap/result';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';

import { PROJECT_ROOT } from './utils/paths.ts';
import { jsonCodec } from './zod-codecs.ts';

export const INGEST_LOCK_FILE = 'ingest-lock.json';

const IngestLockV0Schema = z.object({
  version: z.literal('0.0.1'),
  sources: z
    .array(
      z.object({
        name: z.string(),
        exclude: z
          .array(z.string())
          .refine(
            (exclude) => {
              const excludeSet = new Set(exclude);
              if (exclude.length !== excludeSet.size) {
                return false;
              }
              return true;
            },
            {
              error: "A source's exclude array contains duplicate entries",
            }
          )
          .transform((exclude) => {
            return new Set(exclude);
          }),
      })
    )
    .refine(
      (sources) => {
        return (
          new Set(
            sources.map((source) =>
              JSON.stringify({ ...source, exclude: Array.from(source.exclude) })
            )
          ).size === sources.length
        );
      },
      {
        error: 'Duplicate sources',
      }
    ),
});

export type IngestLockV0 = z.infer<typeof IngestLockV0Schema>;

const IngestLockV0Codec = jsonCodec(IngestLockV0Schema);

/**
 * Union type of all major ingest lock schema versions
 */
export type IngestLock = IngestLockV0;

export type IngestLockCurrent = IngestLockV0;

const hasLock = async (): Promise<Result<boolean>> => {
  return await stat(join(PROJECT_ROOT, INGEST_LOCK_FILE))
    .then((stat) => Result.ok(stat.isFile()))
    .catch((error) => Result.err(error));
};

export const readIngestLock = async (): Promise<
  Result<IngestLock, Error | z.ZodError<IngestLock>>
> => {
  return await readFile(join(PROJECT_ROOT, INGEST_LOCK_FILE), {
    encoding: 'utf-8',
  })
    .then((file) => {
      const lockSchema = IngestLockV0Codec.safeParse(file);
      if (!lockSchema.success) {
        return Result.err(lockSchema.error);
      }
      return Result.ok(lockSchema.data);
    })
    .catch((error) => Result.err(error));
};

export const writeIngestLock = async (
  lock: IngestLockCurrent
): Promise<Result<void>> => {
  return await writeFile(
    join(PROJECT_ROOT, INGEST_LOCK_FILE),
    JSON.stringify(
      {
        ...lock,
        sources: lock.sources.map((source) => ({
          ...source,
          exclude: Array.from(source.exclude),
        })),
      },
      null,
      2
    )
  )
    .then(() => Result.ok(undefined))
    .catch((error) => Result.err(error));
};

export const addSourceToIngestLock = async (source: {
  name: string;
  exclude: Set<string>;
}): Promise<Result<void>> => {
  const ingestLockResult = await readIngestLock();
  if (ingestLockResult.isErr) {
    return Result.err(ingestLockResult.error);
  }
  const ingestLock = ingestLockResult.value;

  ingestLock.sources.push(source);

  return await writeIngestLock(ingestLock);
};

export const existsInIngestLock = async (
  sourceName: string,
  exclude: Set<string>
): Promise<Result<boolean, Error | z.ZodError<IngestLock>>> => {
  return await readFile(join(PROJECT_ROOT, INGEST_LOCK_FILE), {
    encoding: 'utf-8',
  })
    .then((file) => {
      const lockSchema = IngestLockV0Codec.safeParse(file);
      if (!lockSchema.success) {
        return Result.err(lockSchema.error);
      }
      return Result.ok(
        lockSchema.data.sources.some((source) => {
          return (
            source.name === sourceName &&
            source.exclude.difference(exclude).size === 0
          );
        })
      );
    })
    .catch((error) => Result.err(error));
};
