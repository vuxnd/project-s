# Architecture

Project S is an engine-neutral game foundation. This document records how the repository is built and why: its structure, contracts, data flows, extension paths and the decisions behind them.

Notation: C1 to C10 are the contracts (Major systems), R1 to R22 the runtime rules (Major systems, Runtimes), `[rule-id]` a problem the tool reports (`tools/repo/lib/rules.ts`), and 3.1 to 3.18, Q1 to Q8, 1.2 and D1 to D65 the decisions listed under Decisions.

## Repository structure

| Path | Role |
|---|---|
| `schemas/` | The five foundation schemas: module manifest (C1), game composition (C2), bundle (C4), trace and trace bundle (C6). Each follows the schema profile (C8). |
| `tools/repo/` | The repository tool: the CLI `tools/repo/cli.ts`, one file per command in `tools/repo/commands/`, the library in `tools/repo/lib/`, tests and fixture roots in `tools/repo/test/`, and the documentation check `tools/repo/docs.ts`. |
| `hosts/js/` | The JavaScript runtime `hosts/js/runtime.ts` (C5 for every JS host), the trace bundle types `hosts/js/trace.ts`, the Node trace runner `hosts/js/conformance.ts`, their tests and golden trace bundles. |
| `hosts/js/web/` | The browser host: the page `index.html`, the loop `host.ts`, the dev server `serve.ts`. |
| `hosts/python/` | The Python runtime `runtime.py`, trace runner `conformance.py`, bundle player `play.py`, the launcher `run.ts` that finds Python, tests and golden trace bundles. |
| `hosts/conformance/` | A root holding the `probe` contract, whose traces define C5, and the modules that implement and exercise it. |
| `examples/` | A root holding the example modules and the `sandbox` game: the integration fixture and the subject of the walkthroughs. |
| `modules/`, `games/` | The game's own modules and compositions, one folder each, beside a README. |
| `.github/workflows/` | CI: `npm ci`, then `npm test`, over a matrix of systems, Node and Python versions. |
| `build/` | Bundles and trace bundles the tool writes; ignored by git. |
| `node_modules/` | Packages `npm ci` installs; ignored by git. |

Root files: `package.json` (scripts, `devEngines`, three exact devDependencies), `package-lock.json`, `.npmrc` (`save-exact=true`), `.node-version` (24), `.gitattributes` (LF everywhere), `.gitignore` (installed packages, the root build folder, Python caches, local worktrees), the three type-check projects `tsconfig.json`, `tsconfig.portable.json` and `tsconfig.web.json` with `portable.d.ts`, `README.md` and this file.

A root is a directory with a `modules/` folder and, optionally, `games/`. The checked roots are `.`, `examples` and `hosts/conformance`; the 51 fixture roots under `tools/repo/test/fixtures/roots/` are checked only by tests. A module sees only modules of its own root. Inside a root:

```text
<root>/modules/<id>/module.json                      manifest (C1)
<root>/modules/<id>/types.gen.ts                     written by npm run gen, committed (C9)
<root>/modules/<id>/schemas/*.schema.json            type, event, operation, state and config schemas (C8)
<root>/modules/<id>/content/<type id>/<name>.json    records (C3)
<root>/modules/<id>/conformance/<name>.json          traces (C6); contracts only
<root>/modules/<id>/migrations/<type name>/<N>.ts    step from version N-1 to N, beside <N>.before.json and <N>.after.json
<root>/modules/<id>/assets/                          files that records name through x-asset
<root>/modules/<id>/ts/  web/  python/               code per host, named in the manifest's hosts
<root>/modules/<id>/test/*.test.ts                   unit tests with a fake ctx
<root>/games/<id>/game.json                          composition (C2)
```

Build output, never committed: `build/<root>/games/<game>/<host>/bundle.json` and `build/<root>/traces/<host>/<implementation>/<contract>.<name>.json`. For root `.` the prefix is `build/` alone.

## Principles

A game outlives its engines. What lasts is its data, the contracts between its parts, and the tests that pin their behaviour, so the foundation is those three things.

1. Every feature is a module folder with a manifest, schemas, records and code per host. Nothing is registered: the tool finds folders.
2. One Node tool validates the whole repository and compiles each game, per host, into one deterministic `bundle.json`, the only file a host reads.
3. A small runtime per host executes the bundle. Language-neutral traces define what executing means and test every implementation on every host.
4. Modules talk only through records, config, events and synchronous operations, all described by schemas. Module state is private.
5. Composition is resolved once, at build time.
6. Versions exist only where a consumer can lag behind the code: record files and the bundle format. Everything else lives at head and changes atomically, proved by CI.
7. Everything not needed now is deferred behind a named seam and a trigger (Deferred).

This locks in Node 24.12 or newer for contributors and JavaScript semantics for module code on JavaScript hosts. It leaves open the engines, renderer, platforms, the gameplay language of each host, the CI vendor, bundler, package registry and editor.

## Major systems

Six systems share ten contracts: the tool checks and compiles, two runtimes execute, two trace runners test, the web host draws, the probe defines the runtime, and the examples exercise all of it.

### Contracts

| Label | Contract | Defined by | Checked by |
|---|---|---|---|
| C1 | Module manifest `<root>/modules/<id>/module.json` | `schemas/module.schema.json` | `tools/repo/lib/discover.ts` |
| C2 | Game composition `<root>/games/<id>/game.json` | `schemas/game.schema.json` | `discover.ts`, `resolve.ts`, `config.ts` |
| C3 | Record file and record type schema | each type's schema plus the envelope rules | `tools/repo/lib/content.ts`, `tools/repo/lib/profile.ts` |
| C4 | Bundle `build/<root>/games/<game>/<host>/bundle.json` | `schemas/bundle.schema.json` | written by `tools/repo/lib/bundle.ts`; read by every host |
| C5 | Runtime context and host API | rules R1 to R22; `hosts/js/runtime.ts` is the reference | the probe traces on every host |
| C6 | Trace and trace bundle | `schemas/trace.schema.json`, `schemas/trace-bundle.schema.json` | `tools/repo/lib/traces.ts`, the trace runners |
| C7 | Ids, paths and numbers | the `name` patterns in `schemas/module.schema.json` | `discover.ts`, `content.ts` |
| C8 | Schema profile | `tools/repo/lib/profile.ts` | `[profile]` |
| C9 | Generated types and the import rule | `tools/repo/lib/gen.ts`, `tools/repo/lib/imports.ts` | `[gen-stale]`, the import rules, `tsc` |
| C10 | Tool CLI and npm scripts | `tools/repo/cli.ts`, `tools/repo/lib/rules.ts`, `package.json` | `tools/repo/test/cli.test.ts`, `tools/repo/test/scripts.test.ts` |

**C1, module manifest.** `id` equals the folder name and is not `trace`. A module with `contract: true` is a contract: it may declare `types`, `events`, `operations`, `config`, `requires` and `deprecated`, and declaring `systems`, `hosts`, `state`, `implements`, `optional` or `packages` is `[contract-shape]`. A non-contract that declares any of `systems`, `state`, `operations` or `hosts` is a code module; one with only `types`, `events`, `config` and a `content` folder is a content pack. Paths are relative to the module folder and must exist (`[missing-file]`). `implements` names contracts (`[implements-contract]`). `requires` and `optional` name modules or contracts of the root, never an implementation (`[require-contract]`), never the module itself and never one id in both lists (`[bad-dependency]`). An `optional` id that names no module of the root is an `[unknown-module]` warning and counts as absent (D35). Operation names are unique across the module's own operations and those of the contracts it implements, system names within the module (`[duplicate-name]`); `init` and `operations` are reserved system names (`[reserved-name]`). `packages` lists the npm packages and `node:` built-ins the module's TypeScript may import. `deprecated` names the replacement, and every use is a `[deprecated]` warning. A manifest without a `manifest` field is format 1.

**C2, game composition.** The keys of `modules` select modules and choose implementations; listing a contract sets its config, and one of its implementations must be listed too. An entry's `config` is merged into the module's defaults (RFC 7396). `hosts` lists the hosts the game is built for, and an entry with its own `hosts` is selected only when building for one of them (D33; `[entry-host]` when it names a host the game does not list). `fixedHz` is the fixed loop rate. `examples/games/sandbox/game.json`:

```json
{
  "$schema": "../../../schemas/game.schema.json",
  "id": "sandbox",
  "summary": "Three boxes fall and stack; on the web they are drawn, beep, and a click spawns another.",
  "hosts": ["node", "python", "web"],
  "fixedHz": 60,
  "modules": {
    "physics_basic": {},
    "sandbox_rules": {},
    "physics": { "config": { "gravity": [0, -20, 0] } },
    "render_boxes": { "hosts": ["web"], "config": { "clickBody": "sandbox_rules/crate" } },
    "audio": { "hosts": ["web"], "config": { "volume": 0.5 } }
  }
}
```

**C3, records.** A record type schema is a file listed under `types`. Its root is an object with `additionalProperties: false` whose `properties` declare `$schema` (string), `$version` (`{ "const": N }`, N at least 1) and `$comment` (string), with `$version` required (`[record-type]`). N is the type's current version and lives nowhere else. A record is `<root>/modules/<m>/content/<type id>/<name>.json` with id `<m>/<name>`: `$version` is required, `$schema` is optional and must then be the relative path to the type schema (`[schema-path]`), `$comment` is optional prose that the build strips. The folder must be a declared type (`[unknown-type]`) of a module the record's module can see (`[invisible-ref]`). A `$version` below N is `[outdated-record]` with the fix `run npm run migrate -- --write`; otherwise the record is validated (`[schema]`). Then the annotations: an `x-ref` value must be the id of an existing record of that type (`[dangling-ref]`) in a visible module (`[invisible-ref]`); an `x-asset` value must name a file inside the module folder with a listed extension (`[asset-missing]`); `deprecated: true` on the type or a present property is a `[deprecated]` warning. Schema `default` values are never applied (D51).

**C4, bundle.** One file per game and host, the only file a host reads. It lists everything a host needs and derives nothing: modules in load order with entry paths and visibility, contract providers, the owner of every operation and event, type versions, merged config, records, assets, the schedule of both loops, and schema paths for debug validation (fields under Data flows). Its text is deterministic: fields in a fixed order, map keys sorted, records sorted by id, written by the canonical JSON writer. Format 1 grows only by optional fields; hosts ignore fields they do not know (R22) and refuse other formats (R1).

**C5, runtime.** `load(bundle, options)` returns a game with `tick`, `frame`, `call`, `snapshot` and `ticks`; module code receives a `ctx`. The rules are under Runtimes.

