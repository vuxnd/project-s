# Project S

Engine-neutral game foundation. Games are built from module folders and compositions described by JSON files; one Node tool checks them and compiles each game into a bundle that small runtimes for Node, the browser and Python run. ARCHITECTURE.md describes the design.

## Prerequisites

- Node.js 24.12 or newer, as `devEngines` in `package.json` requires.
- Python 3.11 or newer, for the Python host. Without it, `npm test` prints `SKIPPED python (not found)` and skips the Python steps. With `REQUIRE_HOSTS=python` in the environment, as CI sets it, a missing Python fails the run.
- git.

## Setup

```sh
npm ci
npm test
```

`npm ci` installs the three pinned development packages from `package-lock.json`. `npm test` runs every check; the last line it prints is `docs: <p> paths, <c> commands checked, 0 failures` when all pass.

## Commands

| Command | What it does |
|---|---|
| `npm test` | the repository check, type checks, unit tests, traces on Node and Python, and the documentation check |
| `npm run check` | every repository check over the roots `.`, `examples` and `hosts/conformance` |
| `npm run gen` | writes `types.gen.ts` for every module; `npm run gen -- --check` only compares |
| `npm run build -- <game> --host <host> --root <root>` | writes `build/<root>/games/<game>/<host>/bundle.json` |
| `npm run migrate` | lists records older than their type; `npm run migrate -- --write` rewrites them |
| `npm run serve` | serves the repository for the web host on port 8080 |
| `node tools/repo/cli.ts help` | lists the tool's commands |
| `node tools/repo/cli.ts traces --host <host> --root <root>` | compiles a root's traces into trace bundles |
| `node hosts/js/conformance.ts <dir>...` | runs trace bundles on Node |
| `node hosts/python/run.ts hosts/python/conformance.py <dir>...` | runs trace bundles on Python |

## Run the example game

```sh
npm run build -- sandbox --host web --root examples
npm run serve
```

Then open `http://127.0.0.1:8080/hosts/js/web/index.html?root=examples&game=sandbox`. Two crates and a plank fall and stack, each first contact plays a tone, and a click on the canvas drops another crate.

## Tree

```text
.github/workflows/ci.yml   CI: npm ci, then npm test
schemas/                   JSON Schemas of manifests, games, bundles and traces
tools/repo/                the repository tool (cli.ts, commands/, lib/), its tests and fixture roots, docs.ts
hosts/js/                  JavaScript runtime and Node trace runner; web/ holds the browser host
hosts/python/              Python runtime, trace runner and bundle player
hosts/conformance/         the probe contract, whose traces test the runtime rules on node and python
examples/                  example modules and the sandbox game
modules/                   the game's modules
games/                     the game's compositions
build/                     bundles and trace bundles written by the tool (ignored)
```

## Where to start

- ARCHITECTURE.md: the design, the contracts C1 to C10 and how to extend the repository.
- `examples/games/sandbox/game.json` and the modules it lists in `examples/modules/`: a complete small game.
- `hosts/conformance/modules/probe/`: what every runtime must do, written as traces.
- `tools/repo/lib/rules.ts`: every problem the tool reports, with its meaning.
