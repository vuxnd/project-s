# Architecture

Project S is an engine-neutral game foundation. Games are module folders and JSON compositions; one Node tool checks them and compiles each game, per host, into one bundle that a small runtime per host executes. Labels: C1 to C10 are the contracts (Major systems), R1 to R22 the runtime rules of C5, `[rule-id]` a problem the tool reports (`tools/repo/lib/rules.ts`).

## Repository structure

```text
schemas/                      module, game, bundle, trace and trace-bundle schemas (C1, C2, C4, C6)
tools/repo/                   the tool: cli.ts, commands/ (one file per command), lib/, test/ (51 fixture roots), docs.ts
hosts/js/                     runtime.ts (C5 for every JavaScript host), trace.ts, conformance.ts (Node trace runner)
hosts/js/web/                 browser host: index.html, host.ts (the loop), serve.ts (dev server)
hosts/python/                 runtime.py, conformance.py (trace runner), play.py (bundle player), run.ts (finds Python)
hosts/conformance/            root: the probe contract, whose traces define C5
examples/                     root: example modules and the sandbox game
modules/, games/              root .: the game's own modules and compositions
.github/workflows/ci.yml      CI: npm ci, then npm test
package.json, tsconfig*.json  npm scripts and three exact devDependencies; Node, portable and web type-check projects

<root>/modules/<id>/module.json                     manifest (C1)
<root>/modules/<id>/types.gen.ts                    written by npm run gen, committed (C9)
<root>/modules/<id>/schemas/*.schema.json           type, event, operation, state and config schemas (C8)
<root>/modules/<id>/content/<type id>/<name>.json   records (C3)
<root>/modules/<id>/conformance/<name>.json         traces (C6); contracts only
<root>/modules/<id>/migrations/<type name>/<N>.ts   step N-1 to N, with <N>.before.json and <N>.after.json
<root>/modules/<id>/assets/                         files that records name through x-asset
<root>/modules/<id>/ts/  web/  python/              code per host, named in the manifest's hosts
<root>/modules/<id>/test/*.test.ts                  unit tests with a fake ctx
<root>/games/<id>/game.json                         composition (C2)
```

A root is a directory with a `modules/` folder and, optionally, `games/`. The checked roots are `.`, `examples` and `hosts/conformance`; a module sees only modules of its own root. The tool writes bundles and trace bundles under `build/`, which git ignores.

## Principles

A game outlives its engines. What lasts is its data, the contracts between its parts and the tests that pin their behaviour, so the foundation is those three things.

- Every feature is a module folder: manifest, schemas, records, code per host. Nothing is registered; the tool finds folders.
- One Node tool validates the repository and resolves each game once, at build time, into one deterministic `bundle.json` per host, the only file a host reads.
- A small runtime per host executes the bundle. Language-neutral traces define what executing means and test every implementation on every host.
- Modules talk only through records, config, events and synchronous operations, all described by schemas. Module state is private.
- Versions exist only where a consumer can lag behind the code: record files and the bundle format. Everything else lives at head and changes atomically, proved by CI.
- Everything not needed now is deferred behind a named seam and a trigger (Deferred).
- Locked in: Node 24.12 or newer for contributors, JavaScript semantics for module code on JavaScript hosts. Left open: engines, renderer, platforms, each host's gameplay language, CI vendor, bundler, package registry, editor.

## Major systems

Six systems share ten contracts: the tool (`tools/repo/`) checks and compiles, two runtimes execute, two trace runners test, the web host (`hosts/js/web/`) draws, the probe (`hosts/conformance/`) defines the runtime, and the examples (`examples/`) exercise all of it.

