# Web host

`index.html` is the page, `host.ts` the browser host and `serve.ts` the dev server. The host fetches a web bundle, loads it on `../runtime.ts` and drives the fixed-step loop from `requestAnimationFrame`.

## Run the sandbox game

```sh
npm run build -- sandbox --host web --root examples
npm run serve
```

Open `http://127.0.0.1:8080/hosts/js/web/index.html?root=examples&game=sandbox`. `npm run serve -- --port <n>` changes the port.

The address names the bundle: `?root=<root>&game=<game>` loads `/build/<root>/games/<game>/web/bundle.json`, and `root=.` loads `/build/games/<game>/web/bundle.json`. A missing or malformed parameter shows `usage: ?root=<root>&game=<game>`, a missing bundle shows the build command to run, and a bundle whose `host` is not `web` is refused.

## The loop

Each animation frame adds the time since the last one (at most 0.25 s) to an accumulator, runs one `game.tick()` for every `1 / fixedHz` in it (at most 8 per frame; a larger backlog is dropped), then runs `game.frame(dt, alpha)` once. `alpha` is the leftover fraction of a tick. The first frame only draws. The loop stops at the first error that module code throws and shows its message.

## `ctx.host`

`ctx.host` is `{ canvas, audio }`: the `<canvas id="view">`, sized to its client size at load, and an `AudioContext` that the first `pointerdown` or `keydown` resumes. On node and python `ctx.host` is `{}`.

## Input

Input enters through `web/` modules, never through `host.ts`, which calls `game.tick()` without inputs. A module's `init` attaches listeners to `ctx.host.canvas` and queues each input in `ctx.state`. A frame system emits the queued inputs as events of a gameplay module, one event per input, and clears the queue; fixed systems read the events in the next tick. Frame systems emit only discrete events, never one per frame run. `examples/modules/render_boxes/web/index.ts` is the example.

## Dev server

`serve.ts` serves the repository on `127.0.0.1` for GET and HEAD. A `.ts` file is sent as `text/javascript` with its types stripped by `module.stripTypeScriptTypes`, which Node marks experimental, so `npm run serve` passes `--disable-warning=ExperimentalWarning`. `index.html` gets an empty import map. A path with a NUL, a `..` segment, or a target outside the repository is 403.

No npm package is served yet. A web bundle whose modules list a package other than a `node:` built-in gets 500 `packages are not served by the dev server yet`; the page then shows the `bundle not found` text, and the response body is in the browser's network panel. The `packages` field of the bundle is where serving them would start.

## Tests

`test/host.test.ts` runs `bundleUrl`, `step` with fake clocks and `start` with a fake environment. `test/serve.test.ts` runs the server over HTTP from Node. Pixels and sound are not tested automatically: nothing checks that the canvas shows boxes or that a tone plays. Open the game in a browser to see both.
