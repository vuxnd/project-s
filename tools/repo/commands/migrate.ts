// The migrate command: lists the records older than their type and the files that would change; with --write it rewrites them.
import { parseArgs } from 'node:util';
import { absPath, isDir } from '../lib/fsx.ts';
import { writeText } from '../lib/json.ts';
import { planMigrations } from '../lib/migrate.ts';
import type { MigrationChange } from '../lib/migrate.ts';
import { formatProblem, hasErrors, sortProblems } from '../lib/problems.ts';
import type { Problem } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

export const summary = 'List the records older than their type and the files that would change; --write rewrites them.';

// Repository-relative posix path, '.' allowed, no '..' segment.
function isRootPath(root: string): boolean {
  return root === '.' || (!/^([A-Za-z]:|\/)/.test(root) && !root.includes('\\') && !root.split('/').includes('..'));
}

export async function run(args: string[], repoRoot: string): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { root: { type: 'string', multiple: true }, write: { type: 'boolean' } }, allowPositionals: false, strict: true }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const roots = values.root ?? [];
  if (roots.length === 0) {
    console.error('migrate: give at least one --root <dir>');
    return 2;
  }
  for (const root of roots) {
    if (!isRootPath(root) || !isDir(absPath(repoRoot, root))) {
      console.error(`no such root: ${root}`);
      return 2;
    }
  }

  const validator = createValidator(repoRoot);
  const changes: MigrationChange[] = [];
  const files = new Map<string, string>();
  const problems: Problem[] = [];
  for (const root of roots) {
    const plan = await planMigrations(repoRoot, root, validator);
    changes.push(...plan.changes);
    for (const [file, text] of plan.files) files.set(file, text);
    problems.push(...plan.problems);
  }
  const sorted = sortProblems(problems);
  for (const problem of sorted) console.log(formatProblem(problem));
  if (values.write) {
    if (hasErrors(sorted)) return 1;
    for (const [file, text] of files) writeText(absPath(repoRoot, file), text);
    console.log(`migrate: rewrote ${files.size} files`);
    return 0;
  }
  for (const change of changes) console.log(`${change.file}: ${change.type} ${change.from} -> ${change.to}`);
  console.log(`migrate: ${files.size} files would change; run npm run migrate -- --write`);
  return hasErrors(sorted) ? 1 : 0;
}
