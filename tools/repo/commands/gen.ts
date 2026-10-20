// The gen command: writes types.gen.ts for the modules of each --root, or with --check lists the ones that are out of date.
import { parseArgs } from 'node:util';
import { discover } from '../lib/discover.ts';
import { absPath, isDir } from '../lib/fsx.ts';
import { checkGenerated, writeGenerated } from '../lib/gen.ts';
import { formatProblem, hasErrors, sortProblems } from '../lib/problems.ts';
import type { Problem } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

export const summary = 'Write types.gen.ts for the modules of each root; --check only reports the ones out of date.';

// Repository-relative posix path, '.' allowed, no '..' segment.
function isRootPath(root: string): boolean {
  return root === '.' || (!/^([A-Za-z]:|\/)/.test(root) && !root.includes('\\') && !root.split('/').includes('..'));
}

export function run(args: string[], repoRoot: string): number {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { root: { type: 'string', multiple: true }, check: { type: 'boolean' } }, allowPositionals: false, strict: true }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const roots = values.root ?? [];
  if (roots.length === 0) {
    console.error('gen: give at least one --root <dir>');
    return 2;
  }
  for (const root of roots) {
    if (!isRootPath(root) || !isDir(absPath(repoRoot, root))) {
      console.error(`no such root: ${root}`);
      return 2;
    }
  }

  const validator = createValidator(repoRoot);
  const problems: Problem[] = [];
  let written = 0;
  for (const root of roots) {
    const index = discover(repoRoot, root, validator);
    problems.push(...index.problems.filter((p) => p.severity === 'error'));
    if (values.check) {
      problems.push(...checkGenerated(index));
    } else {
      const result = writeGenerated(index);
      problems.push(...result.problems);
      written += result.written.length;
    }
  }
  const sorted = sortProblems(problems);
  for (const problem of sorted) console.log(formatProblem(problem));
  console.log(values.check ? `gen: ${sorted.length} problems` : `gen: wrote ${written} files`);
  return hasErrors(sorted) ? 1 : 0;
}
