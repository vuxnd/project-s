// The check command: runs every checker over each --root and prints the problems found.
import { parseArgs } from 'node:util';
import { checkRoot } from '../lib/check.ts';
import { absPath, isDir } from '../lib/fsx.ts';
import { formatProblem, sortProblems } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

export const summary = 'Run every check over each root and print the problems.';

// Repository-relative posix path, '.' allowed, no '..' segment.
function isRootPath(root: string): boolean {
  return root === '.' || (!/^([A-Za-z]:|\/)/.test(root) && !root.includes('\\') && !root.split('/').includes('..'));
}

export function run(args: string[], repoRoot: string): number {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { root: { type: 'string', multiple: true } }, allowPositionals: false, strict: true }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const roots = values.root ?? [];
  if (roots.length === 0) {
    console.error('check: give at least one --root <dir>');
    return 2;
  }
  for (const root of roots) {
    if (!isRootPath(root) || !isDir(absPath(repoRoot, root))) {
      console.error(`no such root: ${root}`);
      return 2;
    }
  }

  const validator = createValidator(repoRoot);
  const problems = sortProblems(roots.flatMap((root) => checkRoot(repoRoot, root, validator)));
  for (const problem of problems) console.log(formatProblem(problem));
  const errors = problems.filter((p) => p.severity === 'error').length;
  console.log(`check: ${errors} errors, ${problems.length - errors} warnings in ${roots.length} roots`);
  return errors > 0 ? 1 : 0;
}