| Label | Fixes | Defined by |
|---|---|---|
| C1 | Module manifest `<root>/modules/<id>/module.json`: `id`, `summary`, `contract`, `types`, `events`, `operations`, `config`, `state`, `systems`, `hosts`, `implements`, `requires`, `optional`, `packages`, `deprecated` | `schemas/module.schema.json` |
| C2 | Game composition `<root>/games/<id>/game.json`: selected modules and implementations, config overrides, `hosts`, `fixedHz` | `schemas/game.schema.json` |
| C3 | Record files: the `$version` envelope, optional `$schema` and `$comment`, `x-ref` and `x-asset` values | each record type's schema; checks in `tools/repo/lib/profile.ts` and `tools/repo/lib/content.ts` |
| C4 | Bundle: one deterministic file per game and host with everything the host needs | `schemas/bundle.schema.json` |
| C5 | Runtime: `load(bundle, options)` yields a game with `tick`, `frame`, `call` and `snapshot`; module code gets a `ctx`; rules R1 to R22 | `hosts/js/runtime.ts`, the reference; tests named R1 to R22 in `hosts/js/test/runtime.test.ts` and `hosts/python/test_runtime.py` |
| C6 | Trace and trace bundle | `schemas/trace.schema.json`, `schemas/trace-bundle.schema.json` |
| C7 | Ids, paths and numbers: names match `^[a-z][a-z0-9_]{0,63}$`, ids are strings, paths are posix | the `name` patterns in `schemas/module.schema.json` |
| C8 | Schema profile: the JSON Schema 2020-12 keywords that map to one TypeScript shape and pass Ajv strict mode | `tools/repo/lib/profile.ts` |
| C9 | Generated types `types.gen.ts` and the import rule | `tools/repo/lib/gen.ts`, `tools/repo/lib/imports.ts` |
| C10 | Tool CLI: exit codes 0, 1 and 2, the problem format, 42 append-only rule ids, the npm script names | `tools/repo/cli.ts`, `tools/repo/lib/rules.ts`, `package.json` |

## Module boundaries

| Shape | Declares | Examples |
|---|---|---|
| Contract | `contract: true`; types, events, operations, config; traces in its `conformance` folder | `physics`, `probe` |
| Implementation | `implements`; systems, state, operations, hosts. A game selects exactly one per contract | `physics_basic`, `probe_impl` |
| Feature | `requires`, `optional`; its own types, events, operations, state, systems, hosts | `sandbox_rules`, `probe_peer` |
| Content pack | types, events, a `content` folder; no code | `probe_other` |
| Presentation | frame systems; only hosts with a screen or speakers | `render_boxes`, `audio` |

| Channel | Declared as | Used with | Timing |
|---|---|---|---|
| Records | `types` and the `content` folder | `ctx.records(type)` | fixed at build |
| Config | `config` schema and defaults; game overrides | `ctx.config`, `ctx.configOf(id)` | fixed at build |
| Events | `events` | `ctx.emit`, `ctx.events` | delivered once to each loop at its next run |
| Operations | `operations` with params and result schemas | `ctx.call` | synchronous, in the provider |

- State is private; other modules reach it through operations. Same-tick questions, such as a ray cast, are operations; notifications are events.
- A module extends another's data by association: its own record type with an `x-ref` to the other's records. No foreign schema changes.
- Code may use itself, the contracts it implements, its `requires` and the `optional` ids the game selects. Data (`$ref`, `x-ref`, content folders) reaches only itself, `implements` and `requires`, because an optional module may be absent. Nothing is transitive.
- Visibility is enforced by the build checks and each bundle entry's `sees` and `absent`, on every ctx call (R10 to R13), and in the types: `types.gen.ts` imports only `implements` and `requires`.
- Hand-written module code imports only files in its own folder and packages listed in `packages`; its `test` folder may also import `node:` built-ins. `tools/repo/lib/imports.ts` checks this on raw source.
- `tsconfig.portable.json` keeps the runtime and module `ts` code off DOM and Node APIs; `tsconfig.web.json` keeps web code off Node APIs.
- Rules the tool does not check: module code keeps no module-level mutable state, never calls `Math.random`, `Date`, `performance` or `crypto` (in Python `random`, `time`, `datetime`, `secrets`), and frame systems emit only discrete events.
- Limits: isolation is not a security boundary, since a JavaScript host runs every module in one realm; the import scan is lexical and skips Python; R9 and R18 run only in debug mode, which the web host does not use; `x-ref` is checked in records, not in config.

## Data flows

