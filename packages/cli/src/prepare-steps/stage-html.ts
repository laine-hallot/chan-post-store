/**
 * Stages 4chan's own markup into the standard `out/<board>/<name>.html`
 * layout, leaving every other markup family behind for `html-to-ndjson`.
 *
 * Two jobs that used to live in the ingest adapter and belong here instead:
 *
 *   1. **Selecting native pages.** A crawl can mix markup families in one
 *      directory -- fybertech's 638 thread pages are 420 classic Futaba, 190
 *      in its own later template and 20 in 4chan's own; the yotsubasociety
 *      mirror is ~85%/~10%. The two readers used to run over the same tree
 *      and skip each other's files. Splitting the tree in `prepare` instead
 *      means neither reader needs to know the other exists.
 *   2. **Deriving board and thread from the filename.** Archives name saved
 *      pages half a dozen ways; the reader should not have to know any of
 *      them. Once staged, the directory names the board and the filename
 *      names the thread.
 *
 * Filename rules, applied in order:
 *
 * | staged name                                  | board | file          |
 * | -------------------------------------------- | ----- | ------------- |
 * | `boards.4chan.org_a_thread_231722770.html`   | `a`   | `231722770.html` |
 * | `boards.4chan.org_pol.html` (a board index)  | `pol` | `index.html`  |
 * | `<board>/<anything>` (already nested)        | dir   | unchanged     |
 * | `co_65683092.html` (third-party mirror)      | `co`  | `65683092.html` |
 *
 * A name that matches none of these is reported, not dropped silently.
 *
 * **Names are not always normalised to `<threadno>.html`, deliberately.**
 * 4chan-vp-2015-threads stages `<date>_<threadno>.html` because the same
 * thread was captured on consecutive days, and collapsing the captures to one
 * name would keep only one of them. The reader treats a digits-only filename
 * as asserting the thread number and anything else as deferring to the
 * markup, so multi-capture names still resolve correctly -- each page's own
 * OP supplies the thread. That is also why this step preserves an existing
 * nested layout rather than renaming inside it.
 *
 * Runs as a generated script through the runner, like sql-normalize: the
 * yotsubasociety mirror is 23,295 pages, and walking it from this process
 * would mean readdir over the NFS mount, which is exactly what that mount
 * cannot take.
 */

import type { Runner } from '../runner.ts';

import { Result } from '@badrap/result';

import { shQuote } from '../runner.ts';

export interface StageHtmlStep {
  /** Tree to scan, relative to the dataset dir. */
  from: string;
  /** Directory to build, relative to the dataset dir. */
  to: string;
}

/**
 * The shell program, as text. Exported so the filename rules can be exercised
 * on a fixture without a NAS to run it against.
 */
export const buildStageHtmlScript = (from: string, to: string): string => `
set -e
FROM=${shQuote(from)}
TO=${shQuote(to)}
rm -rf "$TO"
mkdir -p "$TO"

# One grep pass over the tree, not a test per file: on the 23,295-page mirror
# the per-file form is 23,295 process spawns.
LIST=$(mktemp)
grep -rl --include='*.htm' --include='*.html' -F 'postContainer' "$FROM" > "$LIST" || true

staged=0
unmatched=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  base=\${f##*/}
  dir=\${f%/*}
  board=''
  name=''
  case "$base" in
    boards.4chan.org_*_thread_*|boards.4channel.org_*_thread_*)
      rest=\${base#boards.4chan*.org_}
      board=\${rest%%_thread_*}
      num=\${rest#*_thread_}
      name=\${num%%[!0-9]*}.html
      ;;
    boards.4chan.org_*|boards.4channel.org_*)
      rest=\${base#boards.4chan*.org_}
      board=\${rest%%[!a-zA-Z0-9]*}
      # A board index names no single thread; the reader reads the thread of
      # each OP from the markup.
      name=index.html
      ;;
    *)
      if [ "$dir" != "$FROM" ]; then
        # Already nested under its board; keep the name as it stands.
        board=\${dir##*/}
        name=$base
      else
        case "$base" in
          *_*)
            board=\${base%%_*}
            name=\${base#*_}
            ;;
        esac
      fi
      ;;
  esac
  if [ -z "$board" ] || [ -z "$name" ]; then
    unmatched=$((unmatched+1))
    echo "    unmatched filename: $f" >&2
    continue
  fi
  mkdir -p "$TO/$board"
  cp -al "$f" "$TO/$board/$name" 2>/dev/null || cp -a "$f" "$TO/$board/$name"
  staged=$((staged+1))
done < "$LIST"
rm -f "$LIST"

if [ "$unmatched" -gt 0 ]; then
  echo "    $unmatched page(s) had no recognisable board/thread name" >&2
fi
# A silent zero looks exactly like a source with nothing native in it, which
# is a thing that can legitimately happen -- so say so rather than imply it.
echo "    staged $staged native page(s) into $TO"
`;

/** Runs the staging on whichever machine holds the archives. */
export const runStageHtml = async (
  runner: Runner,
  dir: string,
  step: StageHtmlStep,
  stepName: string
): Promise<Result<number, Error>> => {
  const scriptPath = `${dir}/.stage-html.sh`;
  const w = await runner.writeFile(
    scriptPath,
    Buffer.from(buildStageHtmlScript(step.from, step.to), 'utf8')
  );
  if (w.isErr) {
    return Result.err(
      new Error(`prepare step "${stepName}": ${w.error.message}`)
    );
  }
  const r = await runner.exec(`sh ${shQuote(scriptPath)}`, {
    cwd: dir,
    inherit: true,
  });
  await runner.exec(`rm -f ${shQuote(scriptPath)}`, { cwd: dir });
  if (r.code !== 0) {
    return Result.err(
      new Error(
        `prepare step "${stepName}": staging failed (exit ${r.code})` +
          (r.stderr.trim() ? `\n  ${r.stderr.trim()}` : '')
      )
    );
  }
  const c = await runner.exec(
    `find ${shQuote(`${dir}/${step.to}`)} -type f | wc -l`,
    { cwd: dir }
  );
  return Result.ok(Number(c.stdout.trim()) || 0);
};
