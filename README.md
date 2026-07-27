# chan-post-store

Ingests heterogeneous 4chan (and eventually 8chan) archive dumps into a single
local SQLite database with FTS5 full-text search, and answers questions like
"how many posts on /g/ mentioned *X* per month between 2017 and 2018".

Runs on Node 24+ with no runtime dependencies — SQLite comes from the built-in
`node:sqlite` module and `.ts` files are executed directly via type stripping.

## Layout

- `packages/cli/src/cli.ts` — CLI entry point (`ingest`, `count`, `search`, `list`)
- `packages/cli/src/db.ts` — schema + connection (`sources`, `posts`, `posts_fts`)
- `packages/cli/src/adapters/` — one ingester per source format:
  - `json-api` — 4chan read-API `{ posts: [...] }` thread dumps
  - `fuuka-sql` — mysqldumps of Fuuka/Asagi (FoolFuuka-schema) archive
    databases, streamed directly with no MySQL server
  - `warosu-sql` — the warosu.org per-board mysqldumps (original
    Perl-Fuuka 25-column schema: `parent` instead of `thread_num`/`op`,
    original filename in `media`)
- `packages/cli/src/mysqldump.ts` — shared mysqldump tuple parsing + Fuuka-family
  New-York→UTC timestamp normalization
- `packages/cli/src/manifest.ts` — reads `sources/*.json` and resolves ingest inputs
- `packages/cli/src/runner.ts` — local vs. SSH command execution for staging steps
- `packages/cli/src/archive-org.ts` — archive.org metadata API + item downloader
- `sources/` — one committed manifest per archive: provenance plus the
  adapter and path needed to ingest it (see below)
- `Memetic Sociology/` — SFTP mount of the raw archives (slow; don't
  recursively list it). Each dataset also keeps a local `manifest.json`
  so the directory is self-describing when read outside this tool.

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
    "adapter": "fuuka-sql",
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

`ingest.path` points at the source's `out/` directory: the end of the
`source` → `extracted` → `out` staging pipeline, where data is ready to
ingest. A manifest with `adapter: null`, or whose `out/` doesn't exist yet,
is reported as `pending` and exits 2 rather than failing obscurely.

For the SQL adapters the path may hold several dumps — warosu ships one per
board — and each is ingested in turn under the same source.

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

# same filters as count, but prints the matching posts (oldest first)
node packages/cli/src/cli.ts search --db data/posts.db \
  --phrase "install gentoo" --board g --from 2017-05 --limit 20

# what's in the database: post/thread counts and date spans, with a
# TOTAL row (summed counts, combined date range) when there's >1 row
node packages/cli/src/cli.ts list boards --db data/posts.db   # per site+board
node packages/cli/src/cli.ts list sites --db data/posts.db    # per site
node packages/cli/src/cli.ts list sources --db data/posts.db  # per ingested archive
```

Ingesting straight off the SFTP mount works but pays a round-trip per thread
file; for the json-api sources it's much faster to stage the extracted data on
local disk and point `ingest.path` there.

The `list sources` post count is each archive's raw contribution, so when
archives overlap its TOTAL can exceed the deduped `list sites` total.

Ingest is idempotent per source (the manifest's `source.name`): re-running
skips posts that are already stored. `count` reports the number of posts containing the phrase
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
