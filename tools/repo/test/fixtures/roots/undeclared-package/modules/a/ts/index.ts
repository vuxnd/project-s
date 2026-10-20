import { readFileSync } from 'node:fs';
import leftPad from 'left-pad';

export const padded = leftPad(readFileSync('notes.txt', 'utf8'), 8);
