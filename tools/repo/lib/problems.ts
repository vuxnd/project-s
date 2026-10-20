// The problem record every tool check reports, and how problems are printed and ordered.
import type { Rule } from './rules.ts';

export type Severity = 'error' | 'warning';

export interface Problem {
  file: string;      // repo-relative posix path; for a root-level problem, the root path
  pointer: string;   // RFC 6901 pointer into the file's JSON; '' for the whole file or a non-JSON file
  line?: number;     // 1-based; set for JSON parse errors and source-file findings
  rule: Rule;
  message: string;
  severity: Severity;
}

function make(severity: Severity, file: string, pointer: string, rule: Rule, message: string, line?: number): Problem {
  const problem: Problem = { file, pointer, rule, message, severity };
  if (line !== undefined) problem.line = line;
  return problem;
}

export function error(file: string, pointer: string, rule: Rule, message: string, line?: number): Problem {
  return make('error', file, pointer, rule, message, line);
}

export function warning(file: string, pointer: string, rule: Rule, message: string, line?: number): Problem {
  return make('warning', file, pointer, rule, message, line);
}

export function formatProblem(p: Problem): string {
  const where = p.line === undefined ? `${p.file}#${p.pointer}` : `${p.file}:${p.line}`;
  return `${p.severity === 'warning' ? 'warning: ' : ''}${where}: ${p.message} [${p.rule}]`;
}

function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortProblems(problems: readonly Problem[]): Problem[] {
  const unique = new Map<string, Problem>();
  for (const p of problems) unique.set(JSON.stringify([p.file, p.line ?? null, p.pointer, p.rule, p.message, p.severity]), p);
  return [...unique.values()].sort((a, b) =>
    compare(a.file, b.file) || compare(a.line ?? 0, b.line ?? 0) || compare(a.pointer, b.pointer) || compare(a.rule, b.rule) || compare(a.message, b.message));
}

export function hasErrors(problems: readonly Problem[]): boolean {
  return problems.some((p) => p.severity === 'error');
}
