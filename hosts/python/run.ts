// Runs its arguments under the first usable Python 3.11 or newer, or reports that there is none.
import { spawnSync } from 'node:child_process';

interface Python { cmd: string; pre: string[] }

const CANDIDATES: Python[] = [
  { cmd: 'python3', pre: [] },
  { cmd: 'python', pre: [] },
  { cmd: 'py', pre: ['-3'] },
];
const PROBE = 'import sys; print("%d.%d" % sys.version_info[:2])';

export function findPython(spawn: typeof spawnSync): Python | null {
  for (const { cmd, pre } of CANDIDATES) {
    const probe = spawn(cmd, [...pre, '-I', '-c', PROBE], { encoding: 'utf8' });
    const version = probe.status === 0 ? /^(\d+)\.(\d+)$/.exec(String(probe.stdout).trim()) : null;
    if (version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 11))) {
      return { cmd, pre };
    }
  }
  return null;
}

function main(args: string[]): number {
  const python = findPython(spawnSync);
  if (python === null) {
    if ((process.env.REQUIRE_HOSTS ?? '').split(',').map((host) => host.trim()).includes('python')) {
      console.error('python 3.11+ not found; REQUIRE_HOSTS requires it');
      return 1;
    }
    console.log('SKIPPED python (not found)');
    return 0;
  }
  return spawnSync(python.cmd, [...python.pre, '-I', '-B', ...args], { stdio: 'inherit' }).status ?? 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
