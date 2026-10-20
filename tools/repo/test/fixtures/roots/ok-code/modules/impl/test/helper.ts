import assert from 'node:assert/strict';
import type { State } from '../types.gen.ts';

// Checks what every test of this module expects of its state.
export function assertConsistent(state: State): void {
  assert.ok(state.calls >= Object.keys(state.seen).length);
}