**C6, traces.** A trace is `<contract dir>/conformance/<name>.json`: `fixedHz`, `ticks`, optional `modules` added to the composition, `config` overrides, `records` (ids `trace/<name>`), `inputs` (`at` below `ticks`, an event of the composition, a payload valid for it) and `expect`. An expectation has one of two forms (`[trace-expect]` otherwise): the call form `at`, `call`, optional `params` and `pointer`, then `equals`, or `near` with `within`; the count form `by`, `emitted`, `count`. A call names an operation of the composition, an input an event of it (`[trace-unknown]`); a count may name any event declared in the root, and an event outside the composition counts 0 (D32). `at: N` is evaluated after N completed ticks; an input with `at: N` goes to tick N; `count` is how often `tick()` returned the event in ticks 0 to N-1; `equals` compares JSON values, `near` passes when the number at the pointer is within `within`. The tool compiles each trace, for every implementation of the contract and each host that implementation lists (or each host the `traces` command names), into a trace bundle `{ trace, contract, implementation, ticks, bundle, inputs, expect }` whose bundle is a C4 bundle named `<contract>.<trace name>`.

**C7, ids, paths and numbers.** Module ids and type, event, operation, system and record names match `^[a-z][a-z0-9_]{0,63}$`: valid identifiers in JavaScript, Python, GDScript, C# and Rust, lower case for case-insensitive file systems, letter first so object key order is insertion order. Type, event, operation and system ids are `<module>.<name>`; record ids are `<module>/<name>`. Ids are strings, never numbers, because Godot parses every JSON number as a float; integers stay within plus or minus 2^53-1 by convention (no check enforces it). Paths are posix: relative to the repository root in bundles, to the module folder in manifests and records.

**C8, schema profile.** JSON Schema 2020-12 restricted to keywords that map to one TypeScript shape and that Ajv strict mode accepts. Allowed: `$schema $ref $defs $comment title description default examples deprecated type enum const properties required additionalProperties propertyNames items minItems maxItems uniqueItems minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minLength maxLength pattern x-ref x-asset x-unit`. Any other keyword is `[profile]`, and the message names it; among them are `oneOf allOf anyOf not if then else patternProperties dependentRequired dependentSchemas unevaluatedProperties unevaluatedItems contains prefixItems $anchor $dynamicRef $dynamicAnchor format $id minProperties maxProperties`. Rules: `$schema` is the 2020-12 URI and appears, like `$defs`, only at the root; every schema node is an object (`{}` means any value; `false` only as `additionalProperties`); `type` is one type or `[T, "null"]`; type-specific keywords need their type; every object states `additionalProperties`, `false` beside `properties` or a schema plus `propertyNames` for a map; `required` names are keys of `properties`; `enum` holds distinct strings; `items` is one schema; `$ref` is `#/$defs/<name>` or a relative path to a `*.schema.json` file, optionally with a `$defs` fragment; `x-ref` is a qualified type id; `x-asset` lists lower-case extensions and never `gltf` (D53); `x-unit` is documentation. Schemas declare no `$id` (D7). A keyword joins the profile only when Ajv, the generator and every host that validates support it.

**C9, generated types and the import rule.** `npm run gen` writes `types.gen.ts` beside every manifest of every checked root, and `npm run check` fails with `[gen-stale]` on any difference. A generated file imports the runtime's `Ctx` type and, as namespaces, the `types.gen.ts` of every id in `implements` and `requires`, never an optional id (D60). It exports one type per record type (body only), event payload, operation params and result, plus `Config`, an `Operations` interface in method syntax that extends each implemented contract's, and, for a non-contract, `State` and `Ctx = RuntimeCtx<State, Config>`. An implementation proves its contract at compile time: `export const operations = { … } satisfies Operations`. `$ref` is inlined; arrays with equal `minItems` and `maxItems` from 1 to 16 become tuples; recursion is `[gen-unsupported]`; two declarations with one TypeScript name, including the fixed names `Config`, `State`, `Operations`, `Ctx`, `RuntimeCtx` and `Record`, are `[gen-name-clash]`. Hand-written module files import only files inside their own module folder, packages listed in `packages`, and, in the module's `test` folder, `node:` built-ins. `types.gen.ts` is the only file that crosses a module boundary, and it holds only types, so Node erases those imports.

**C10, tool CLI and npm scripts.** `node tools/repo/cli.ts <command>` with exit codes 0 (clean), 1 (problems found or tests failed) and 2 (usage error). Every problem prints as `<file>#<pointer>: <message> [<rule>]`, or `<file>:<line>: <message> [<rule>]` for parse errors and source files, prefixed `warning: ` for warnings, and names the fix where one exists. The 42 rule ids in `tools/repo/lib/rules.ts` are append-only: a changed meaning gets a new id. The npm script names `test`, `check`, `gen`, `build`, `migrate`, `serve`, `test:types`, `test:unit`, `test:traces` and `test:docs` are stable, because CI and documents call them.

### The tool

`tools/repo/cli.ts` resolves the repository root from its own location (D4) and runs `tools/repo/commands/<name>.ts` (D3); `node tools/repo/cli.ts help` lists the commands. Each `--root` is a repository-relative posix path.

| Command | Arguments | Does | Prints |
|---|---|---|---|
| `check` | `--root <dir>`, repeatable | every checker over each root | problems, then `check: <e> errors, <w> warnings in <r> roots` |
| `gen` | `--root <dir>`, repeatable; `--check` | writes changed `types.gen.ts` files, or with `--check` only compares | problems, then `gen: wrote <n> files` or `gen: <n> problems` |
| `build` | `<game> --host <h> --root <dir>` | checks the root's manifests, schemas and records, then writes one bundle | problems, then `wrote <bundle path>` |
| `traces` | `--host <h>` and `--root <dir>`, repeatable | deletes and rewrites each root's trace folder for each host (D18) | problems, then `traces: wrote <n> trace bundles` |
| `migrate` | `--root <dir>`, repeatable; `--write` | migrates outdated records in content and traces | problems; without `--write` one line per outdated record and `migrate: <n> files would change; run npm run migrate -- --write`, with it `migrate: rewrote <n> files` |

The npm scripts `check`, `gen` and `migrate` pass the three checked roots; `build` passes its arguments through.

The library in `tools/repo/lib/` never prints. `checkRoot` in `check.ts` runs every checker over one root and returns the sorted problems:

| Checker | File | Rules it reports |
|---|---|---|
| discover manifests and games | `discover.ts` | `root-missing json-parse schema bad-id missing-file duplicate-name reserved-name contract-shape unknown-module implements-contract require-contract bad-dependency deprecated entry-host schema-path` |
| schemas, records, migration files | `content.ts`, `profile.ts`, `validate.ts` | `profile record-type ref-missing invisible-ref unknown-type schema-load json-parse bad-id schema schema-path outdated-record dangling-ref asset-missing deprecated migration-missing` |
| config defaults and overrides | `config.ts` | `bad-config`, and `schema-load` for a config schema that does not compile |
| composition per game and host | `resolve.ts`, `schedule.ts` | `unknown-module deprecated no-provider one-provider no-host-entry cycle unknown-ref loop-mismatch` |
| imports of module code | `imports.ts` | `import-boundary undeclared-package dynamic-import` |
| traces | `traces.ts` | `contract-shape json-parse schema schema-path trace-expect trace-unknown bad-config`, plus the record and composition rules for the trace's records and composition, all at the trace file |
| generated types | `gen.ts` | `gen-stale gen-name-clash gen-unsupported`, and `json-parse ref-missing missing-file` for a schema it cannot read |

Two rules never come from `checkRoot`: `[game-host]` from the `build` command (a host the game does not list) and `[migration-failed]` from `migrate` (a migration threw or produced an invalid record). Ajv is imported only by `tools/repo/lib/validate.ts`: one `Ajv2020` per validator in strict mode with `allErrors`, the vocabulary `x-ref`, `x-asset` and `x-unit` added, every schema file registered under `https://repo.invalid/<path>` so relative `$ref` values resolve (D7), compiled schemas cached by path. `tools/repo/lib/json.ts` holds the canonical writer `formatJson` (two-space indent, arrays of scalars on one line, keys in insertion order, LF, trailing newline) and the parser that reports line and column (D6).

### Runtimes

`hosts/js/runtime.ts` is C5 for every JavaScript host: it imports nothing outside `hosts/js/`, uses no Node or DOM API, and is type-checked in the portable project. `hosts/python/runtime.py` is C5 for Python, standard library only. Both export `FORMATS` (1) and `load`.

| `ctx` member | Meaning |
|---|---|
| `ctx.state` | this module's state, assignable; private to the module |
| `ctx.config`, `ctx.configOf(id)` | merged config of this module, or of a visible module or contract |
| `ctx.records(type)` | record id to record, for a visible record type |
| `ctx.events(id)` | payloads of event `id` delivered to the current run |
| `ctx.emit(id, payload)` | queues a visible event for the next runs |
| `ctx.call(id, params)` | runs a visible operation now, in its provider, and returns the result |
| `ctx.has(id)` | true when the owner of `id` is visible, false when it is an absent optional module |
| `ctx.tick`, `ctx.dt`, `ctx.alpha` | completed fixed ticks; seconds the run advances; fraction of a tick, in frame runs |
| `ctx.host` | host services: `{}` on node and python, `{ canvas, audio }` on web |

A module entry exports an optional `init(ctx)` returning the initial state, one function per declared system, and an `operations` object of functions `(ctx, params) => result`. The owner of an id is the text before its first dot. Messages in backticks are identical on every host.

| Rule | Behaviour |
|---|---|
| R1 | `load` refuses a format not in `FORMATS`: `bundle format <n>; this host reads 1`. |
| R2 | `load` imports every entry in bundle order; each scheduled system must be an exported function (`missing system: <id>`) and each operation a module provides must be in its `operations` (`missing operation: <id>`). |
| R3 | `init` runs per module in load order and its result becomes the state. During `init` the tick is 0 and `ctx.events` returns `[]`; emits go to the first runs; calls reach only providers already initialised (`not initialized: <id>`). |
| R4 | `tick(inputs)` runs the fixed schedule once with `dt = 1 / fixedHz` and `alpha` 0, then counts the tick. |
| R5 | Each loop has an inbox. `emit` appends to the fixed inbox, and to the frame inbox only when the frame schedule is not empty (D37). A run takes its inbox: an event emitted in tick N reaches every system of tick N+1 once; the frame loop sees every event since its last run. |
| R6 | `tick` and `frame` return the events emitted during that run, inputs excluded; events emitted by `init` or `game.call` are delivered but returned by no run. |
| R7 | Each input must name an event of the bundle (`unknown: <id>`); inputs skip visibility checks and reach only the tick they are given to. |
| R8 | `frame(dt, alpha)` runs the frame schedule once with those values. |
| R9 | Debug mode: an operation called while a frame run is in progress, nested calls included, must leave its provider's state unchanged (`frame call changed state: <id>`). |
| R10 | A ctx call whose owner the module neither sees nor lists as absent throws `not visible: <id> from <module>`. |
| R11 | For an absent optional owner: `has` is false, `events` is `[]`, `records` is `{}`, `emit` does nothing, `call` and `configOf` throw `absent: <id>`. |
| R12 | A visible but undeclared id throws `unknown: <id>`. R10, R11 and R12 are checked in that order. |
| R13 | `has(id)` is true when the owner is visible. |
| R14 | `ctx.config` and `configOf` return the bundle's merged config; JS hosts deep-freeze all config at load. |
| R15 | `records(type)` returns record id to record, sorted by id; JS hosts deep-freeze all records at load. |
| R16 | `call` runs the operation synchronously with the provider's own ctx, so a contract operation runs in its implementation; a JS operation returning a promise throws `operation returned a promise: <id>`. |
| R17 | Each module has one ctx for the life of the game; `ctx.state` read or assigned outside a run, for example in a listener `init` attached, is the current state (D61). |
| R18 | Debug mode: state, payloads, params and results must be JSON-clean (`<kind> not JSON: <id>`; `-0` becomes `0`); payloads and results are handed out as copies, frozen on JS hosts; with `validate`, values are checked against the schema paths of `bundle.schemas` (`invalid <kind> for <id>: <message>`). |
| R19 | `game.call(id, params)` runs an operation from the host without visibility checks. |
| R20 | `snapshot()` returns a JSON copy of every module state that is set, in load order. |
| R21 | Errors thrown by module code leave `load`, `tick`, `frame` and `call` unchanged. |
| R22 | `load` ignores fields it does not know at the bundle root and in `modules[]` (D47). |

