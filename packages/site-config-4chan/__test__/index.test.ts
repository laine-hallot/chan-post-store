import chalk from 'chalk/index.js';
import test from 'node:test';
import path from 'path';

import { BOARDS_PATH } from '../src/constants.ts';
import { BoardSchema } from '../src/schema.ts';
import { jsonCodec } from '../src/zod-codecs.ts';

test('are board json files valid', async (t) => {
  const boardList = await fs.readdir(BOARDS_PATH);

  const boards: BoardInfo[] = await Promise.all(
    boardList.map(async (filename) => {
      const filePath = path.resolve(BOARDS_PATH, filename);
      const contents = await fs.readFile(path.resolve(filePath), 'utf-8');

      const BoardCodec = jsonCodec(BoardSchema);
      const boardInfoResult = BoardCodec.safeParse(contents);

      if (!boardInfoResult.success) {
        console.log(`Validation error in ${chalk.bold(filename)}`);

        throw new Error('FATAL');
      }

      assert.strictEqual();
    })
  );
});
