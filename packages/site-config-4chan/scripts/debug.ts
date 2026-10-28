import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT_PATH, BOARDS_PATH } from '../src/constants.ts';
import { formatZodError } from '../src/error.ts';
import {
  BoardSchema,
  type Board,
  type BoardEvent,
  type Citation,
} from '../src/schema.ts';
import { jsonCodec } from '../src/zod-codecs.ts';

type EventWithNote = Extract<BoardEvent, { note: string }>;

type BoardInfo = {
  filePath: string;
  notes: BoardEvent[];
  missingCitation: number;
};

type Citations = {
  citations: Citation[];
};

const citationFileContents = await fs.readFile(
  path.resolve(path.resolve(ROOT_PATH, './data/citations.json')),
  'utf-8'
);
const citations = JSON.parse(citationFileContents) as Citations;

const formatPath = (filePath: string): string => {
  return path.relative('./', filePath);
};

const printMissingCitations = (boards: BoardInfo[]): void => {
  console.log(chalk.bold('Amount of events without at least one citation:'));
  boards.forEach((board) => {
    console.log(
      `${chalk.dim(formatPath(board.filePath))}: ${board.missingCitation}`
    );
  });
};

const printNotes = (boards: BoardInfo[]): void => {
  console.log(chalk.bold('Event notes:'));
  console.group();
  boards.forEach((board) => {
    console.log(`${chalk.dim(formatPath(board.filePath))}:`);
    console.group();
    board.notes.forEach((event) => {
      console.log(
        `${chalk.blue(event.type)} - ${chalk.dim(event.datetime)}: "${event.note}"`
      );
    });
    console.groupEnd();
  });
  console.groupEnd();
};

const formatCitationInfo = (citation: Citation): string => {
  if (citation.type === 'url') {
    return `${citation.id}: ${citation.url}`;
  } else if (citation.type === 'screenshot') {
    return `${citation.id}: ${citation.file}`;
  }
  return JSON.stringify(citation);
};

const boardList = await fs.readdir(BOARDS_PATH);

const boards: BoardInfo[] = await Promise.all(
  boardList.map(async (filename) => {
    const filePath = path.resolve(BOARDS_PATH, filename);
    const contents = await fs.readFile(path.resolve(filePath), 'utf-8');

    const BoardCodec = jsonCodec(BoardSchema);
    const boardInfoResult = BoardCodec.safeParse(contents);

    if (!boardInfoResult.success) {
      console.log(`Validation error in ${chalk.bold(filename)}`);
      console.log(formatZodError(boardInfoResult.error));
      throw new Error('FATAL');
    }

    const { data: boardInfo } = boardInfoResult;

    const notes = boardInfo.events.filter(
      (event): event is EventWithNote => event.note !== undefined
    );

    const missingCitation = boardInfo.events.filter(
      (event) => event.citations?.length < 1
    ).length;

    return { filePath, notes, missingCitation };
  })
);

printMissingCitations(boards.filter((board) => board.missingCitation > 0));
printNotes(boards.filter((board) => board.notes.length > 0));