Both runtimes also fix what the rules left open: debug mode rejects `undefined` anywhere inside a JavaScript value; the JSON-clean check runs before `validate`; the value `init` returns always replaces `ctx.state`; a tick that throws does not count and loses its inbox; `snapshot()` is JSON-clean also outside debug mode. Python differs where the language does: `load` is synchronous and takes `root`, `host`, `debug`, `importer` and `validate` as arguments; errors are `BundleError` with the same text; `ctx.config_of` replaces `ctx.configOf`; records and config are plain dicts, not frozen (D17); the JSON-clean copy goes through `json.dumps(…, allow_nan=False)` and raises for any value it rejects or changes, such as a tuple or a non-string key (D63); R16's promise rule does not apply. A Python entry is one file loaded by path, with no package and no `sys.modules` entry, so it cannot import a sibling file (D31).

### Trace runners

`hosts/js/conformance.ts` runs trace bundles on Node; `hosts/python/conformance.py` runs them on Python, started through `hosts/python/run.ts`. Each takes directories, runs every `*.json` below them in sorted order with debug mode on and `ctx.host` `{}`, and prints `PASS <trace> (<implementation>)` or `FAIL <trace> (<implementation>)` per file, an indented `expect[<i>]: … expected <json>, got <json>` line per failed expectation, and `<host>: <passed> passed, <failed> failed`. A bundle for another host fails with `wrong host <h>`; an exception fails the file with `error: <message>`. Exit 0 when nothing failed, 1 when a file failed or none was found, 2 for a missing directory or no argument. The Node runner validates values with Ajv through `createValidator(repoRoot).errors`; the Python runner passes no validator.

`hosts/python/run.ts` tries `python3`, `python` and `py -3`, takes the first that runs and reports 3.11 or newer, and runs it as `python -I -B`: isolated from the environment and the current directory, and writing no `__pycache__` (D19). Without Python it prints `SKIPPED python (not found)` and exits 0, unless `REQUIRE_HOSTS` names `python`, which turns that into exit 1. Every Python entry script puts its own folder on `sys.path` before importing `runtime`, because `-I` leaves it off (D31). `hosts/python/play.py <bundle.json> <ticks>` runs a Python bundle in debug mode and prints one JSON line of the final snapshot and the event counts; the smoke test compares it with the Node run (D34).

### Web host

`hosts/js/web/index.html` holds a canvas and loads `hosts/js/web/host.ts`. The host reads `?root=<root>&game=<game>`, fetches `/build/<root>/games/<game>/web/bundle.json` (`/build/games/<game>/web/bundle.json` for root `.`), refuses a bundle whose host is not `web`, and loads it on the same `runtime.ts` with `ctx.host` `{ canvas, audio }`: the canvas sized to the page and an `AudioContext` resumed on the first `pointerdown` or `keydown`. Each animation frame adds the elapsed time, at most 0.25 s, to an accumulator, runs one `tick()` per `1 / fixedHz` in it, at most 8, drops any larger backlog, then runs `frame(dt, alpha)` with `alpha` the leftover fraction of a tick. The first frame only draws. Failures, including the first error that module code throws, show in the page and stop the loop. The host never passes inputs: input enters through the `web` entries of modules (Data flows).

`hosts/js/web/serve.ts` (`npm run serve`) serves the repository on 127.0.0.1, port 8080 or `--port`, for GET and HEAD only, and only to a `Host` of 127.0.0.1 or localhost, which blocks DNS rebinding. A `.ts` file is sent as JavaScript with its types removed by Node's `module.stripTypeScriptTypes`; the page gets an empty import map; a path with a NUL, a `..` segment or a target outside the repository is 403. A web bundle whose modules list an npm package gets 500 `packages are not served by the dev server yet` (D58).

### Probe

The root `hosts/conformance/` makes C5 executable. `probe` is a contract with a record type `step` (`tick`, `in`, `do`, optional `id` and `payload`), an event `ping`, an operation `log` and config `label`. `probe_impl` implements it in TypeScript and Python: in `init` and in its fixed systems `first` and `second` it performs each step record due at that tick (an `emit`, `events`, `call`, `has`, `config`, `configOf`, `records` or `time` ctx call) and logs the result or the error message. `probe_peer` is an optional peer with one system between `first` and `second`, an event and an operation; `probe_other` is a content-only module that `probe_impl` cannot see. Eight traces pin the rules: `order`, `events`, `inputs`, `state`, `visibility`, `config`, `operations` and `optional`. Their compiled format 1 bundles are committed as goldens in `hosts/js/test/golden/format-1/` and `hosts/python/test/golden/format-1/`. A step behaves the same on every host only when it carries `id` for every `do` except `config` and `time`, and `payload` for `emit` and for a `call` of an operation that declares params; `hosts/conformance/modules/probe/schemas/step.schema.json` cannot require this, because the profile has no `if` or `oneOf`.

### Examples

The root `examples/` holds one small game for all three hosts:

| Module | Shape | What it does |
|---|---|---|
| `physics` | contract | record type `body` (`size`, `mass`); events `spawn` (an input) and `contact`; operations `position` and `bodies`; config `gravity`; traces `fall` and `rest` |
| `physics_basic` | implementation | semi-implicit Euler boxes on the plane y = 0 with inelastic contacts and stacking (D28); fixed systems `integrate`, `collide`; TypeScript for node and web, Python for python |
| `sandbox_rules` | feature | record type `spawn`; at tick 0 emits one `physics.spawn` per spawn record; two crates and a plank as records |
| `render_boxes` | presentation, web | frame system `draw`: draws every body, turns each click into one `physics.spawn` |
| `audio` | presentation, web | record type `cue`; frame system `play`: one tone per `physics.contact` |

The game `sandbox` builds for node, python and web; `render_boxes` and `audio` are web-only entries (D33). On node and on python, which the smoke test compares, the plank comes to rest on the ground, the first crate on the plank and the second crate on the first, with three contacts.

## Module boundaries

### Shapes

A module's role follows from the fields it uses:

| Shape | Uses | Examples |
|---|---|---|
| Contract | `contract: true`; types, events, operations, config; traces in its `conformance` folder | `physics`, `probe` |
| Implementation | `implements`; systems, state, operations, hosts | `physics_basic`, `probe_impl` |
| Feature | `requires`, `optional`; own types, events, operations, state, systems, hosts | `sandbox_rules`, `probe_peer` |
| Content pack | types, events, a `content` folder; no code | `probe_other` |
| Presentation | frame systems; hosts with a screen or speakers only | `render_boxes`, `audio` |

A game selects exactly one implementation per selected contract; the tool never picks (`[no-provider]`, `[one-provider]`). To compare two implementations, write two games. Several cooperating sources of one thing, such as input devices or loot tables, are records of one type, not several implementations.

### Channels

| Channel | Declared as | Used with | Timing |
|---|---|---|---|
| Records | `types` and the `content` folder | `ctx.records(type)` | fixed at build; frozen on JS hosts |
| Config | `config` with schema and defaults; game overrides | `ctx.config`, `ctx.configOf(id)` | fixed at build; frozen on JS hosts |
| Events | `events` | `ctx.emit`, `ctx.events` | delivered once to each loop at its next run (R5) |
| Operations | `operations` with params and result schemas | `ctx.call` | synchronous, in the provider, with the provider's ctx (R16) |

State is private: only a module's own systems and operations touch `ctx.state`, and other modules reach it through operations (3.4). Same-tick questions, such as a ray cast, are operations; notifications are events. A contract may declare config that every implementation reads with `ctx.configOf('physics')`, so the setting survives swapping the implementation. A module extends another's data by association: it declares a record type whose `x-ref` property names the other's records, and no foreign schema changes.

### Visibility

A module's code may use itself, the contracts it implements, every id in `requires`, and every id in `optional` that the composition selects. Its data (`$ref` targets, `x-ref` types and targets, content folders) may reach only itself, `implements` and `requires`, because an optional module may be absent and a reference into it would dangle (D9). Nothing is transitive. The rule is applied three times: at build time by the checks (`[invisible-ref]`, the composition rules) and in each bundle entry's `sees` and `absent`; at run time on every ctx call (R10 to R13); and in the types, since `types.gen.ts` re-exports only `implements` and `requires` ids. Code that reads an optional module declares the types it needs at the call site, for example `ctx.events<{ tick: number }>('probe_peer.note')` (D60).

### Isolation and its limits

