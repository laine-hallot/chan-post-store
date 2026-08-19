# chan-post-store

Ingests heterogeneous 4chan (and eventually 8chan) archive dumps into a single
Postgres database with full-text search, and answers questions like "how many
posts on /g/ mentioned _X_ per month between 2017 and 2018".

Full-text search is a `search_vector` tsvector column on `posts`, `GENERATED
ALWAYS ... STORED` from `subject || body_text` with the `simple` config (no
stemming, no stopwords — the closest match to FTS5's old `unicode61`
tokenizer). There is no separate index table to populate: the column is
maintained by Postgres on every insert, and the only thing search needs on top
of it is the GIN index `idx_posts_search`, which lives in `QUERY_INDEXES` and
is built by `indexes build` rather than on connect. That replaced a
`posts_fts` FTS5 table when the store moved off SQLite.

Runs on Node 24+ with `.ts` files executed directly via type stripping.

## Layout

- `packages/cli/src/cli.ts` — CLI entry point (`ingest`, `count`, `search`, `list`)
- `packages/cli/src/db.ts` — schema + connection (`sources`, `posts`,
  `post_stats`), plus `QUERY_INDEXES`, the query-time indexes deliberately
  kept out of the connect-time schema
- `packages/cli/src/adapters/` — three readers, one per staged shape. Each
  reads exactly one layout; everything source-specific happens in `prepare`:
  - `sql` — `out/<board>.sql`, an Asagi post table named for its board,
    streamed directly with no MySQL server (both mysqldump and mysqlchump
    serialisations)
  - `json` — `out/<board>/posts.ndjson`, one record per line in Asagi field
    names
  - `html` — `out/<board>/<name>.html`, 4chan's own served markup
- `packages/cli/src/lines.ts` — line splitting on `\n` and nothing else.
  Node's `readline` also breaks on U+2028/U+2029/lone `\r`, which occur in
  post bodies and silently truncate records
- `packages/staging-{core,sql,html,json}` — staging helpers that source
  prepare scripts import and bundle; split by concern so a SQL source never
  pulls in an HTML parser
- `packages/site-config-4chan` — the board timeline and `boardSlugs()`
- `packages/cli/src/mysqldump.ts` — shared mysqldump tuple parsing + Fuuka-family
  New-York→UTC timestamp normalization
- `packages/cli/src/manifest.ts` — reads `sources/*.json` and resolves ingest inputs
- `packages/cli/src/runner.ts` — local vs. SSH command execution for staging steps
- `packages/cli/src/archive-org.ts` — archive.org metadata API + item downloader
- `sources/<id>/` — one npm package per archive, publishing a manifest
  (provenance plus the adapter and path needed to ingest it) and a prepare
  script that runs where the archives are. `chan.config.json` says which of
  them this checkout is working with.
