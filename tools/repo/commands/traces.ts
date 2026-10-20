// The traces command: compiles the traces of each --root into trace bundles under build/<root>/traces/<host>/.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { checkSchemas, loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { absPath, isDir, joinPosix } from '../lib/fsx.ts';
import { writeJson } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { formatProblem, hasErrors, sortProblems } from '../lib/problems.ts';
import type { Problem } from '../lib/problems.ts';
import { compileTraces, listTraces } from '../lib/traces.ts';
import { createValidator } from '../lib/validate.ts';

export const summary = 'Compile the traces of each root into trace bundles for each host.';

// Repository-relative posix path, '.' allowed, no '..' segment.
function isRootPath(root: string): boolean {
  return root === '.' || (!/^([A-Za-z]:|\/)/.test(root) && !root.includes('\\') && !root.split('/').includes('..'));
}

export function run(args: string[], repoRoot: string): number {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { host: { type: 'string', multiple: true }, root: { type: 'string', multiple: true } }, allowPositionals: false, strict: true }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const hosts = [...new Set(values.host ?? [])];
  const roots = values.root ?? [];
  if (hosts.length === 0 || roots.length === 0) {
    console.error('traces: give at least one --host <host> and one --root <dir>');
    return 2;
  }
  for (const host of hosts) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(host)) {
      console.error(`invalid host: ${host}`);
      return 2;
    }
  }
  for (const root of roots) {
    if (!isRootPath(root) || !isDir(absPath(repoRoot, root))) {
      console.error(`no such root: ${root}`);
      return 2;
    }
  }

  const validator = createValidator(repoRoot);
  const problems: Problem[] = [];
  let wrote = 0;
  for (const root of roots) {
    for (const host of hosts) {
      const dir = absPath(repoRoot, joinPosix('build', root, 'traces', host));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
    const index = discover(repoRoot, root, validator);
    const loaded = loadRecords(index, validator);
    const content = [...index.problems, ...checkSchemas(index, validator), ...loaded.problems];
    const listed = listTraces(index, validator);
    problems.push(...content, ...listed.problems);
    if (hasErrors(content)) continue;
    const compiled = compileTraces(index, loaded.records, listed.traces, hosts, validator);
    problems.push(...compiled.problems);
    for (const bundle of compiled.bundles) {
      writeJson(absPath(repoRoot, bundle.path), bundle.value as unknown as Json);
      wrote++;
    }
  }

  const sorted = sortProblems(problems);
  for (const problem of sorted) console.log(formatProblem(problem));
  console.log(`traces: wrote ${wrote} trace bundles`);
  return hasErrors(sorted) ? 1 : 0;
}
