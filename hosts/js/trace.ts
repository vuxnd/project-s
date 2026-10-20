// Types of a trace bundle (plan.md 4.7.6), shared by the trace compiler and the Node trace runner.
import type { Bundle, Json } from './runtime.ts';

export interface TraceInput { at: number; event: string; payload: Json }

export interface Expectation {
  at?: number; call?: string; params?: Json; pointer?: string; equals?: Json; near?: number; within?: number;
  by?: number; emitted?: string; count?: number;
}

export interface TraceBundle {
  trace: string;           // repo path of the source trace
  contract: string;
  implementation: string;
  ticks: number;
  bundle: Bundle;
  inputs: TraceInput[];
  expect: Expectation[];
}