At build time the import scan in `tools/repo/lib/imports.ts` tokenizes raw source, so `import type` lines count too (D46): a relative import must stay inside the module folder and an absolute path or URL is refused (`[import-boundary]`), a package or `node:` built-in must be listed in `packages` (`[undeclared-package]`; a module's `test` folder may use `node:` built-ins freely), and `import()` needs a literal argument (`[dynamic-import]`). Three type-check projects hold code to its platform: `tsconfig.portable.json` (`lib` es2024 only, no DOM, no Node types) covers `runtime.ts`, `trace.ts` and every module's `ts` and `migrations` folders, with `portable.d.ts` declaring `console` (D41); `tsconfig.web.json` (DOM, no Node types) covers `host.ts` and every module's `web` folder; `tsconfig.json` covers all TypeScript under `tools/`, `hosts/`, `modules/` and `examples/`, tests included and fixture roots excluded, with Node and DOM types. At run time every ctx call is checked against the bundle's `sees` and `absent`.

Module code also keeps three rules that the tool does not check. It keeps no module-level mutable state, because Node caches an imported entry and two games in one process would share it (D21); the smoke test catches a violation only in the example game (D49). It never calls `Math.random`, `Date`, `performance`, `crypto` or Python's `random`, `time`, `datetime`, `secrets` (D50). A frame system emits only discrete events (D38). Module code logs with `console` or `print`.

The limits:

- Isolation is not a security boundary. A JavaScript host runs every module in one realm, so a module can reach globals. Untrusted mods are deferred.
- The scan is lexical and covers TypeScript only. `i++ / b` reads as the start of a regular expression, `import('x', { with: … })` counts as `[dynamic-import]`, and Python imports are not scanned.
- Run-time checks cover ctx calls only, and R9 and R18 run only in debug mode, which the trace runners, `play.py` and the tests use. The web host and any release build trust them.
- `x-ref` is checked only in records. A config value that names a record, such as `render_boxes.clickBody`, passes `check` and `build` when the record is missing, and `physics_basic` then ignores those spawns.
- Node caches a module entry by file URL for the life of the process: two games loaded in one process share module objects (D21, D49), and a file edited after its first import keeps its old code.
- A Python entry cannot import a sibling file, and `@dataclass` under `from __future__ import annotations` fails to load, because entries load without a package or a `sys.modules` entry.

## Data flows

### Authoring to host

```text
module.json, game.json, schemas, records, traces, code       (authored)
    |  npm run check                                          every checker over the three roots
    |  npm run gen                                            types.gen.ts beside every manifest
    |  npm run build -- <game> --host <host> --root <root>
    v
build/<root>/games/<game>/<host>/bundle.json                  (the only file a host reads)
    |  load(bundle)                                           runtime.ts on node and web, runtime.py on python
    v
tick(inputs), frame(dt, alpha), call(id, params), snapshot()
```

```sh
npm run check
npm run gen -- --check
npm run build -- sandbox --host web --root examples
npm run serve
```

`check` runs, per root: discover, schema and record checks, migration files, config defaults, a bundle in memory for every game and every host it lists, the import scan of every module, every trace compiled for every implementation and host, and the comparison of every `types.gen.ts` with what `gen` would write. `build` discovers the root, checks its schemas and records, stops on any error there, then resolves the composition:

1. Selection: the game's keys whose entry has no `hosts` or lists the host, closed under `requires` and `implements`. `optional` never selects.
2. Providers: each selected contract needs exactly one selected implementation (`[no-provider]` lists the candidates for the host; `[one-provider]` names the extras). Each selected code module needs an entry for the host (`[no-host-entry]`).
3. Load order: topological over `requires` and the selected `optional` ids, a contract standing for its implementation, the smallest ready id first (`[cycle]` prints the path).
4. Visibility: per module, `sees` (the selected ids it may use) and `absent` (its optional ids not selected, including ids that name no module).
5. Schedule: per loop, Kahn's algorithm over `after` and `before` edges plus manifest order within a module, ties broken by module load order and then declaration order. An entry may name a module, a contract (its implementation's systems) or a system. An entry for an unselected module, or for an `optional` id that names no module of the root, is ignored (D60); anything else unknown is `[unknown-ref]`, and a system of the other loop is `[loop-mismatch]`.
6. Config: module defaults merged with the game's override by RFC 7396 (objects merge, arrays and scalars replace, `null` deletes), then validated (`[bad-config]`). An entry for another host contributes no config.

The bundle then holds, in this order:

