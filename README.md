# Project S

Engine-neutral game foundation. Games are built from modules and compositions described by JSON files, and each file kind has a JSON Schema in `schemas/`.

## Prerequisites

- Node.js 24.12 or newer.
- Python 3.11 or newer (optional).

## Setup and test

```sh
npm ci
npm test
```

## Folders

- `.github/workflows/`: CI.
- `games/`: game compositions (`<id>/game.json`).
- `modules/`: game modules (`<id>/module.json`).
- `schemas/`: JSON Schemas for manifests, bundles and traces.
- `tools/repo/`: the repository tool, its libraries and tests.
