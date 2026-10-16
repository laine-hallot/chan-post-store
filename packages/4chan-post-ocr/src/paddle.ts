import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { looksLikeHeader, readHeader, type HeaderRead } from './header.ts';

/**
 * PaddleOCR, through `paddle/ocr.py` and the flake's `paddle-python`
 * wrapper.
 *
 * Every screenshot goes through ONE Python process: loading the detection
 * and recognition models is most of the cost of a small batch, and the GPU
 * is one device anyway, so there is nothing to gain from a process per
 * image.
 */

const SCRIPT = fileURLToPath(new URL('../paddle/ocr.py', import.meta.url));

/** In the original image's pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaddleLine {
  text: string;
  /** 0-1. */
  score: number;
  box: Box;
}

/** A header-shaped line, and what it reads as if it reads at all. */
export interface FoundHeader extends PaddleLine {
  read: HeaderRead | null;
}

/** Paddle's text lines for each image, keyed by the path it was given. */
export const paddleLines = (
  paths: string[]
): Promise<Map<string, PaddleLine[]>> =>
  new Promise((resolve, reject) => {
    // PADDLE_PYTHON swaps the interpreter wrapper, e.g. to compare the CPU
    // and CUDA builds without leaving one dev shell.
    const child = spawn(
      process.env.PADDLE_PYTHON ?? 'paddle-python',
      [SCRIPT, ...paths],
      {
        // Paddle's model-loading chatter and warnings go to our stderr as
        // they happen; stdout is the results and nothing else.
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`paddle-python exited ${code}`));
        return;
      }
      const results = new Map<string, PaddleLine[]>();
      for (const line of out.split('\n')) {
        if (!line.startsWith('{')) {
          continue;
        }
        const r = JSON.parse(line) as {
          image: string;
          lines: { text: string; score: number; box: number[] }[];
        };
        results.set(
          r.image,
          r.lines.map((l) => ({
            text: l.text,
            score: l.score,
            box: {
              left: l.box[0]!,
              top: l.box[1]!,
              width: l.box[2]!,
              height: l.box[3]!,
            },
          }))
        );
      }
      resolve(results);
    });
  });

/**
 * The header-shaped lines among Paddle's, each with what it spells out.
 * Paddle reads each detected line once, so that one read is the answer.
 */
export const findHeaders = (lines: PaddleLine[]): FoundHeader[] =>
  lines
    .filter((l) => looksLikeHeader(l.text))
    .map((l) => ({ ...l, read: readHeader(l.text) }));
