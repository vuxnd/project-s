// Runs every checker over one repository root and returns all problems, sorted (plan.md 4.8.12).
import { buildBundle } from './bundle.ts';
import { gameComposition } from './composition.ts';
import { checkConfigDefaults } from './config.ts';
import { checkMigrationFiles, checkSchemas, loadRecords } from './content.ts';
import { discover } from './discover.ts';
import { checkGenerated } from './gen.ts';
import { checkImports } from './imports.ts';
import { sortProblems } from './problems.ts';
import type { Problem } from './problems.ts';
import { compileTraces, listTraces } from './traces.ts';
import type { Validator } from './validate.ts';

export interface CheckOptions { generated?: boolean }   // default true: include [gen-stale]

export function checkRoot(repoRoot: string, root: string, validator: Validator, options: CheckOptions = {}): Problem[] {
  const index = discover(repoRoot, root, validator);
  if (index.problems.some((p) => p.rule === 'root-missing')) return sortProblems(index.problems);
  const loaded = loadRecords(index, validator);
  const problems = [...index.problems, ...checkSchemas(index, validator), ...loaded.problems, ...checkMigrationFiles(index), ...checkConfigDefaults(index, validator)];
  for (const game of index.games.values()) {
    for (const host of game.hosts) {
      problems.push(...buildBundle({ index, records: loaded.records, composition: gameComposition(game), host, game: game.id, fixedHz: game.fixedHz, validator }).problems);
    }
  }
  for (const m of index.modules.values()) problems.push(...checkImports(index, m));
  const listed = listTraces(index, validator);
  problems.push(...listed.problems, ...compileTraces(index, loaded.records, listed.traces, 'all', validator).problems);
  if (options.generated !== false) problems.push(...checkGenerated(index));
  return sortProblems(problems);
}
