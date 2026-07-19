# chan-post-store

Ingests heterogeneous 4chan (and eventually 8chan) archive dumps into a single
local SQLite database with FTS5 full-text search, and answers questions like
"how many posts on /g/ mentioned *X* per month between 2017 and 2018".

Runs on Node 24+ with no runtime dependencies — SQLite comes from the built-in
`node:sqlite` module and `.ts` files are executed directly via type stripping.

## Layout

- `src/cli.ts` — CLI entry point (`ingest`, `count`)
- `src/db.ts` — schema + connection (`sources`, `posts`, `posts_fts`)
- `src/adapters/` — one ingester per source format:
  - `json-api` — 4chan read-API `{ posts: [...] }` thread dumps
  - `fuuka-sql` — mysqldumps of Fuuka/Asagi (FoolFuuka-schema) archive
    databases, streamed directly with no MySQL server
- `Memetic Sociology/` — SFTP mount of the raw archives (slow; don't
  recursively list it). Each dataset has a `manifest.json` describing its
  origin and extract paths.

## Usage

```sh
# stage a dataset on local disk first — ingesting straight off the SFTP
# mount works but pays a round-trip per thread file
7z x -o/fast/disk/4chan-threads "Memetic Sociology/Datasets/4chan/4chan threads/4chan threads.7z"

node src/cli.ts ingest json-api \
  --db data/posts.db \
  --root "/fast/disk/4chan-threads/4chan threads" \
  --source 4chan-threads-2017-2018 \
  --link https://archive.org/details/4chanThreads_201809

# the Fuuka SQL dump streams straight off the mount (one sequential pass);
# --board limits which board tables get ingested
node src/cli.ts ingest fuuka-sql \
  --db data/posts.db \
  --file "Memetic Sociology/Datasets/4chan/laza-4chan-archive/extracted/tables.sql" \
  --source laza-fuuka \
  --link https://archive.org/details/laza-4chan-archive

node src/cli.ts count --db data/posts.db \
  --phrase "install gentoo" --board g \
  --from 2017-05 --to 2018-09 --by month
```

Ingest is idempotent per source (`--source` name): re-running skips posts that
are already stored. `count` reports the number of posts containing the phrase
(FTS5 phrase match — whole-token, case-insensitive), deduplicated across
overlapping archive sources by `(board, post_no)`.

### fuuka-sql notes

- Asagi/Fuuka store `timestamp` shifted to America/New_York wall time
  ("4chan time"); the adapter converts back to true UTC on ingest
  (verified against the UTC milliseconds embedded in `preview_orig`
  media filenames).
- Ghost posts (`subnum != 0` — archive-site replies, not real 4chan
  posts) are skipped.
- Asagi side tables (`x_threads`, `x_images`, `x_daily`, `x_users`) are
  recognized by their columns and skipped; `x_deleted` posts ingest under
  board `x`.

## Format families still to wire up

1. **HTML scrapes** (yotsubasociety, hentai collection, fybertech WARC) —
   era-specific parsers, best effort.
2. **8chan webroot tar** (`8chan_20150110.tar.zstd`) — vichan install dump;
   likely contains per-thread JSON alongside the HTML.

## Dev

```sh
npm install        # typescript + @types/node only
npm run typecheck
```