- `Memetic Sociology/` — symlink to an sshfs mount of the raw archives
  (slow; don't recursively list it). Each dataset also keeps a local
  `manifest.json` so the directory is self-describing when read outside
  this tool. Mount it with the same key the runner uses:

  ```sh
  sshfs -o IdentityFile=~/.ssh/id_4chan_nas,IdentitiesOnly=yes,IdentityAgent=none,reconnect,ServerAliveInterval=15 \
    "$NAS_HOST:/path/to/share" ~/mnt/laines_data
  ```

  `IdentityAgent=none` matters — without it sshfs inherits whatever
  `~/.ssh/config` offers and authentication fails. Only `ingest` needs this
  mount; `download`, `prepare` and `list manifests` all work over SSH.

## Sources

Ingest is driven entirely by `sources/<name>.json` — no per-run metadata
flags. Manifests are committed, the archives they point at are not, so the
registry of what's in the corpus travels with the repo:

```json
{
  "source": {
    "type": "internet-archive",
    "name": "RebeccaBlackTech 4chan Archiver Backups",
    "link": "https://archive.org/details/rbt-asia",
    "short-desc": "RebeccaBlackTech's Archive of /soc/, database."
  },
  "ingest": {
    "adapter": "sql",
    "path": "Memetic Sociology/Datasets/4chan/rbt-asia/out",
    "site": "4chan"
  },
  "files": { "…": "staging paths for the download/prepare pipeline" }
}
```

`source` supplies the database's source name and link. `ingest.adapter` must
be given explicitly — the archives are all `type: internet-archive` regardless
of what format is inside, so it can't be inferred. `ingest.path` is relative to
the project root, so moving the archive storage only means repointing the
`Memetic Sociology` symlink.

`ingest.path` points at the staged tree the reader consumes — usually `out/`,
but a source that needs conversion writes elsewhere (`out-ndjson/`,
`out-native/`) and names it here. A manifest with `adapter: null`, or whose
staged tree doesn't exist yet, is reported as `pending` and exits 2 rather
than failing obscurely.

The staged layout is one file per board, so the `sql` path holds several
dumps and each is ingested in turn under the same source. That is also what a
future board filter needs: emitting a subset means simply not writing the
other files.

## Staging pipeline

Each source moves through `source` → `extracted` → `out`, all under the
manifest's `dir`. `download` fills the first stage; `prepare` produces the
rest; `ingest` reads `out`.

Prepare steps are shell commands listed in the manifest, run in order with
the dataset directory as cwd:

```json
"prepare": [
  { "name": "unzip the dump", "run": "unzip -o source/*.zip -d extracted" },
  { "name": "stage for ingest", "run": "mkdir -p out && mv extracted/*.sql out/" }
]
```

`prepare` is skipped when the output directory already exists, so it is safe
to re-run; `--force` overrides. `prepareOutput` names that directory if it
isn't `out`.

Some items bundle image and thumbnail tarballs that dwarf the text — rbt-asia
is 1.4TB of which ~36GB is the actual dumps, and 4archive is 302GB of which
4GB is the SQL. A `download.exclude` block lists regexes for files to skip:

```json
"download": { "exclude": ["-images?-", "-img-", "-thumbs?-"] }
```

`--all` downloads them anyway. Across rbt-asia, 4archive, laza and fybertech
the current patterns avoid ~1.6TB of image data.

A step prefixed with `local:` runs on this machine instead of the target,
with the same variables. That is for steps needing Node — the NAS has none —
such as `warc-extract`, which reads the WARC over SSH, decodes it here, and
writes the pages back. Steps can use `$PROJECT` (this checkout), `$CLI` (the
absolute path to cli.ts), `$DIR` (the dataset directory as the target sees
it), and `$TARGET` (the flags that
reproduce the current runner).

Because the archives live on the NAS, running these steps over the SMB mount
pays a round-trip per file operation. Commands therefore go through a runner
that is either local or an SSH connection to the NAS, so `curl`/`tar`/`7z`
execute where the disks are and the bytes never cross this machine:

```sh
cp .env.example .env                 # set NAS_HOST, NAS_ROOT, NAS_KEY
ssh-keygen -t ed25519 -f ~/.ssh/id_4chan_nas -N ''
ssh-copy-id -i ~/.ssh/id_4chan_nas.pub "$NAS_HOST"
```

A dedicated key is used rather than the ambient agent: the runner passes
`IdentitiesOnly=yes` and `IdentityAgent=none`, so auth doesn't depend on
whatever `~/.ssh/config` or a running agent happens to offer. Use the same
flags for manual `ssh` to this host, or you may land in a different account's
environment.

On Unraid specifically: sshd ignores `~/.ssh/authorized_keys` when the home
directory is group-writable, which is the default there (`chmod g-w
/home/<user>` fixes it). `/home` also lives on the RAM-backed boot filesystem,
so keys do not survive a reboot unless `/boot/config/go` recreates them.

With `.env` present, staging commands run on the NAS by default; `--local`
forces this machine and `--remote <host>` overrides the host. SSH connections
are multiplexed over one ControlMaster, so authentication and the handshake
happen once per run rather than per command.

## Usage

```sh
# what's registered and how far each source has got through the pipeline.
# The s/e/o column shows which of source/ extracted/ out/ are non-empty;
# checks run through the runner, so they report on the NAS when configured.
node packages/cli/src/cli.ts list manifests

# stage an archive.org item into <dir>/source (md5-verified, resumable);
# --dry-run lists what would be fetched, --all ignores download.exclude
node packages/cli/src/cli.ts download perma_cc_x9pp-ycvx
node packages/cli/src/cli.ts download rbt-asia --dry-run

# run the source's prepare steps, producing <dir>/out
node packages/cli/src/cli.ts prepare perma_cc_x9pp-ycvx

# all metadata comes from sources/4chan-threads.json
node packages/cli/src/cli.ts ingest 4chan-threads --db data/posts.db

# --board still narrows which boards are read out of the input
node packages/cli/src/cli.ts ingest warosu-database-backup-2023-03-15 \
  --db data/posts.db --board g --board sci

node packages/cli/src/cli.ts count --db data/posts.db \
  --phrase "install gentoo" --board g \
  --from 2017-05 --to 2018-09 --by month

# same filters as count, but prints the matching posts (oldest first).
# every match by default -- --limit truncates, it does not make the query
# cheaper, since the cost is in fetching the matching rows either way
node packages/cli/src/cli.ts search --db data/posts.db \
  --phrase "install gentoo" --board g --from 2017-05 --limit 20

# --json emits a JSON array instead, streamed, so it stays usable unlimited
node packages/cli/src/cli.ts search --db data/posts.db \
  --phrase "install gentoo" --board g --json | jq -r '.[].body_text'

# which boards exist and when their data is from, from the summary table
# (immediate); `list boards` below is the deduped-but-slow equivalent
node packages/cli/src/cli.ts boards --db data/posts.db

# rebuild that summary table — only needed for a store that predates it,
# since ingest keeps it current
node packages/cli/src/cli.ts refresh-stats --db data/posts.db

# what's in the database: post/thread counts and date spans, with a
# TOTAL row (summed counts, combined date range) when there's >1 row
node packages/cli/src/cli.ts list boards --db data/posts.db   # per site+board
node packages/cli/src/cli.ts list sites --db data/posts.db    # per site
node packages/cli/src/cli.ts list sources --db data/posts.db  # per ingested archive
```

`post_stats` caches per-(archive, board, year) counts so the questions that
would otherwise scan hundreds of millions of rows are immediate. Ingest
maintains it, so it only needs rebuilding for data loaded before it existed.
Its counts are raw per-archive contributions — `boards` can therefore
double-count a post held by two archives, where `list boards` dedupes by
scanning.

The NFS mount is for seeing which sources exist, not for working with them:
every real file operation should go through the runner over SSH so it runs on
the archive host. Reading a directory with a lot of files in it is on its own
enough to bring the NAS down — which is why the thread trees are converted to
one NDJSON file per board during `prepare` rather than walked at ingest.

The `list sources` post count is each archive's raw contribution, so when
archives overlap its TOTAL can exceed the deduped `list sites` total.

Ingest is idempotent per source (the manifest's `source.name`): re-running
skips posts that are already stored. `count` reports the number of posts
containing the phrase (a `phraseto_tsquery` match against `search_vector` —
whole-token, case-insensitive). No dedup step is needed: `posts` holds one row
per post.

### sql notes

- Asagi/Fuuka store `timestamp` shifted to America/New_York wall time
  ("4chan time"); the reader converts back to true UTC on ingest
  (verified against the UTC milliseconds embedded in `preview_orig`
  media filenames). **NDJSON is the opposite** — `timestamp` there is already
  true UTC, normalised during `prepare`.
- Ghost posts (`subnum != 0` — archive-site replies, not real 4chan
  posts) are skipped.
- Which tables hold posts is decided by the columns they declare, so Asagi
  side tables (`x_threads`, `x_images`, `x_daily`, `x_users`) and an archive's
  own administrative tables are dropped during `prepare`; `x_deleted` posts
  stage under board `x`.
- Original-Fuuka dumps (warosu, installgentoo, rbt-asia) are renamed to Asagi
  column names in the CREATE TABLE header during `prepare`. Those dumps carry
  no INSERT column list, so tuple order follows the table definition and the
  data rows are copied through untouched.

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