```text
authoring                 manifests, games, schemas, records, traces and code in a root
  --> check               npm run check: every checker over the roots ., examples and hosts/conformance
  --> gen                 npm run gen: types.gen.ts beside every manifest
  --> build               npm run build -- <game> --host <host> --root <root>
  --> bundle              build/<root>/games/<game>/<host>/bundle.json, the only file a host reads
  --> host                load(bundle) in runtime.ts or runtime.py, then tick, frame, call, snapshot

trace                     <root>/modules/<contract>/conformance/<name>.json
  --> trace bundle        build/<root>/traces/<host>/<implementation>/, by node tools/repo/cli.ts traces
  --> runner              hosts/js/conformance.ts or hosts/python/conformance.py: PASS or FAIL per file

browser event             pointerdown on ctx.host.canvas
  --> web module          a listener that render_boxes attached in init queues the click in ctx.state
  --> frame-system event  render_boxes.draw emits one physics.spawn per queued click
  --> fixed system        physics_basic.integrate reads it in the next tick and creates the body
```

- `build` resolves the composition once: the game's entries for the host, closed under `requires` and `implements`; one provider per contract; topological load order; each module's `sees` and `absent`; fixed and frame schedules from `after` and `before` edges; config defaults merged with the game's overrides (RFC 7396), then validated.
- The bundle holds the modules in load order with entry paths, contract providers, operation and event owners, type versions, config, records, assets, both schedules and schema paths for debug validation. Two builds of the same files are byte-identical.
- An event emitted in tick N reaches every fixed system once in tick N+1, and the next frame run when frame systems exist. Operations run at once inside the caller's system.
- The web host runs at most 8 ticks per animation frame from a time accumulator, then one frame run; it never passes inputs to `tick`.

## Extension mechanisms

`tools/repo/test/walkthroughs.test.ts` runs (a), (b), (c) and (e) on a temporary copy of `schemas/` and `examples/`; (d) and (f) need tools that are not installed and stay designed.

| Change | Files touched | Proof |
|---|---|---|
| (a) Add a feature: module `health` gives bodies hit points | new folder in `examples/modules/` (manifest, three schemas, a record, TypeScript and Python entries, `types.gen.ts`); `examples/games/sandbox/game.json`; the bundle snapshot | `walkthrough (a) add a feature`: three `health.died` in 300 ticks; Python ends where node does |
| (b) Replace `physics_basic` with `physics_alt` | new module folder that implements `physics`, with TypeScript and Python entries; the game's key; the snapshot | `walkthrough (b) replace physics`: no error or warning; the `physics` traces pass on node for both implementations |
| (c) Remove audio | delete `examples/modules/audio/`; drop it from the game; the snapshot | `walkthrough (c) remove audio`: no error; one `[unknown-module]` warning for a module that lists `audio` as optional |
| (d) Adopt Godot | the Godot files under Technology integration; a `godot` folder and host entry in each module that runs there; a CI job | designed only: the probe and contract traces must pass on Godot |
| (e) Bump `physics.body` to version 2 | migration `2.ts` with `2.before.json` and `2.after.json`; the type schema; four record files, rewritten by `npm run migrate -- --write`; the TypeScript and Python readers; `types.gen.ts`; the snapshot | `walkthrough (e) bump physics.body`: `[outdated-record]` before, no error after; the before sample migrates to the after sample |
| (f) Adopt a build or CI tool | `package.json` and `package-lock.json` (one exact devDependency); the new CI file | designed only: `npm test` unchanged; the new script exits 0 |

- A record type is a schema under `types` plus records in `content/<type id>/`. An event or operation is one manifest entry with its schemas.
- A contract is a module with `contract: true`, at least one implementation, and traces: one JSON file each in its `conformance` folder, run for every implementation on node and python.

## Technology integration

A host provides a reader for the bundle formats it supports, the C5 runtime, its `ctx.host` services and a trace runner, and commits golden trace bundles under `hosts/<host>/test/golden/format-<n>/`. The web host runs the runtime file that the Node runner tests and has no runner of its own.

