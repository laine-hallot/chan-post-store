import { once } from 'node:events';

/**
 * Write to stdout, waiting when the pipe is full.
 *
 * `console.log` returns before the bytes are gone and queues the rest in
 * memory, which is invisible at twenty rows and is the whole problem at two
 * million: the process grows to hold output the terminal has not read yet.
 * Honouring `drain` bounds it.
 *
 * EPIPE is not an error here. `search | head` closes the pipe on purpose, and
 * the useful behaviour is to stop, not to print a stack trace over the output
 * the user asked for.
 */
export const write = async (s: string): Promise<void> => {
  if (!s) {
    return;
  }
  try {
    if (!process.stdout.write(s)) {
      await once(process.stdout, 'drain');
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') {
      process.exit(0);
    }
    throw e;
  }
};

/**
 * Abort with a message. Explicitly typed `never` so calls still end control
 * flow -- see `bad` in manifest.ts.
 *
 * No longer prints a usage banner: Optique owns usage and help now, and
 * reprinting the whole grammar after a runtime failure ("no such manifest")
 * buried the actual error.
 */
export const fail: (msg: string) => never = (msg) => {
  console.error(msg);
  process.exit(1);
};
