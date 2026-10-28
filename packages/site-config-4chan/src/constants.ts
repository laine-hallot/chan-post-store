import fs from 'node:fs/promises';
import path from 'node:path';

export const SRC_PATH = import.meta.dirname;
export const ROOT_PATH = path.resolve(SRC_PATH, '../');
export const BOARDS_PATH = path.resolve(SRC_PATH, '../data/boards');