| Host | Files | `ctx.host` | Proof |
|---|---|---|---|
| node, headless | `hosts/js/runtime.ts`, `hosts/js/conformance.ts` | `{}` | probe and contract traces, goldens, smoke run |
| web | `hosts/js/runtime.ts`, `hosts/js/web/index.html`, `hosts/js/web/host.ts`, `hosts/js/web/serve.ts` | `{ canvas, audio }` | Node tests of the loop, the server and the presentation modules with fakes |
| python, headless | `hosts/python/runtime.py`, `hosts/python/conformance.py`, `hosts/python/play.py`, `hosts/python/run.ts` | `{}` | the same traces and goldens; the smoke comparison with node |

- A, native runtime (the default): the engine gets a C5 runtime in its own language and engine-native contract implementations, proven by the same traces; gameplay modules are written once per host language. The Godot 4.7 host below follows A and is designed, not built (pin 4.7.2-stable).
- B, embedded JavaScript: the engine embeds a JavaScript runtime that runs `hosts/js/runtime.ts` and the TypeScript modules unchanged. Adopt an embedding only when it loads into stock engine binaries and export templates, has released within three months, and passes the probe traces inside the engine.
- C, out of process: a Node process runs the game and the engine renders over a local socket. Development and tooling only, because consoles and mobile stores will not ship a Node sidecar.

```text
hosts/godot/host.json                                     pinned version, per-platform URL and SHA-256
hosts/godot/fetch.ts                                      downloads and verifies the binary
hosts/godot/sync.ts                                       builds godot bundles and copies them, with module godot/
                                                          folders, into hosts/godot/project/generated/ (ignored)
hosts/godot/project/addons/bundle_runtime/game.gd         C5 in GDScript: fixed loop in _physics_process, frame in _process
hosts/godot/project/addons/bundle_runtime/conformance.gd  runs trace bundles headless
hosts/godot/test/golden/format-1/                         golden trace bundles
<root>/modules/<id>/godot/<id>.gd                         module code: init(ctx), one function per system, operations
```

- Engine-specific work stays in modules' host folders and `ctx.host`: rendering, scenes, input devices, audio, platform services. Records carry engine-neutral parameters.
- Godot parses every JSON number as a float, so ids are strings; its `Vector3` is 32-bit by default, so traces compare computed floats with `near` and `within`.
- 3D assets are GLB: `x-asset` may not list `gltf`, because a `.gltf` file can name external buffers that no check sees. Axes follow glTF: right-handed, +Y up, +Z forward.

## Backward compatibility

Compatibility is promised only where a consumer can lag behind the code.

- Records carry `$version`. An optional new property keeps version N; a change that invalidates a record or changes a field's meaning needs N+1 and a step `migrations/<type name>/<N>.ts` with `<N>.before.json` and `<N>.after.json`, compared by `tools/repo/test/migrations.test.ts`. Steps are never deleted.
- An outdated record is `[outdated-record]`; `npm run migrate -- --write` rewrites content and trace records in every root.
- Manifests and games: no `manifest` field means format 1. A breaking change adds format 2, and the tool reads both until every file is rewritten in the same change.
- Bundle format: an integer `format` that grows only by optional fields. Hosts ignore unknown fields (R22) and refuse other formats (R1); the goldens in `hosts/js/test/golden/format-1/` and `hosts/python/test/golden/format-1/` keep both hosts reading format 1.
- Runtime (C5): the probe traces keep passing on every host.
- Module interfaces live at head: a breaking change updates every implementation and consumer in one change, or adds a new contract id such as `physics_v2` beside the old one.
- Stable names: the npm scripts `test`, `check`, `gen`, `build`, `migrate`, `serve` and the `test:` steps, which CI and documents call. Rule ids are append-only: a changed meaning gets a new id.
- Deprecation: `"deprecated": "Use X"` in a manifest or `"deprecated": true` in a schema makes every use a warning; remove the item once `npm run check` reports no use.
- Not protected: with no schema lock, an unbumped breaking schema edit that no committed record, trace record or migration sample exercises passes every check.

## Dependency management

