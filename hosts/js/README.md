# JavaScript host

`runtime.ts` loads a bundle and runs its fixed and frame loops (contract C5, described in ARCHITECTURE.md). It imports nothing outside this folder and uses no Node or DOM API, so Node and the browser run the same file. `trace.ts` holds the types of a trace bundle.

Formats read: 1. Any other `bundle.format` makes `load` fail with `bundle format <n>; this host reads 1`. Fields the host does not know, at the bundle root and in `modules[]`, are ignored.

## Calling `load` from Node

```ts
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from './hosts/js/runtime.ts';
import type { Bundle } from './hosts/js/runtime.ts';

const repoRoot = path.resolve('.');
const bundle = JSON.parse(fs.readFileSync('build/games/demo/node/bundle.json', 'utf8')) as Bundle;
const game = await load(bundle, { root: pathToFileURL(repoRoot + path.sep).href, host: {} });
for (let i = 0; i < 300; i++) game.tick();
console.log(game.snapshot());
```

- `root` is prepended to each module entry path for the default `import()`. On Node it is the repository folder as a `file:` URL ending in a separator; the web host passes `/`.
- `host` becomes `ctx.host` in every module. On node it is `{}`.
- `importer(entry)` replaces the default `import(root + entry)`; tests use it to hand out inline modules.
- `game.tick(inputs?)` runs the fixed systems once and `game.frame(dt, alpha)` the frame systems; both return the events emitted during that run. `game.call(id, params?)` runs an operation from the host. `game.snapshot()` returns a JSON copy of every module's state. `game.ticks` counts completed fixed ticks.

## Debug mode

`debug: true` checks that state, event payloads, params and results are JSON (a NaN or infinite number, an `undefined`, a class instance or a cycle throws `<kind> not JSON: <id>`; `-0` becomes `0`), hands out frozen copies of payloads and results, and rejects an operation that a frame system calls and that changes its provider's state.

With `validate(schema, value)` as well, state, payloads, params and results are checked against the schema paths in `bundle.schemas`; it returns an error text or `null`. The Node trace runner builds it from `createValidator(repoRoot).errors` in `tools/repo/lib/validate.ts`.
