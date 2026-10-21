# Architecture Overview

Project S is an engine-neutral game foundation. Games are module folders and JSON compositions; one Node tool checks them and compiles each game, per host, into one bundle that a small runtime executes. Labels: C1 to C10 are the contracts (sections 3 and 4), R1 to R22 the runtime rules of C5, `[rule-id]` a problem the tool reports (`tools/repo/lib/rules.ts`).

## 1. Project Structure

```text
schemas/              contract schemas (C1, C2, C4, C6)
tools/repo/           the tool: cli.ts, commands/, lib/
tools/voxel/          the voxel preview renderer: PNGs from Node, a turnable browser viewer under web/, without dependencies; browser.ts checks the viewer in headless Chromium
hosts/js/             runtime.ts (C5), trace runner; web/ is the browser host
hosts/python/         runtime.py, trace runner, bundle player
hosts/conformance/    root: the probe contract; its traces test C5
examples/             root: example modules and the sandbox game
modules/  games/      root .: the game's own modules and compositions
<root>/modules/<id>/module.json                    manifest (C1); types.gen.ts beside it (C9)
<root>/modules/<id>/schemas/<name>.schema.json       type, event, operation, state, config (C8)
<root>/modules/<id>/content/<type id>/<name>.json  records (C3); assets/ for x-asset files
<root>/modules/<id>/conformance/  migrations/      traces (C6), contracts only; migration steps
<root>/modules/<id>/ts/  web/  python/  test/      code per host; unit tests
<root>/games/<id>/game.json                        composition (C2)
```

## 2. High-Level System Diagram

```text
authoring (manifests, games, schemas, records, traces, code)
  --> tool: check, gen, build --> bundle per game and host --> runtime per host: node, web, python
traces --> trace bundles --> runners: PASS or FAIL per trace
```
- Every feature is a module folder; one Node tool resolves each game at build time into one deterministic bundle per host, the only file a host reads.
- A small runtime per host runs the bundle; traces test every implementation on node and python.
- Modules talk only through records, config, events and synchronous operations, all schema-described; state is private.
- Versions exist only where a consumer can lag behind the code: records and the bundle format. Work not needed now waits behind a named seam and a trigger (section 9).
- Locked in: Node 24.12 or newer, JavaScript semantics for module code on JavaScript hosts. Open: engines, renderer, platforms, CI vendor.

## 3. Core Components

| Component | Responsibility | Technology | Runs on |
|---|---|---|---|
| Tool, `tools/repo/` | checks, generates types, builds, migrates | TypeScript, Ajv | Node, in CI and locally |
| JavaScript runtime, `hosts/js/` | C5 runtime, trace runner, browser host, dev server | TypeScript | Node; browser |
| Python runtime, `hosts/python/` | C5 runtime, trace runner, bundle player | Python | Python |
| Probe, `hosts/conformance/` | the contract and implementations that test C5 | JSON traces, code per host | node, python |
| Modules and games, `modules/`, `games/`, `examples/` | the game's modules and compositions; examples | JSON, code per host | the hosts a module lists |

| Interface | Fixes | Defined by |
|---|---|---|
| C5 | runtime: `load` yields `tick`, `frame`, `call`, `snapshot`; a module entry exports an optional `init(ctx)` that returns its state, one function per system and an `operations` object; R1 to R22 | `hosts/js/runtime.ts` |
| C10 | tool CLI: exit codes, problem format, rule ids, npm scripts | `tools/repo/cli.ts`, `tools/repo/lib/rules.ts` |

Module shapes: contract (`contract: true`; types, events, operations, traces), implementation (`implements`; one per contract in a game), feature (`requires`, `optional`), content pack (records only), presentation (frame systems).

| Channel | Used with | Timing |
|---|---|---|
| Records, config | `ctx.records`, `ctx.config`, `ctx.configOf` | fixed at build |
| Events | `ctx.emit`, `ctx.events` | delivered once to each loop at its next run |
| Operations | `ctx.call` | synchronous, in the provider |

- Same-tick questions, such as a ray cast, are operations; notifications are events.
- Code sees itself, what it implements, its `requires` and the `optional` ids the game selects; data (`$ref`, `x-ref`) sees only itself, `implements` and `requires`; nothing is transitive; a module sees only its own root. The build, the bundle's `sees` and `absent` and the generated types enforce this.
- Module code imports only files in its own folder and packages listed in `packages`; the import scan enforces this.
- A module extends another's data with its own record type holding an `x-ref`. Module code keeps no module-level mutable state and no clock or random source; frame systems emit only discrete events.
- `build` resolves the closure, one provider per contract, load order, schedules, config (RFC 7396).
- The web host runs capped ticks from a time accumulator, then one frame run; it passes no inputs to `tick`. Input reaches the fixed loop as an event a frame system emits, read in the next tick.

## 4. Data Stores

No database: the data is JSON on disk, authored under each root. The tool writes bundles under `build/` and `types.gen.ts` beside each manifest, committed.