| Package | Version | Why |
|---|---|---|
| typescript | 7.0.2 | `tsc -p` over the three projects proves that implementations provide their contract's operations and portable code uses no DOM or Node API; Node strips types and checks none |
| @types/node | 24.19.2 | types for `node:` imports in tools, runners and tests; TypeScript 7 defaults `types` to none |
| ajv | 8.20.0 | JSON Schema 2020-12 validation, strict about unknown keywords; Node has no validator. Imported only by `tools/repo/lib/validate.ts` |

- All three are devDependencies at exact versions (`.npmrc` sets `save-exact=true`), locked in `package-lock.json` and installed with `npm ci`. Nothing ships them: no bundle, runtime or module imports a package.
- `tools/repo/test/scripts.test.ts` fails on a version range, a missing pin, a `dependencies` or `workspaces` field, or a single quote in a script.
- One root `package.json`, no workspaces, no per-module package files. A module that imports a package lists it in `packages`, which the import scan enforces.
- Node 24.12 or newer through `devEngines` with `onFail: "error"`; Python 3.11 or newer, standard library only; GitHub actions pinned to commit SHAs. CI runs ubuntu and windows with Node 24 and 26 on Python 3.13, plus one Python 3.11 job.

## Testing

| Layer | Proves | Where |
|---|---|---|
| Fixture roots | each rule fires with its exact id: 51 roots, each with an `expect.json` | `tools/repo/test/fixtures/roots/`, `tools/repo/test/check.test.ts` |
| Unit | tool libraries and commands; both runtimes rule by rule; both runners; the web loop, server and presentation modules with fakes; module logic with a fake ctx | `tools/repo/test/`, `hosts/js/test/`, `hosts/js/web/test/`, `hosts/python/`, each example module's `test` folder |
| Repository check | every manifest, game, schema, record, reference, asset, import, config, trace and generated file of the three roots | `npm run check` |
| Bundle snapshot | the example bundles change only on purpose; two builds give identical bytes | `tools/repo/test/examples.test.ts` |
| Conformance | each host implements C5 (eight probe traces); each implementation meets its contract (the `physics` traces) on node and python | `npm run test:traces` |
| Compatibility | every migration sample gives its after sample; each host still passes its format 1 goldens | `tools/repo/test/migrations.test.ts`, the golden folders |
| Smoke | every game of `.` and `examples` runs 300 ticks in debug mode on node and python with results equal within 1e-9 | `tools/repo/test/smoke.test.ts` |
| Walkthroughs | (a), (b), (c) and (e) | `tools/repo/test/walkthroughs.test.ts` |
| Types | the Node, portable and web projects type-check | `npm run test:types` |
| Documents | every path this file and `README.md` name exists, every `sh` command runs, the headings and contract labels exist | `tools/repo/docs.ts` |

- The root check, locally and in CI, is `npm ci && REQUIRE_HOSTS=python npm test`. `.github/workflows/ci.yml` holds no other logic, so another CI vendor needs only those two commands.
- `npm test` runs `check`, `test:types`, `test:unit`, `test:traces` and `test:docs`, stops at the first failure, and ends with `docs: <p> paths, <c> commands checked, 0 failures`.
- Without `REQUIRE_HOSTS=python`, a missing Python prints `SKIPPED python (not found)` instead of failing.
- Not checked: pixels and sound in a real browser (`npm run serve` shows both by hand); Godot, which is not built; Node 26 and Python 3.11 outside their CI jobs; whether VS Code resolves a relative `$schema`; test coverage; the prose of this file beyond its paths, commands, headings and contract labels.

## Deferred

