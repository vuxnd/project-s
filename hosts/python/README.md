# Python host

Runs bundles and compiled traces on Python 3.11 or newer. Standard library only.

| File | Role |
|---|---|
| `runtime.py` | `load(bundle, root, host, debug, importer, validate)`: the runtime contract C5 for Python |
| `conformance.py` | Trace runner: runs trace bundles and prints `PASS` or `FAIL` per file |
| `play.py` | Bundle player: runs a bundle and prints its snapshot and event counts |
| `run.ts` | Node launcher: finds Python 3.11 or newer and runs it as `python -I -B` |
| `test_*.py`, `run.test.ts` | Tests |

## Run

From the repository root, always through the launcher:

```sh
node hosts/python/run.ts -m unittest discover -s hosts/python -p "test_*.py"
node hosts/python/run.ts hosts/python/conformance.py build/traces/python
node hosts/python/run.ts hosts/python/play.py build/examples/games/sandbox/python/bundle.json 300
```

`run.ts` tries `python3`, `python` and `py -3` and takes the first that runs and reports 3.11 or newer. Without one it prints `SKIPPED python (not found)` and exits 0; with `REQUIRE_HOSTS=python` in the environment it exits 1 instead. `-I -B` keeps the current directory off `sys.path` and writes no `__pycache__`. Scripts in this folder add their own folder to `sys.path` before importing `runtime`.

- `conformance.py <dir>...` runs every `*.json` file below each directory as a trace bundle (`schemas/trace-bundle.schema.json`) and prints `python: <passed> passed, <failed> failed`. Exit 0 when nothing failed, 1 when a file failed or none was found, 2 for a usage error.
- `play.py <bundle.json> <ticks>` prints one JSON line with the final state of each module and how often each event was emitted. Exit 1 on an error, 2 for a usage error or a bundle for another host.

## Contract

- The formats read: bundle format 1 (`FORMATS = (1,)`). Any other format raises `BundleError('bundle format <n>; this host reads 1')`.
- `ctx.host` is `{}` in `conformance.py` and `play.py`. A host program passes its own value to `load`.
- Module entries are loaded by file path with no package and no `sys.path` entry, so a Python entry cannot import a sibling file: one file per Python entry.

Differences from the JavaScript host:

- `load` is synchronous and errors are `BundleError`, with the same message text.
- `ctx.config_of(id)` replaces `ctx.configOf(id)`.
- Records and config are plain dicts and lists, not frozen.
- The state comparison of R9 is `json.dumps(state, sort_keys=False)` text.
- The JSON-clean copy of R18 is `json.loads(json.dumps(value, allow_nan=False))` with `-0.0` turned into `0.0`. A value that `json.dumps` rejects, or whose copy is not equal to it (a tuple, a set, a non-string key), raises `BundleError('<kind> not JSON: <id>')`.
- The promise check of R16 does not apply: Python has no promise.
- `validate` is accepted and used as on JavaScript hosts; the runners in this folder pass none.