| Field | Content |
|---|---|
| `format`, `game`, `host`, `fixedHz` | identity and loop rate |
| `modules` | selected code modules in load order: `id`, `entry` (repository path of the host's entry), `sees`, `absent`, `packages`; contracts and content packs are not listed |
| `contracts` | contract to its implementation |
| `operations`, `events` | each id to the module that runs or declares it; a contract's operations map to its implementation |
| `types` | each record type to its current version |
| `config` | merged config of every selected module and contract, `{}` when none is declared |
| `records` | type to record id to record, without `$schema`, `$version` and `$comment`, with `x-asset` values rewritten to repository paths |
| `assets` | every asset path the records reference |
| `schedule` | `fixed` and `frame` system ids in run order |
| `schemas` | state, event, params and result schema paths, for debug validation (D13) |

A host reads only the bundle: it imports each `entry` (Node through a `file:` URL of the repository root, the browser through `/`), runs `init` in load order, then drives `tick` and `frame`. Two builds of the same files give byte-identical bundles.

### Traces to runners

```text
<root>/modules/<contract>/conformance/<name>.json
    |  node tools/repo/cli.ts traces --host <h> --root <root>
    v
build/<root>/traces/<h>/<implementation>/<contract>.<name>.json   (bundle, inputs, expect)
    |  node hosts/js/conformance.ts <dir>, or hosts/python/conformance.py through run.ts
    v
PASS or FAIL per file, then <host>: <passed> passed, <failed> failed
```

```sh
node tools/repo/cli.ts traces --host node --root examples
node hosts/js/conformance.ts build/examples/traces/node
```

For each trace, each implementation of its contract and each host that implementation lists, the tool builds the composition contract plus implementation plus the trace's `modules`, checks the trace's records as records of the pseudo-module `trace`, and compiles a C4 bundle with the trace's `fixedHz`. A trace bundle is self-contained, so a runner needs no tool command. The runner calls the expectations due at each completed tick, counts the events `tick()` returns, and passes the inputs due at each tick.

### Inside a running game

`tick(inputs)` delivers the fixed inbox followed by the inputs to every fixed system in schedule order. An event emitted during tick N is delivered in tick N+1 to every fixed system once, and to the next frame run when the frame schedule is not empty; operations run at once inside the caller's system. In `sandbox`, `sandbox_rules.start` emits three `physics.spawn` events in tick 0, `physics_basic.integrate` creates the bodies in tick 1, `physics_basic.collide` emits a `physics.contact` the first time each body lands, and on the web `audio.play` reads the contacts in the next frame run while `render_boxes.draw` calls `physics.bodies` to draw. A frame call must leave its provider's state unchanged (R9), so the frame rate never changes the simulation.

### Input

Input travels from the browser through module state to a frame-system event and then to a fixed system (D38):

1. `render_boxes` attaches a `pointerdown` listener to `ctx.host.canvas` in `init`; the listener pushes the click's canvas coordinates onto `ctx.state.pending`. R17 makes the ctx kept by the listener see the current state.
2. The frame system `render_boxes.draw` emits one `physics.spawn` per queued click (id `click_<n>`, body from the config `clickBody`, position from the pixels and `scale`) and clears the queue.
3. `physics_basic.integrate` reads the spawn in the next tick and creates the body.

`hosts/js/web/host.ts` never injects input; `tick(inputs)` serves hosts and traces that inject events directly. A frame system emits one event per user action or state change, never one per frame run, because frame emits reach the next fixed run.

## Extension mechanisms

Each walkthrough names the files a change creates and edits. `tools/repo/test/walkthroughs.test.ts` applies (a), (b), (c) and (e) to a temporary copy of `schemas/` and `examples/` (D24); (d) and (f) need tools that are not installed and stay designed. Every change ends with `npm test` passing.

### (a) Add a feature

A module `health` gives bodies hit points: it requires `physics`, declares the record type `profile` with one record `default`, the event `died` and a state, and has a fixed system `damage` after `physics` that takes one hit point per `physics.contact` and emits `health.died` at zero. Because `sandbox` lists python, it has a Python entry as well as the TypeScript one (D33).

```text
create  examples/modules/health/module.json
create  examples/modules/health/schemas/profile.schema.json
create  examples/modules/health/schemas/died.schema.json
create  examples/modules/health/schemas/state.schema.json
create  examples/modules/health/content/health.profile/default.json
create  examples/modules/health/ts/index.ts
create  examples/modules/health/python/health.py
create  examples/modules/health/types.gen.ts                written by npm run gen
edit    examples/games/sandbox/game.json                    "health": {}
edit    tools/repo/test/examples.test.ts.snapshot           node --test --test-update-snapshots tools/repo/test/examples.test.ts
```

Untouched: `schemas/`, the tool's code, `hosts/` and every other module. Proof: the test `walkthrough (a) add a feature` finds no error rules, ticks the built node bundle 300 times and gets exactly three `health.died` events, and its subtest `python ends where node does` runs the Python bundle through `play.py` for 300 ticks and compares the results. The test runs no `gen`, so a real addition also commits the generated file.

### (b) Replace physics

A second implementation of `physics` replaces `physics_basic` in the game.

```text
create  examples/modules/physics_alt/module.json            "implements": ["physics"]
create  examples/modules/physics_alt/ts/index.ts             node and web entry
create  examples/modules/physics_alt/python/physics_alt.py   python entry, because sandbox lists python
create  examples/modules/physics_alt/types.gen.ts            written by npm run gen
edit    examples/games/sandbox/game.json                     the key physics_basic becomes physics_alt
edit    tools/repo/test/examples.test.ts.snapshot
edit    package.json, package-lock.json                      only for an npm package: an exact pin, and its name in packages
```

Untouched: the `physics` contract and its traces, every consumer, all content. Proof: the test `walkthrough (b) replace physics` copies `physics_basic` to `physics_alt`, swaps it into `sandbox`, and finds no error or warning rules; the `physics` traces compile for both implementations and pass on node; the node bundle maps `physics` to `physics_alt`. An implementation built on an npm package runs on node but not yet on the web host, whose dev server refuses bundles that list packages (D58).

### (c) Remove audio

```text
delete  examples/modules/audio/
edit    examples/games/sandbox/game.json                     drop "audio"
edit    tools/repo/test/examples.test.ts.snapshot            the web case
```

Untouched: everything else, including modules that list `audio` under `optional`. A module that `requires` it fails with `[unknown-module]`. Proof: the test `walkthrough (c) remove audio` first adds a module `stats` (`optional: ["audio"]`, a fixed system `count` with `after: ["audio"]` that calls `ctx.has('audio')`, host node) and generates its types, then deletes `audio`. `checkRoot` with generated-file checks on reports no error and exactly one warning rule, `[unknown-module]` for the optional id; `gen` writes nothing; the node bundle's `stats` entry has `absent: ["audio"]` (D35); dropping `physics_basic` as well gives exactly `[no-provider]`. Since `audio` is a web-only entry of `sandbox`, the node bundle listed it as absent before the deletion too; the warning is the only trace the removal leaves.

### (d) Adopt Godot

The Godot host creates the files listed under Technology integration, a `godot` folder with a GDScript entry in each module that runs there, and a `godot` entry in those manifests' `hosts`; it adds `godot` to the hosts of the games that ship on it (and a `godot` case to the bundle snapshot for an example game), a CI job that fetches Godot and runs the traces, and its generated project folder to `.gitignore`. Untouched: `schemas/`, the tool's code, contracts, traces, content and the other hosts. Proof: the probe traces and every contract trace pass on the Godot host. Designed only: no Godot binary is installed.

### (e) Bump physics.body from version 1 to 2

Version 2 stores `halfExtents` where version 1 stored `size`.

```text
create  examples/modules/physics/migrations/body/2.ts            size -> halfExtents, halved
create  examples/modules/physics/migrations/body/2.before.json   a version 1 record
create  examples/modules/physics/migrations/body/2.after.json    its expected version 2 result
edit    examples/modules/physics/schemas/body.schema.json        $version const 2, halfExtents replaces size
edit    examples/modules/sandbox_rules/content/physics.body/crate.json    by npm run migrate -- --write
edit    examples/modules/sandbox_rules/content/physics.body/plank.json    by npm run migrate -- --write
edit    examples/modules/physics/conformance/fall.json           trace record, by npm run migrate -- --write
edit    examples/modules/physics/conformance/rest.json           trace record, by npm run migrate -- --write
edit    examples/modules/physics_basic/ts/index.ts               reads halfExtents
edit    examples/modules/physics_basic/python/physics_basic.py   reads halfExtents
edit    examples/modules/physics/types.gen.ts                    written by npm run gen
edit    tools/repo/test/examples.test.ts.snapshot
```

Untouched: modules that never read `physics.body`; `render_boxes` gets sizes through the `physics.bodies` operation, whose result keeps full sizes. Proof: the test `walkthrough (e) bump physics.body` finds exactly `[outdated-record]` before migrating; the migration plan rewrites exactly the four record files; afterwards there are no error rules, the `physics` traces pass on node, and migrating `2.before.json` gives `2.after.json`. The test edits and runs only the TypeScript reader; a real bump also edits the Python reader, `records[spawn['body']]['size']` in `examples/modules/physics_basic/python/physics_basic.py`, which the test leaves stale.

### (f) Adopt a build or CI tool

A release script that loads the bundle with `load(bundle, { importer })` and a static import map, or another vendor's CI file running `npm ci` and `npm test`. It edits `package.json` and `package-lock.json` (one exact devDependency; `tools/repo/test/scripts.test.ts` accepts additions, D42) and the CI file. Untouched: modules, schemas, `tools/`, hosts. Proof: `npm test` is unchanged and the new script exits 0. Designed only.

### Smaller extensions

A record type is a schema under `types` plus records under `content/<type id>/`; each later version adds a migration step as in (e). An event or operation is one manifest entry with its schemas; every implementation of a contract provides every contract operation, which `satisfies Operations` proves at compile time and R2 at load. A trace is one JSON file in the contract's `conformance` folder; `npm test` compiles it for every implementation and host and runs it on node and python. A contract is a module with `contract: true`, at least one implementation and its traces.

## Technology integration

### Hosts

Every host implements four things: a reader for the bundle formats it supports (C4), the C5 runtime, its `ctx.host` services documented in its own folder, and a runner for trace bundles. It commits golden trace bundles under `hosts/<host>/test/golden/format-<n>/` that keep passing while it claims that format.

| Host | Files | `ctx.host` | Proof |
|---|---|---|---|
| node, headless | `hosts/js/runtime.ts`, `hosts/js/conformance.ts` | `{}` | probe and contract traces, goldens, smoke run |
| web | `hosts/js/runtime.ts`, `hosts/js/web/index.html`, `hosts/js/web/host.ts`, `hosts/js/web/serve.ts` | `{ canvas, audio }` | Node tests of the loop, the server and the presentation modules with fake canvas, audio and pointer events; the runtime file is the one the node traces pass |
| python, headless | `hosts/python/runtime.py`, `hosts/python/conformance.py`, `hosts/python/play.py`, `hosts/python/run.ts` | `{}` | the same probe and contract traces and goldens; the smoke comparison with node |

The web host has no trace runner of its own: it runs the file the Node runner tests, and browser automation is deferred.

The Node trace runner needs no `repo` command, because trace bundles are self-contained, but it imports three tool libraries: `tools/repo/lib/validate.ts` (Ajv, for debug validation), `tools/repo/lib/json.ts` (`getPointer`, `jsonEqual`, `readJson`) and `tools/repo/lib/fsx.ts` (`isDir`, `walkFiles`, `joinPosix`, `toPosix`). The web dev server `hosts/js/web/serve.ts` imports `relPath` from `tools/repo/lib/fsx.ts`. The Python runner and `play.py` import nothing outside `hosts/python/`. "A host runner needs no tool" is about compiling traces; a second copy of Ajv in the runner would break the rule that one file imports it (D55).

### Engine strategies

- **A, native runtime (the default).** The engine gets a C5 runtime in its own language plus engine-native implementations of contracts, for example a `physics_godot` on Godot's physics server, proven by the same traces. Cost: gameplay modules are written once per host language, as `physics_basic` has a TypeScript and a Python entry.
- **B, embedded JavaScript.** The engine embeds a JavaScript runtime that runs `hosts/js/runtime.ts` and the TypeScript modules unchanged. Gate before adopting an embedding: it loads into stock engine binaries and export templates, it has released within three months, and it passes the probe traces inside the engine. When the ruling was made, GodotJS failed the first condition, being built into the engine source, and gode was untested against the third.
- **C, out of process.** A Node process runs the game and the engine renders over a local socket. Development and tooling only, because consoles and mobile stores will not ship a Node sidecar.

All three read the same bundle. None is built beyond the hosts above.

### Godot 4.7

Designed, not built (strategy A; pin 4.7.2-stable when built). Godot 4.7 runs GDScript, C#, and C or C++ through GDExtension, not JavaScript. The files:

```text
hosts/godot/host.json                                   pinned version, per-platform URL and SHA-256
hosts/godot/fetch.ts                                    downloads and verifies the binary
hosts/godot/sync.ts                                     builds bundles for host godot and copies them, with each selected
                                                        module's godot/ folder, into hosts/godot/project/generated/
                                                        (ignored), because Godot loads scripts only below its project
hosts/godot/project/addons/bundle_runtime/game.gd       C5 in GDScript: fixed schedule in _physics_process with
                                                        physics_ticks_per_second = fixedHz, frame schedule in _process
hosts/godot/project/addons/bundle_runtime/conformance.gd   runs trace bundles headless
hosts/godot/test/golden/format-1/                       golden trace bundles
<root>/modules/<id>/godot/<id>.gd                       module code: init(ctx), one function per system, operations
```

Trigger: approval to install a Godot binary locally and in CI.

### What cannot be abstracted

| Concern | Where it lives |
|---|---|
| Rendering, shaders, lighting | host folders of presentation modules (`web`, later `godot`); records carry engine-neutral parameters |
| Editor-authored scenes and prefabs | a module's `godot` folder; engine-neutral data stays in records |
| Loop and object ownership | each host maps its callbacks onto `tick` and `frame` |
| Float precision (Godot's `Vector3` is 32-bit by default) | traces compare computed floats with `near` and `within` |
| JSON numbers (Godot parses all as floats) | ids are strings; numbers compare by value |
| Input devices, audio graph, platform services | `ctx.host`, used only in host folders |
| Physics solvers | contract traces assert bands of behaviour, not trajectories |

### Release builds, CI vendors and assets

A release build is deferred. The dev server strips types per request, which serves development only: Node marks `stripTypeScriptTypes` a release candidate whose output is not stable across Node versions. The seam is `load(bundle, { importer })` with a static import map, and the bundle's `packages` lists what a bundler or a package-serving server must provide.

CI is `npm ci` then `npm test` with `REQUIRE_HOSTS=python`, Node 24 or 26 and Python 3.11 or newer; `.github/workflows/ci.yml` holds no other logic, so another vendor needs only those two commands in the same environment.

3D assets are GLB, the self-contained binary form of glTF 2.0: an `x-asset` list may not contain `gltf`, because a `.gltf` file can name external buffers that no check sees (D53). Coordinates follow glTF: right-handed, +Y up, +Z forward, as `examples/modules/physics/schemas/vec3.schema.json` states. Numbers whose unit is not obvious carry `x-unit` (in the examples: metres, metres per second squared, kilograms, hertz, seconds, pixels per metre); it documents and checks nothing.

## Backward compatibility

Compatibility is promised only where a consumer can lag behind the code.

| Boundary | Mechanism | Enforced by |
|---|---|---|
| Record files | `$version` per record; a migration step with before and after samples per version; the tool refuses outdated records and prints the fix | `[outdated-record]`, `[migration-missing]`, `tools/repo/test/migrations.test.ts`, `npm run migrate` |
| Manifests and games | no `manifest` field means format 1; a breaking change adds 2, and the tool reads both until every file is rewritten in the same change | the foundation schemas |
| Bundle format | integer `format`; within a format only optional fields are added; hosts ignore unknown fields (R22) and refuse other formats (R1) | the golden trace bundles of each host |
| Runtime contract (C5) | the probe traces | conformance on every host |
| Module interfaces | live at head: a breaking change updates every implementation and consumer in the same change, or adds a new contract id beside the old one (`physics_v2`), removed when its last user leaves | `npm test` over every root and host |
| npm script names | `test`, `check`, `gen`, `build`, `migrate`, `serve` and the `test:` steps stay stable | CI calls only `npm ci` and `npm test` |

**Records.** Adding an optional property keeps a type's version N. Anything that makes an existing valid record invalid, or changes a field's meaning, needs N+1 and a step in the declaring module: `migrations/<type name>/<N>.ts` default-exports a pure function from a version N-1 record to the version N body and imports nothing; `<N>.before.json` holds a version N-1 record and `<N>.after.json` its expected result, which `migrations.test.ts` compares (D36). `[migration-missing]` covers every missing file of every step. The tool chains steps from each record's own `$version`, keeps its `$schema` and `$comment`, sets `$version`, and checks the result against the type schema only at the current version (D62). Steps are never deleted.

```sh
npm run migrate
```

Without `--write` it lists each outdated record and the files that would change. With `-- --write` it rewrites content records and the records embedded in traces in every root, only when no error occurred, and a file only when every record in it migrates.

**Bundles and the probe.** `hosts/js/test/golden/format-1/` and `hosts/python/test/golden/format-1/` hold the eight probe trace bundles compiled in format 1, and `npm test` runs them on both hosts, so a runtime that stops reading format 1 fails even after the tool moves on. Retiring a format: every host reads N and N+1, the tool emits N+1, and once every game builds as N+1 and every host passes, N and its goldens are deleted.

**Deprecation.** Mark it: `"deprecated": "Use X"` in a manifest, or `"deprecated": true` plus a description in a schema. Every use prints a warning with file and pointer. Move each use off it, by a migration for content and an edit for code, and remove it when `npm run check` reports no use.

**Not protected.** No schema lock exists (1.2): an unbumped breaking schema edit that no committed record, trace record or migration sample exercises passes every check. That is harmless while no data lives outside the repository; the lock's trigger is under Deferred.

## Dependency management

Three npm packages, all devDependencies at exact versions, locked in the committed `package-lock.json` and installed with `npm ci`. Nothing ships them: no bundle, runtime or module imports a package, and no module lists one in `packages`; only development tools use them, the Node trace runner included. Python uses the standard library only.

| Package | Version | Used for | Why not a built-in |
|---|---|---|---|
| typescript | 7.0.2 | `tsc -p` over the three projects: implementations provide their contract's operations, portable code uses no DOM or Node API, web code no Node API | Node strips types and checks none; without `tsc`, `types.gen.ts` checks nothing |
| @types/node | 24.19.2 | types for `node:` imports in tools, runners and tests | TypeScript 7 defaults `types` to none, so every `node:` import would fail |
| ajv | 8.20.0 | JSON Schema 2020-12 validation of manifests, games, records, traces, bundles and debug-mode values, strict about unknown keywords; imported only by `tools/repo/lib/validate.ts` | Node has no JSON Schema validator; writing one means passing the official test suite |

The lockfile adds undici-types (from @types/node), fast-deep-equal, fast-uri, json-schema-traverse and require-from-string (from ajv), and the one TypeScript binary for the platform out of 20 optional ones: `npm ci` installs 9 packages.

| Tool | Pin | Why |
|---|---|---|
| Node.js | `devEngines.runtime` `>=24.12.0` with `onFail: "error"`; `.node-version` 24; CI on 24 and 26 | runs every `.ts` file without a build step; npm checks the range before `install`, `ci` and `run` and stops with `EBADDEVENGINES` |
| npm | bundled with Node | `npm ci` and the scripts |
| Python | 3.11 or newer; CI 3.13 in every job plus one job on 3.11 | the second host language |
| git | any | LF line endings through `.gitattributes` |
| GitHub actions checkout, setup-node, setup-python | commit SHAs of v7.0.1, v7.1.0 and v7.0.0, the tag in a comment | CI |

Rules: one root `package.json`, no npm workspaces and no per-module package files (3.6); `.npmrc` saves exact versions; `tools/repo/test/scripts.test.ts` fails on a range, a missing pin, a `dependencies` field, a `workspaces` field or a single quote in a script; a package update is one commit gated by `npm test`. A module that imports a package lists it in `packages`, and the import scan enforces the list.

Between modules, `requires`, `optional` and `implements` are direct only; there is one version of everything, at head, so a change to a module updates its consumers in the same change. Not used: npm workspaces, a bundler, a test framework beyond `node:test`, a Python package, an engine binary, a browser driver.

## Testing

| Layer | Proves | Where |
|---|---|---|
| Fixture roots | each rule fires with its exact id: 51 roots, each with an `expect.json` naming the error and warning ids `checkRoot` returns; every rule except `game-host` and `migration-failed` has one, and those two are tested in `tools/repo/test/commands.test.ts` and `tools/repo/test/migrate.test.ts` | `tools/repo/test/fixtures/roots/`, `tools/repo/test/check.test.ts` |
| Unit | tool libraries and commands; both runtimes rule by rule, with tests named R1 to R22; both runners; the web loop, server and presentation modules with fakes; module logic with a fake ctx | `tools/repo/test/`, `hosts/js/test/`, `hosts/js/web/test/`, `hosts/python/`, the `test` folder of each example module |
| Repository check | every manifest, game, schema, record, reference, asset, import, config, trace and generated file of the three roots | `npm run check` |
| Bundle snapshot | the example bundles change only on purpose, and two builds give identical bytes | `tools/repo/test/examples.test.ts` and its snapshot |
| Conformance | each host implements C5 (eight probe traces); each implementation meets its contract (the `physics` traces) on node and python | `npm run test:traces` |
| Compatibility | every migration sample migrates to its after sample; each host still passes its format 1 goldens | `tools/repo/test/migrations.test.ts`, the golden folders |
| Smoke | every game of `.` and `examples` runs 300 ticks in debug mode on node and on python with results equal within 1e-9; the sandbox stack and its three contacts; one bundle loaded twice in one process ends like a single run | `tools/repo/test/smoke.test.ts` |
| Walkthroughs | (a), (b), (c) and (e) | `tools/repo/test/walkthroughs.test.ts` |
| Types | the Node, portable and web projects type-check | `npm run test:types` |
| Documents | every path this file and `README.md` name exists, every `sh` command runs, the sections and contract labels exist | `tools/repo/docs.ts` |

The root check, locally and in CI, is `npm ci && REQUIRE_HOSTS=python npm test`:

```sh
npm ci
npm test
```

`npm test` stops at the first failing step:

1. `npm run check`, ending `check: 0 errors, 0 warnings in 3 roots`.
2. `npm run test:types`: `tsc` over the three projects, silent when clean.
3. `npm run test:unit`: `node --test` over `*.test.ts` below `tools/`, `hosts/`, `modules/` and `examples/`, ending `ℹ fail 0`, then the Python unit tests through `run.ts`, ending `OK`.
4. `npm run test:traces`: `traces: wrote 20 trace bundles` (eight probe and two physics traces per host), then `node: 18 passed, 0 failed` and `python: 18 passed, 0 failed` over the build folders and the goldens.
5. `npm run test:docs`, ending `docs: <p> paths, <c> commands checked, 0 failures`.

With `REQUIRE_HOSTS=python` a missing Python fails the run instead of printing `SKIPPED python (not found)` (D39); a contributor without Python runs plain `npm test`. CI runs five jobs: ubuntu and windows with Node 24 and 26 on Python 3.13, plus ubuntu with Node 24 on Python 3.11. On windows npm runs scripts through cmd.exe, which treats single quotes as text, so scripts use double quotes only (Q8). The `test:docs` commands run outside `node --test`, so they never race the tests over `build/`.

Not checked:

- Pixels and sound in a real browser: nothing verifies that the canvas shows the boxes or that a tone plays. `npm run serve` shows both by hand.
- Godot, which is not built.
- Node 26, outside CI.
- Python 3.11, outside its CI job.
- Whether VS Code resolves a relative `$schema` in a data file (Q6); `[schema-path]` keeps every `$schema` correct.
- Test coverage, which is neither measured nor gated: Node's coverage flag is experimental.
- The prose of this file beyond its paths, commands, headings and contract labels.

## Deferred

Each deferred mechanism has a seam that admits it without rework and a trigger that says when to build it.

| Deferred | Seam | Trigger |
|---|---|---|
| Schema lock: frozen schema versions, breaking-change classifier, surface lock, retired ids | records carry `$version`; schemas are files; a lock file and an accept command slot in beside `npm run check` | first data persisted outside the repository (saves, mods, shared replays) or the first contract consumed outside it |
| Run-time module loading for mods or downloadable content | `resolve` is a pure function proven by fixture roots; a host ports it or calls the tool | players load modules without a rebuild |
| ECS | per-module state; a module may use an ECS inside | three or more modules keep parallel per-entity maps and join them every tick |
| Event bus with subscriptions | inbox events | asynchronous or networked events |
| Determinism enforcement, deterministic math, golden replays, state hashes | `game.snapshot()`; deterministic schedule and event order | lockstep, rollback or replay is required |
| Seeded randomness | an additive `ctx.random()` and an optional bundle `seed` (D50) | the first module that needs randomness |
| Godot host | C4, C5, the probe traces, the host folder convention | a Godot binary is approved for local use and CI |
| JavaScript embedded in an engine; out-of-process host | the same bundle and runtime | strategy A is too costly for a specific game |
| Release web build (esbuild or `tsc` emit) | `load(bundle, { importer })` with a static map | the first public web build |
| Serving npm packages to the browser | the bundle's `packages` (D58) | the first web module that lists a package |
| Browser automation tests | `host.ts` is thin; module logic is tested with fakes | a web-only defect reaches a player |
| Asset pipeline, cook cache, a tool protocol for any language | `x-asset` gives the full asset list | an engine needs processed assets, or the first tool not written in TypeScript |
| Generated types for Python, GDScript and others | the profile maps to plain types in every target language | a statically typed host language reads records |
| Filling schema `default` values into bundles | Ajv's `useDefaults` in `tools/repo/lib/bundle.ts` (D51) | the first record property with a `default` that code reads |
| `oneOf` | the profile admits a keyword once Ajv, the generator and every validating host support it (D57) | the first schema that needs a discriminated union |
| Content patches and game variants | record ids and load order exist; `game.json` is plain data | a second variant of one game |
| Save games and load-time migration | state is JSON per module; migrations are pure JSON-to-JSON functions | the first persisted player data |
| Parallel scheduling, read and write declarations | system entries are objects, so fields are additive | a profiled bottleneck in systems |
| Hot reload | state is JSON-serializable | iteration time becomes a complaint |
| Frame-loop traces | the trace schema can gain `frames` | a second host with a frame loop is built |
| `x-unit` vocabulary and enforcement | `x-unit` is already an allowed annotation | a unit error reaches content |
| Affected-only CI, graph export, remote cache | none needed: `npm test` covers everything | a full CI run exceeds 10 minutes |

Notes for whoever builds the schema lock, from its first design (1.2): the surface it hashes must remove annotation keys only where they are keywords of a schema object, never a `properties` key such as `title` or `description`, or changing the schema of a property with that name keeps the hash; and acceptance without a version bump may cover only additions, widenings and annotation edits, never a narrowing, because a narrowing that keeps in-repository records valid is exactly the change that breaks data outside it.

## Decisions

The design ruling chose among five competing proposals and settled 18 contradictions between them (3.1 to 3.18). The build plan answered the ruling's open questions (Q1 to Q8), dropped the schema lock (1.2) and recorded its own decisions (D1 to D65). Both documents live outside the repository; this section keeps one line per decision with its reason, the mechanisms the ruling rejected, and the rulings made while building.

### Ruling

| Id | Decision | Reason |
|---|---|---|
| 3.1 | TypeScript 7.0.2, not 6.0 | nothing calls the compiler API, which 7.0 does not ship; the 6.x line ends at 6.0.3 |
| 3.2 | Erasable TypeScript, not JavaScript with JSDoc | Node runs `.ts` without flags; the browser needs a local server anyway, which strips types; TypeScript 7 reworked JSDoc checking |
| 3.3 | Composition resolved at build time into one bundle per game and host | a run-time resolver would exist in every host language; a pure resolver keeps run-time resolution a bounded later port |
| 3.4 | Synchronous operations plus events; module state private | a query such as a ray cast needs an answer within the tick; reading another module's stored data makes its storage layout the interface |
| 3.5 | Events delivered once to each loop at its next run | independent of system order within a step, no subscriptions, no producer-consumer check, about 20 lines |
| 3.6 | No npm workspaces; one root package | modules are folders, not packages; a package file per module repeats `module.json`; one package makes one version of everything true by construction |
| 3.7 | A headless Python host | the only second language installed; a second language running the same bundles and traces is the executable proof of engine neutrality |
| 3.8 | Ajv 8.20.0 as a devDependency imported by one file | validation runs only in the tool and Node tests, so a browser security policy never meets it; a quiet upstream stays behind one file |
| 3.9 | Strict schema profile, without `prefixItems` | composition keywords break one-to-one type generation; VS Code supports 2020-12 only partly, and `prefixItems` exists only there |
| 3.10 | Generated TypeScript types only, committed and drift-checked | TypeScript is a statically typed host language that reads records; `tsc` then proves each implementation provides every operation |
| 3.11 | Live at head; versions only on records and the bundle format | no consumer exists outside the repository; breaking-change classifiers were the riskiest code of the proposals that had them |
| 3.12 | An `optional` list | removing a provider then edits only the game for optional users; events of an absent module read as `[]` |
| 3.13 | Record envelope `$schema` (relative path), `$version`, optional `$comment`; id from the path | VS Code associates a file with its schema through `$schema`; an id equal to the file name stores one fact twice; JSON has no comments |
| 3.14 | Two loops, `fixed` and `frame`, plus `before` and `after` edges | the accumulator pattern separates exactly fixed steps and rendered frames; finer phases are orderings, which edges express |
| 3.15 | Ties broken by declaration order within a module, then module load order | systems are declared in the manifest, so reordering them is a deliberate edit |
| 3.16 | Native runtime per engine by default; embedding and out-of-process documented; none built | Godot 4.7 runs no JavaScript; GodotJS needs a custom engine build and gode is young; no Godot binary is installed |
| 3.17 | `devEngines` with `>=24.12.0` and `onFail: "error"`; CI on ubuntu and windows with Node 24 and 26; no macOS | `engines` is advisory without engine-strict; Node 24 entered maintenance and Node 26 becomes LTS in October 2026; macOS served only cross-CPU determinism, which is deferred |
| 3.18 | Import boundaries by a lexical scan of raw source, type-check projects and run-time visibility | stripping types first erases `import type` lines; TypeScript 7.0.2 has no stable compiler API |

### Open questions

| Id | Decision | Reason |
|---|---|---|
| Q1 | Pin `typescript@7.0.2`; generated files use `import type * as ns` plus `export type { ns }` | the options and `satisfies Operations` pass `tsc` (`enum` is rejected); `export type * as ns` creates no binding to extend |
| Q2 | Ajv `Ajv2020` in strict mode with `addVocabulary` for the `x-` keywords, imported as `import { Ajv2020 } from 'ajv/dist/2020.js'` | one schema using every profile keyword compiles; the named import type-checks under `nodenext` |
| Q3 | Every check runs on the build machine | npm and Python are available there |
| Q4 | CI actions pinned to commit SHAs | the tags are lightweight, so the SHA is the commit |
| Q5 | Generic `Ctx<S, C, H>` with type parameters at the call site; generated `Ctx = RuntimeCtx<State, Config>`; contract operations in method syntax | property syntax fails strict function-type checks; per-id typed maps would need a second generator pass for no proven gain |
| Q6 | VS Code's handling of a relative `$schema` not checked; `[schema-path]` enforces the path | no editor automation on the build machine |
| Q7 | `run.ts` probes `python3`, `python` and `py -3` by running them | on Windows `python3` can be the Store stub, which exists on PATH but does not run Python |
| Q8 | npm scripts use double quotes only | under cmd.exe a single-quoted glob runs no tests and exits 0 |

### Plan decisions

| Id | Decision | Reason |
|---|---|---|
| 1.2 | No schema lock in the foundation | no data lives outside the repository; the ruling deferred it with that trigger; its first specification was wrong twice |
| D1 | The build ran in six waves; the first and the last two had one unit each | every TypeScript unit needs `package.json` and installed packages, which only one unit can create; the examples and this document need everything before them |
| D2 | One unit per wave owned `package.json` and wrote that wave's scripts | a shared file needs one owner; wiring siblings kept the root check complete after each merge |
| D3 | One file per command in `tools/repo/commands/` | a command is added without editing a dispatcher |
| D4 | The CLI finds the repository root from its own location | commands behave the same from any directory and in worktrees |
| D5 | Every path the tool prints or writes is posix | Node's glob returns backslashes on Windows |
| D6 | `parseJson` computes line and column itself | V8's messages carry a position only for some errors |
| D7 | Schema files never declare `$id`; the validator registers each under `https://repo.invalid/<path>` | an authored `$id` would change the base of every relative `$ref` in the file |
| D8 | Profile details: `$defs` only at the root, `additionalProperties: false` beside `properties`, maps with `propertyNames`, keywords need their type, `$ref` targets end in `.schema.json` | each rule maps a schema to one TypeScript shape and matches what Ajv strict mode demands |
| D9 | Data may reach only self, `implements` and `requires`; optional modules are visible to code only | an optional module may be absent, so a record pointing into it would dangle |
| D10 | `ctx.has` throws `not visible` for an id neither seen nor absent | returning true for an invisible module invites a call that then throws |
| D11 | Operation names unique per module including implemented contracts; systems `init` and `operations` reserved; module id `trace` reserved | an entry exports `init`, `operations` and one function per system; trace records get ids `trace/<name>` |
| D12 | `tick` and `frame` return their emitted events; `game.call` exists; inputs reach only their tick | trace count and call expectations need both |
| D13 | The bundle carries schema paths and repository paths for assets; contracts and content packs are not in `modules`; every selected module has a config entry | debug validation needs schema locations, and the bundle is the only file a host reads |
| D14 | Five foundation schemas | every JSON file has a schema, compiled trace bundles included |
| D15 | Traces may add `modules`; the two expectation forms are checked in code | probe traces need extra modules; the profile has no `oneOf` |
| D16 | Generated types inline every `$ref`; fixed-length arrays become tuples; recursion is unsupported | TypeScript is structural, so inlining loses nothing and needs no naming rules |
| D17 | JS hosts always deep-freeze records and config; Python passes plain dicts | freezing once costs little; Python's standard library has no deep freeze |
| D18 | `traces` deletes its output folder first; runners fail on a missing folder or zero bundles | a stale or empty build must not pass silently |
| D19 | Python runs as `python -I -B`; `.gitignore` ignores `__pycache__` | `-I` alone still writes bytecode caches |
| D20 | The Node project uses `lib` es2024 and dom | Node tests import the `web` code of modules; the portable and web projects keep their limits |
| D21 | Module code keeps no module-level mutable state | Node caches an imported entry, so two games in one process share module objects |
| D22 | Module tests obey the import rule, may use `node:` built-ins, and use a fake ctx | integration through the runtime is the job of traces and the tool's tests |
| D23 | One fixture root per rule, each with an `expect.json`; `tsconfig.json` excludes them | makes one-root-per-rule checkable by one test |
| D24 | Walkthroughs (a), (b), (c), (e) are tests on a temporary copy; (d) and (f) stay documented | each runnable walkthrough gets a proof; (d) and (f) need tools that are not installed |
| D25 | `tools/repo/docs.ts` checks paths, commands, headings and contract labels; designed-only paths live in `text` blocks | every path the documents name exists and every command they name runs |
| D26 | The web host is tested from Node with fakes; real pixels and sound are not checked | every check is an automated command, and everything except the browser can be driven from Node |
| D27 | `npm test` ends with `test:docs` | D25 |
| D28 | Physics example: semi-implicit Euler, ground at y = 0, inelastic contacts, one contact per body, stacking on overlapping resting bodies | deterministic and identical in TypeScript and Python, so traces can assert narrow bands |
| D29 | Node 26 runs only in CI | it is not installed on the build machine |
| D30 | Measured line counts replace estimates (Size) | the plan's estimate was 3.6 times the ruling's; measuring keeps the gap visible |
| D31 | Python entry scripts put their own folder on `sys.path`; a Python module entry is one file | `-I` leaves the script folder off `sys.path` |
| D32 | A count expectation may name any event of the root; outside the composition it counts 0 | the `optional` probe trace counts an absent module's event; it is the only pin of `emit` on an absent module |
| D33 | A game entry may list hosts; one `sandbox` for node, python and web | one composition per game across engines; a module without an entry for a game's host fails the build |
| D34 | `play.py` and the smoke test run every game on node and python and compare | otherwise non-contract module code never runs on Python |
| D35 | An `optional` id that names no module is a warning and counts as absent | removing a module must leave its optional users untouched |
| D36 | Every migration step has an after sample, compared by a test | a wrong but valid migration rewrites every record irreversibly |
| D37 | `emit` fills the frame inbox only when there are frame systems | a host that only ticks otherwise grows memory without bound (the plan's lab measured 91 MB against 8 MB after 100,000 ticks of 10 events) |
| D38 | Frame systems emit only discrete events; input enters through the `web` code of modules | the simulation stays independent of the frame rate without a host-level input mapping |
| D39 | Checks run `npm ci && REQUIRE_HOSTS=python npm test` | CI sets `REQUIRE_HOSTS=python`; local runs must match it |
| D40 | This document was written from the ruling and plan sections it summarises | the reasons live there |
| D41 | `portable.d.ts` declares `console` for the portable project only | module authors can log while the project still rejects `document` |
| D42 | `scripts.test.ts` requires exact versions and the three pins, not only those packages | walkthroughs (b) and (f) add a package without touching `tools/` |
| D43 | `.gitignore` ignores only the root build folder, with a leading slash | without the slash it would also ignore a `build` folder inside `tools` or inside a module's assets |
| D44 | The fixture roots `migrate-ok` and `migration-failed` give exactly `[outdated-record]` under `checkRoot`: `shapes_impl` lists node only, the trace uses no `x-ref` | the two roots met `checkRoot` only after their merge |
| D45 | Contracts are labelled C1 to C10 here, and `docs.ts` checks every label a schema cites | the foundation schemas cite those labels |
| D46 | The import scanner tokenizes raw source: comments skipped, strings, templates and regular expressions as tokens, template substitutions as code | text inside comments and strings never yields an import, code inside substitutions does |
| D47 | `load` ignores unknown fields (R22) | additive change inside format 1 is the bundle's only compatibility rule |
| D48 | Debug mode accepts only JSON-clean values; NaN and infinities throw; `-0` becomes `0` | JSON round trips in JavaScript and Python differ otherwise |
| D49 | The smoke test loads one bundle twice in one process | catches module-level state, which only the Node host shares |
| D50 | Module code never calls `Math.random`, `Date` or `crypto`; seeded randomness is deferred | a convention, no mechanism |
| D51 | Schema `default` values are never filled in | it would add a mechanism no schema uses |
| D52 | Every `$schema` must be the relative path of its schema: one rule, `[schema-path]` | copied modules otherwise keep broken editor links silently |
| D53 | `x-asset` may not list `gltf`; 3D assets are GLB | a `.gltf` with external buffers passes every check while files are missing |
| D54 | The Python floor stays 3.11; one CI job runs 3.11 | raising it would change the ruling; one job proves the floor |
| D55 | The Node runner's tool imports are stated (Technology integration) | "a host runner needs no tool" is about compiling traces; a second Ajv would break the one-file rule |
| D56 | The schema lock is removed | 1.2 |
| D57 | `oneOf` left the profile | no schema in the foundation, the examples or the probe uses it |
| D58 | The dev server serves an empty import map and refuses bundles that list packages | no module lists a package, and a resolver would fail for any package with dependencies |
| D59 | `scripts.test.ts` checks the glob form only for the `node --test` arguments of `test:unit` | the Python test pattern is not a test glob |
| D60 | `types.gen.ts` imports only `implements` and `requires`; `after` and `before` naming a removed optional module are ignored | deleting an optional module otherwise broke its users' types and checks |
| D61 | One ctx per module for the life of the game (R17) | `render_boxes` pushes clicks into `ctx.state` from a listener attached in `init` |
| D62 | A migration result is checked against the schema only at the current version | an intermediate result can never match it, so a second bump would fail correct migrations |
| D63 | Python's JSON-clean copy raises for anything `json.dumps` rejects or changes | R18 promises one message for every non-JSON value on every host |
| D64 | All Python code keeps to the 3.11 language level | newer syntax passes locally on 3.13 and fails only the CI 3.11 job |
| D65 | Stale sentences in the plan were corrected | this document summarises the plan, so a stale sentence there becomes a false one here |

### Rejected

Mechanisms the competing proposals offered and the ruling left out, with the property each served and how this design serves it instead.

| Rejected | Served | Instead |
|---|---|---|
| A run-time microkernel with a registry, lifecycle and capability tokens | modularity, replaceability | build-time resolution, `init` in load order, `sees` checked on every call; run-time loading deferred |
| An event bus with synchronous dispatch | removal without edits | inbox events: emitters never know their readers |
| Extension points and contributions | extensibility | records by type plus `x-ref` association; systems declared in manifests |
| Version ranges between modules, with a provider-consumer asymmetry and a 0.x rule | upgradeability | live at head; a new contract id for coexisting major versions |
| Committed composition locks per app and profile | reviewable composition | bundle snapshots of the example games; `game.json` diffs are explicit |
| App profiles with `extends`, command-line and URL overrides | configuration | separate games; variants deferred |
| An API snapshot through the TypeScript compiler API | backward compatibility | `tsc` checks implementations against `types.gen.ts`; at head no snapshot is needed |
| A Godot TCP link and a gated JavaScript embedding | engine integration | strategies B and C, documented over the same bundle, not built |
| Null render, null audio and validator capability modules | testability | fakes in unit tests; validation lives in the tool |
| A content database with load-time migration | backward compatibility | migrations at repository time; load-time migration deferred with save games |
| Retired-name markers | backward compatibility | deferred with the classifier |
| `engine-strict` in `.npmrc` | dependency management | `devEngines` (3.17) |
| A profile meta-schema built on `$dynamicAnchor` | schema-driven | the profile enforced in code (C8); Ajv's handling of such a meta-schema was never verified |
| A units vocabulary with `x-unit` required on every number | clear interfaces | optional `x-unit`; the vocabulary deferred |
| A capability descriptor file, an in-house interface language | clear interfaces | operations declared in the manifest with params and result schemas |
| A batch harness protocol for test vectors | interoperability | self-contained trace bundles that each host reads directly |
| Target files with a `choose` map, and binding files | composition | listing an implementation in `game.json` is the choice; host folders by convention |
| Three phases: input, simulate, present | system-driven | two loops plus edges (3.14) |
| Asset sidecar files with chosen ids | data references | `x-asset` paths; sidecars deferred with the asset pipeline |
| Surface lock, accept command, classifier, frozen major versions | backward compatibility | deferred (Deferred) |
| Python and GDScript code generation | schema-driven | TypeScript only; the others deferred |
| Validating proxies in Node test runs | testing | debug-mode validation inside the runtime |
| Generated per-host tsconfig include lists | modularity | three static tsconfig projects |
| A canonical-format check on every authored JSON file | maintainability | the writer formats what tools write; authored files are not checked |
| A content rename command | maintainability | `npm run check` lists dangling references after a rename |
| A `notes` field on every record | maintainability | optional `$comment`, stripped from bundles |
| An ECS world as the core | system-driven | per-module state and systems; ECS deferred |
| Determinism rules, a deterministic math library, a banned-API scan, per-system random streams | testing, future netcode | deferred |
| A canonical state hash, golden replays, a determinism kit | testing | traces plus `snapshot()`; replays deferred |
| Five host ports for session, presenter, input, storage and frame driver | separation of concerns | the C5 host API plus `ctx.host` services per host |
| An out-of-process TCP protocol | interoperability | strategy C, deferred |
| npm workspaces, `exports` maps, an `.npmrc` scope guard | dependency management | one root package (3.6) |
| An in-house validator with the vendored JSON Schema test suite | dependency management | Ajv behind one file (3.8) |
| A schema diff against the merge base | backward compatibility | deferred with the classifier |
| Six phases; read and write declarations with a guarded world | system-driven | two loops; access declarations deferred |
| Same-tick events with a producer-before-consumer check | latency | inbox events plus synchronous operations (3.5) |
| View annotations, view frames, integer-only commands | presentation boundary, determinism | in-process presentation modules; deferred with strategy C and determinism |
| Whole-record overrides of module content by the game | customization | config overrides; content patches deferred |
| A macOS arm64 runner | determinism across processors | not needed until determinism is (3.17) |
| Every unit a package with a manifest and a kind (code, content, target) | modularity | module folders hold code and content; games are compositions |
| Doctor, cook, affected, graph and conformance commands | tooling | `check`, `gen`, `build`, `traces`, `migrate`; the rest deferred |
| A workspace file of roots, ignores, toolchains and checks | configuration of tooling | roots passed by the npm scripts |
| A schema lock file with frozen hashes and retired ids | backward compatibility | deferred |
| `.invalid` URIs as schema ids, and generated VS Code settings | editor support | relative `$schema` paths |
| Document `extensions` keyed by package, as in glTF | extensibility | extension by association |
| A tool protocol for any language, a cook pipeline, a content-addressed cache | interoperability, build speed | deferred |
| A root `#pkg/*` imports map | addressing packages | no code imports across modules (C9) |
| A strip-then-scan boundary check and a resolve hook | modularity | the lexical scan of raw source (3.18) plus run-time visibility |
| A probe of a fixture workspace with a skinned `.glb` | adapter conformance | probe traces for runtime semantics; asset-loading conformance deferred |
| Semantic versions per package, with ranges | dependency management | one version at head |
| JavaScript with JSDoc | maintainability, browser loading | erasable TypeScript; the dev server strips types (3.2) |
| A permissive schema profile | expressiveness | the strict profile, for type generation (3.9) |
| Reading another module's state | clear interfaces | operations; state private (3.4) |
| Glue modules as the only integration | removal | still allowed; `optional` added (3.12) |
| Ajv as a runtime dependency | testing | a devDependency; nothing ships it |
| No code generation | simplicity | `types.gen.ts` (3.10) |
| CI actions pinned by tag | dependency management | pinned by commit SHA |

### Rulings made while building

| Ruling | Reason |
|---|---|
| The generator also reserves the name `Record` | a record type named `record` would generate a type that shadows the file's own `Record<string, never>` |
| `buildBundle` resolves config only from the entries selected for the host | an entry for another host plays no part, its config included |
| Problems found while compiling a trace point into the trace (`/config/<id>`, `/modules/<i>`), and a `config` key outside its composition is `[bad-config]` | the trace file is where the fix goes |
| Cycle messages print the waits-for path from the smallest id left | deterministic text for one cycle |
| Module code exports plain functions and an `operations` object and never declares itself a `ModuleEntry` | a module typed with its generated `Ctx` does not assign to `ModuleEntry` under strict function types |
| Runtime details the rules left open (Runtimes) | the JavaScript runtime fixed them and the Python runtime matched, so both hosts behave alike |
| `checkSchemas` compiles only schema files without an error of their own | one mistake gives one problem |
| `build` and `traces` also run `checkSchemas` and stop on its errors | a record of a type without a valid version yields neither a record nor a problem from `loadRecords` |
| `x-asset` refuses backslashes and a leading slash, compares extensions in lower case, and is refused in trace records | asset paths stay inside the module on every system |
| Runner details: compact JSON values, `got undefined` for a missing pointer step, `wrong host` and `error:` detail lines, every directory checked before any file runs, call expectations before count expectations at each tick | identical output from both runners |
| `run.ts` prints `SKIPPED` on stdout and the `REQUIRE_HOSTS` failure on stderr | the smoke test and walkthrough (a) read a skip from the last line of stdout |
| `migrate` rewrites a file only when every record in it migrates; discover errors block `--write`; the summary counts files | `--write` writes nothing while any error stands, so a rerun after a fix starts from unchanged files |
| `gen` writes `types.gen.ts` even when entry files named by a manifest are still missing, and exits 1 | a new module is generated before its code is written |
| The web host reports a failure in the page and then rejects; `serve.ts` answers only local `Host` names, 400 for a malformed escape, 405 with `Allow`, 500 for a `.ts` syntax error or a bundle that is not JSON | one typed failure path; no DNS rebinding |
| `render_boxes.draw` clears its queue also without `clickBody` | clicks never pile up |
| Walkthrough (a) runs Python for 300 ticks | the three contacts come in the 34th, 43rd and 51st ticks, so a short run never reaches the Python damage code |

## Size

Non-generated lines of `tools/`, `hosts/` and `examples/`, measured on 2026-10-21. Only text files count (TypeScript, Python, JSON, Markdown, HTML), and generated files are left out: every `types.gen.ts`, the golden trace bundles and the bundle snapshot. Fixtures are the files under `tools/repo/test/fixtures/roots/`; tests are `*.test.ts` and Python's `test_*.py`; code is everything else, JSON schemas, manifests, records and traces included.

| Folder | Code | Tests | Fixtures | Total |
|---|---|---|---|---|
| `tools/` | 2,885 | 6,208 | 1,554 | 10,647 |
| `hosts/` | 1,946 | 2,674 | 0 | 4,620 |
| `examples/` | 570 | 340 | 0 | 910 |
| Total | 5,401 | 9,222 | 1,554 | 16,177 |

Of the code, 4,488 lines are TypeScript and Python, 789 JSON and 124 Markdown and HTML; all test lines are TypeScript and Python. The ruling estimated about 3,500 lines of TypeScript and Python including tests; the measured figure is 13,710, of which two thirds are tests (D30).

The count, in Git Bash from the repository root:

```text
git ls-files tools hosts examples | grep -E '\.(ts|py|json|md|html)$' | grep -vE 'types\.gen\.ts$|/golden/' |
  while read -r f; do
    case "$f" in tools/repo/test/fixtures/*) k=fixtures ;; *.test.ts|*/test_*.py) k=tests ;; *) k=code ;; esac
    case "$f" in *.ts|*.py) x=ts-py ;; *.json) x=json ;; *) x=md-html ;; esac
    echo "${f%%/*} $k $x $(wc -l < "$f")"
  done | awk '{ n[$1" "$2" "$3] += $4 } END { for (k in n) print k, n[k] }' | sort
```