| Deferred | Seam | Trigger |
|---|---|---|
| Schema lock: frozen schema versions, breaking-change classifier, surface lock, retired ids | records carry `$version`; a lock file and an accept command slot in beside `npm run check` | first data persisted outside the repository, or the first contract consumed outside it |
| Run-time module loading for mods or downloadable content | `resolve` is a pure function proven by fixture roots; a host ports it or calls the tool | players load modules without a rebuild |
| ECS | per-module state; a module may use an ECS inside | three or more modules keep parallel per-entity maps and join them every tick |
| Event bus with subscriptions | inbox events | asynchronous or networked events |
| Determinism enforcement, deterministic math, golden replays, state hashes | `game.snapshot()`; deterministic schedule and event order | lockstep, rollback or replay is required |
| Seeded randomness | an additive `ctx.random()` and an optional bundle `seed` | the first module that needs randomness |
| Godot host | C4, C5, the probe traces, the host folder convention | a Godot binary is approved for local use and CI |
| JavaScript embedded in an engine; out-of-process host | the same bundle and runtime | strategy A is too costly for a specific game |
| Release web build (esbuild or `tsc` emit) | `load(bundle, { importer })` with a static import map | the first public web build |
| Serving npm packages to the browser | the bundle's `packages` | the first web module that lists a package |
| Browser automation tests | `host.ts` is thin; module logic is tested with fakes | a web-only defect reaches a player |
| Asset pipeline, cook cache, a tool protocol for any language | `x-asset` gives the full asset list | an engine needs processed assets, or the first tool not written in TypeScript |
| Generated types for Python, GDScript and others | the profile maps to plain types in every target language | a statically typed host language reads records |
| Filling schema `default` values into bundles | Ajv's `useDefaults` in `tools/repo/lib/bundle.ts` | the first record property with a `default` that code reads |
| `oneOf` | a keyword joins the profile once Ajv, the generator and every validating host support it | the first schema that needs a discriminated union |
| Content patches and game variants | record ids and load order exist; `game.json` is plain data | a second variant of one game |
| Save games and load-time migration | state is JSON per module; migrations are pure JSON-to-JSON functions | the first persisted player data |
| Parallel scheduling, read and write declarations | system entries are objects, so fields are additive | a profiled bottleneck in systems |
| Hot reload | state is JSON-serializable | iteration time becomes a complaint |
| Frame-loop traces | the trace schema can gain `frames` | a second host with a frame loop is built |
| `x-unit` vocabulary and enforcement | `x-unit` is already an allowed annotation | a unit error reaches content |
| Affected-only CI, graph export, remote cache | none needed: `npm test` covers everything | a full CI run exceeds 10 minutes |

## Decisions

- Erasable TypeScript 7.0.2 on Node 24.12 or newer: Node runs `.ts` files without flags, and nothing calls the compiler API, which 7.0 does not ship.
- No build step: Node runs `.ts` files as written and the dev server strips types per request, so no compiled output can drift from the source.
- A headless Python host: running the same bundles and traces in a second language is the executable proof of engine neutrality.
- JSON Schema 2020-12 restricted to a portable profile (C8): composition keywords such as `oneOf` break one-to-one type generation, and a keyword joins only when Ajv, the generator and every validating host support it.
- Data-only traces as the conformance contract: a trace bundle is self-contained JSON, so every host, in any language, runs the same tests without the tool.
- One bundle per game and host, resolved at build time: a run-time resolver would have to exist in every host language.
- Modules see only modules of their own root: the tool discovers and checks one root at a time, so example, probe and fixture modules stay out of the game.
- Versioned records, a bundle format that grows only by optional fields, and everything else at head: no consumer exists outside the repository.
- Exact dependency pins, a committed lockfile and `npm ci`: every machine and CI job installs the same packages, and an update is one commit gated by `npm test`.
- Generated types committed and drift-checked with `[gen-stale]`: `tsc` then proves each implementation provides every operation of its contract.
- Synchronous operations plus events, with private state: a query such as a ray cast needs an answer within the tick, and reading another module's stored data would make its storage layout the interface.
- Events reach each loop once, at its next run: delivery is independent of system order within a step and needs no subscriptions.
- Web input enters through a module's `web` code and a frame-system event, never through the host: the simulation stays independent of the frame rate without a host-level input mapping.
- A native runtime per engine by default: Godot 4.7 runs no JavaScript, and GodotJS needs a custom engine build.
- Ajv imported by one file, as a devDependency: validation runs only in the tool and Node tests, so nothing ships it, and a quiet upstream stays behind one file.