| Label | Fixes | Defined by |
|---|---|---|
| C1 | module manifest | `schemas/module.schema.json` |
| C2 | game composition | `schemas/game.schema.json` |
| C3 | record files: `$version`, `x-ref`, `x-asset` | each type's schema |
| C4 | bundle: all a host needs, deterministic | `schemas/bundle.schema.json` |
| C6 | trace and trace bundle | `schemas/trace.schema.json`, `schemas/trace-bundle.schema.json` |
| C7 | ids, paths, numbers: snake-case names, string ids, posix paths | `schemas/module.schema.json` |
| C8 | schema profile: the JSON Schema 2020-12 subset that maps to TypeScript | `tools/repo/lib/profile.ts` |
| C9 | generated types and the import rule | `tools/repo/lib/gen.ts`, `tools/repo/lib/imports.ts` |

Records carry `$version`; a breaking change raises it by one and adds a migration step, a pure function from the older body to the newer. The bundle `format` grows only by optional fields; hosts ignore unknown fields and refuse other formats. The rest lives at head.

## 5. External Integrations / APIs

- None at run time. Development uses `typescript` (`tsc` type checks), @types/node, `ajv` (schema validation, only in `tools/repo/lib/validate.ts`) and `playwright` (headless Chromium for `npm run browser`, which `npm test` does not run), all exact-pinned devDependencies that nothing ships. Floors: Node 24.12, Python 3.11 (standard library only). CI: GitHub Actions.
- Godot is a designed target. Strategy A, native runtime (default): a C5 runtime in the engine's language, proven by the same traces.
- Strategy B, embedded JavaScript: the engine runs `hosts/js/runtime.ts` unchanged. Strategy C, out of process: Node runs the game, the engine renders over a socket; development only.
- Engine work stays in host folders and `ctx.host`; records stay engine-neutral: string ids, float tolerance, GLB with glTF axes.

## 6. Deployment & Infrastructure

- Nothing is deployed. Bundles go under `build/`, which git ignores; `npm run serve` serves the web host locally. CI is `npm ci`, then `npm test`, on GitHub Actions, with no other logic.

## 7. Security Considerations

- No authentication, no secrets, no network service but the dev server on `127.0.0.1`.
- Module isolation is a design boundary, not a security one: a JavaScript host runs all modules in one realm; trace runners, `npm run migrate` and `npm test` run module code with the user's rights.

## 8. Development & Testing Environment

- Setup: `npm ci`, then `npm test`. Without Python the Python steps print SKIPPED, unless `REQUIRE_HOSTS=python`, which CI sets.
- Repository check: every manifest, game, schema, record, reference and generated file of the three roots.
- Type checks: the Node, portable and web projects; the portable project keeps the runtime and module `ts` code off DOM and Node APIs, the web project keeps `web` code off Node APIs.
- Unit tests: the tool, both runtimes, both runners, module logic with a fake ctx.
- Fixture roots: small repositories that each make the tool report an exact rule id.
- Bundle snapshot: bundles change only on purpose.
- Smoke: each game runs on node and python where it lists them; the two agree within a tolerance.
- Conformance traces: node and python pass the probe and contract traces.
- Compatibility goldens: each host still reads its golden trace bundles.
- Walkthroughs: extension changes work on copies of the schemas and a frozen sandbox.
- Docs: this file's paths exist.
- Browser, by hand: `npm run browser` opens the voxel viewer in headless Chromium and checks that it draws, turns and plays the walk.

## 9. Future Considerations / Roadmap

- Schema lock. Seam: `$version`, a lock file beside `npm run check`. Trigger: first data or contract used outside the repository.
- Run-time module loading. Seam: pure `resolve`. Trigger: players load modules without a rebuild.
- Determinism enforcement, seeded randomness. Seam: `game.snapshot()`, additive `ctx.random()`. Trigger: replay, rollback or the first random need.
- Save games. Seam: JSON state, pure migrations. Trigger: the first persisted player data.
- Engine hosts. Seam: C4, C5, probe traces. Trigger: an approved engine.
- Release web build. Seam: `load(bundle, { importer })`. Trigger: the first public web build.
- Parallel scheduling. Seam: system entries are objects, so fields can be added. Trigger: a profiled bottleneck.

## 10. Project Identification

- Name: Project S
- Repository: https://github.com/vuxnd/project-s
- Contact: the repository owner (vuxnd)
- Last update: 2026-10-21

## 11. Glossary / Acronyms

- Root: a directory with `modules/` and optionally `games/`; the roots are `.`, `examples`, `hosts/conformance`.
- Module: a folder with a manifest, schemas, records (JSON files of a declared type), code per host.
- Contract: a module with `contract: true`, whose traces every implementation must pass.
- Implementation: a module that `implements` a contract; a game selects one per contract.
- Trace: a language-neutral test of calls, inputs, event counts.
- Game: a composition of modules, config, hosts.
- Bundle: the one file per game and host a runtime loads.
- Host: a runtime and its `ctx.host` services (node, python `{}`; web `{ canvas, audio }`).
- ctx: the object a module receives.
- System: a module function run in the fixed loop (each tick) or the frame loop.
- C1 to C10: the contracts.
- R1 to R22: the runtime rules of C5.
- Rule id: the append-only name of a reported problem, such as `[gen-stale]`.
