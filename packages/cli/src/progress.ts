import { progress, spinner } from "@clack/prompts";

/**
 * A progress display that cannot starve the work it reports on.
 *
 * clack redraws on its own timer and spends ~11 write syscalls per frame.
 * Node's writes to a TTY are *synchronous* on Linux, so at clack's default
 * cadence (~12 frames/sec, ~136 writes/sec) a terminal that cannot keep up
 * applies backpressure directly into the event loop. Measured on the Warosu
 * ingest: the process wrote 738KB to the terminal while reading 86KB from the
 * archive in the same 30s, sat at 110% CPU with Postgres idle 88% of the time,
 * and managed 10 MB/hour -- against 23,345 MB/hour for the identical code and
 * file with output redirected. A 2300x penalty, paid entirely for a cosmetic
 * bar. Hence two guards:
 *
 *   - render at FRAME_MS rather than clack's default, cutting frames ~6x; and
 *   - render nothing when stderr is not a terminal (`> file`, a pipe, CI),
 *     where the redraw frames are unreadable noise anyway. That path instead
 *     emits a plain heartbeat line at HEARTBEAT_MS so a redirected log still
 *     shows the run is alive.
 */
const FRAME_MS = 500;
const HEARTBEAT_MS = 30_000;

/** The subset of clack's bar/spinner surface the adapters actually use. */
export interface Bar {
  start(msg?: string): void;
  message(msg?: string): void;
  /** `step` is bytes/pages consumed; ignored when there is no known total. */
  advance(step: number, msg?: string): void;
  stop(msg?: string): void;
}

/** Non-TTY: no redraws at all, just an occasional line so a log shows life. */
const quietBar = (): Bar => {
  let last = Date.now();
  const tick = (msg?: string): void => {
    if (!msg) return;
    const now = Date.now();
    if (now - last < HEARTBEAT_MS) return;
    last = now;
    console.error(msg);
  };
  return {
    start: (msg): void => {
      if (msg) console.error(msg);
      last = Date.now();
    },
    message: tick,
    advance: (_step, msg): void => tick(msg),
    stop: (msg): void => {
      if (msg) console.error(msg);
    },
  };
};

/**
 * A bar when `max` is known (byte- or page-counted), a spinner otherwise.
 * Either way the caller drives it with the same three calls, so adapters
 * don't branch on whether a total was available.
 */
export const makeBar = (opts: { max?: number; size?: number }): Bar => {
  if (!process.stderr.isTTY) return quietBar();

  if (opts.max != null) {
    const b = progress({
      max: opts.max,
      size: opts.size ?? 30,
      output: process.stderr,
      delay: FRAME_MS,
    });
    return {
      start: (msg) => b.start(msg),
      message: (msg) => b.message(msg),
      advance: (step, msg) => b.advance(step, msg),
      stop: (msg) => b.stop(msg),
    };
  }

  const s = spinner({ output: process.stderr, delay: FRAME_MS });
  return {
    start: (msg) => s.start(msg),
    message: (msg) => s.message(msg),
    advance: (_step, msg) => s.message(msg),
    stop: (msg) => s.stop(msg),
  };
};
