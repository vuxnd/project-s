// The build command: writes the bundle of one game for one host under build/.
import { parseArgs } from 'node:util';
import { buildBundle, bundlePath } from '../lib/bundle.ts';
import { gameComposition } from '../lib/composition.ts';
import { checkSchemas, loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { absPath, isDir } from '../lib/fsx.ts';
import { writeJson } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { error, formatProblem, hasErrors, sortProblems } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

export const summary = 'Build the bundle of one game for one host: build <game> --host <host> --root <dir>.';

// Repository-relative posix path, '.' allowed, no '..' segment.
function isRootPath(root: string): boolean {
  return root === '.' || (!/^([A-Za-z]:|\/)/.test(root) && !root.includes('\\') && !root.split('/').includes('..'));
}

export function run(args: string[], repoRoot: string): number {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { host: { type: 'string', multiple: true }, root: { type: 'string', multiple: true } }, allowPositionals: true, strict: true });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || values.host?.length !== 1 || values.root?.length !== 1) {
    console.error('build: give exactly one <game>, one --host <host> and one --root <dir>');
    return 2;
  }
  const [id] = positionals;
  const [host] = values.host;
  const [root] = values.root;
  if (!isRootPath(root) || !isDir(absPath(repoRoot, root))) {
    console.error(`no such root: ${root}`);
    return 2;
  }

  const validator = createValidator(repoRoot);
  const index = discover(repoRoot, root, validator);
  const game = index.games.get(id);
  if (game === undefined) {
    for (const problem of sortProblems(index.problems)) console.log(formatProblem(problem));
    console.error(`unknown game: ${id}`);
    return 2;
  }
  const loaded = loadRecords(index, validator);
  const problems = [...index.problems, ...checkSchemas(index, validator), ...loaded.problems];
  let written: string | undefined;
  if (!game.hosts.includes(host)) {
    problems.push(error(game.file, '/hosts', 'game-host', `${id} does not list host ${host}; it lists: ${game.hosts.join(', ')}`));
  } else if (!hasErrors(problems)) {
    const built = buildBundle({ index, records: loaded.records, composition: gameComposition(game), host, game: id, fixedHz: game.fixedHz, validator });
    problems.push(...built.problems);
    if (built.bundle !== undefined) {
      written = bundlePath(root, id, host);
      writeJson(absPath(repoRoot, written), built.bundle as unknown as Json);
    }
  }

  const sorted = sortProblems(problems);
  for (const problem of sorted) console.log(formatProblem(problem));
  if (written !== undefined) console.log(`wrote ${written}`);
  return hasErrors(sorted) ? 1 : 0;
}
