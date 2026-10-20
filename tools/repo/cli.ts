// Command-line entry: runs tools/repo/commands/<command>.ts against the repository this file lives in.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFile, listFiles } from './lib/fsx.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const commandsDir = path.join(import.meta.dirname, 'commands');

interface Command {
  summary: string;
  run(args: string[], repoRoot: string): number | Promise<number>;
}

async function loadCommand(name: string): Promise<Command> {
  return await import(pathToFileURL(path.join(commandsDir, `${name}.ts`)).href) as Command;
}

async function usage(): Promise<string> {
  const lines = ['usage: node tools/repo/cli.ts <command> [options]'];
  for (const file of listFiles(commandsDir).filter((f) => f.endsWith('.ts'))) {
    const name = file.slice(0, -'.ts'.length);
    lines.push(`${name}  ${(await loadCommand(name)).summary}`);
  }
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined) {
    console.error(await usage());
    return 2;
  }
  if (name === 'help') {
    console.log(await usage());
    return 0;
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(name) || !isFile(path.join(commandsDir, `${name}.ts`))) {
    console.error(`unknown command: ${name}`);
    console.error(await usage());
    return 2;
  }
  return await (await loadCommand(name)).run(args, repoRoot);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`internal error: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
}
