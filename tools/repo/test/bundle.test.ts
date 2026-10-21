// Tests for tools/repo/lib/bundle.ts: the exact bundle of ok-compose, determinism, the schema, host filtering and the parts of a bundle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildBundle, bundlePath } from '../lib/bundle.ts';
import { gameComposition } from '../lib/composition.ts';
import { loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { formatJson, writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import type { Problem } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

type Files = Record<string, Json | string>;

// A temporary repository that has the real schemas/ folder and the given files (repo-relative path -> JSON or text).
function tempRepo(t: TestContext, files: Files): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(repoRoot, 'schemas'), path.join(dir, 'schemas'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(dir, ...file.split('/'));
    if (typeof content === 'string') writeText(abs, content);
    else writeJson(abs, content);
  }
  return dir;
}

function build(repo: string, root: string, game: string, host: string) {
  const validator = createValidator(repo);
  const index = discover(repo, root, validator);
  const g = index.games.get(game)!;
  return buildBundle({ index, records: loadRecords(index, validator).records, composition: gameComposition(g), host, game: g.id, fixedHz: g.fixedHz, validator });
}

function where(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}`).sort();
}

const OK = `${FIXTURES}/ok-compose`;

test('ok-compose with_extra for node builds to the exact bundle', () => {
  const built = build(repoRoot, OK, 'with_extra', 'node');
  assert.deepEqual(built.problems, []);
  assert.deepEqual(built.bundle, {
    format: 1,
    game: 'with_extra',
    host: 'node',
    fixedHz: 60,
    modules: [
      { id: 'extra', entry: `${OK}/modules/extra/ts/index.ts`, sees: ['extra'], absent: [], packages: [] },
      { id: 'impl', entry: `${OK}/modules/impl/ts/index.ts`, sees: ['api', 'impl'], absent: [], packages: [] },
      { id: 'feature', entry: `${OK}/modules/feature/ts/index.ts`, sees: ['api', 'extra', 'feature'], absent: [], packages: [] },
      { id: 'view', entry: `${OK}/modules/view/ts/index.ts`, sees: ['api', 'view'], absent: [], packages: [] },
    ],
    contracts: { api: 'impl' },
    operations: {},
    events: {},
    types: {},
    config: { api: {}, extra: {}, feature: {}, impl: {}, view: {} },
    records: {},
    assets: [],
    schedule: { fixed: ['extra.tick_extra', 'impl.step', 'feature.act'], frame: ['view.draw'] },
    schemas: { state: {}, events: {}, params: {}, results: {} },
  });
  assert.deepEqual(built.resolution.order, ['extra', 'impl', 'feature', 'view']);
});

test('two builds give identical text, with the top-level keys in the order of 4.7.4', () => {
  const first = build(repoRoot, OK, 'with_extra', 'node').bundle!;
  const second = build(repoRoot, OK, 'with_extra', 'node').bundle!;
  assert.equal(formatJson(first as unknown as Json), formatJson(second as unknown as Json));
  assert.deepEqual(Object.keys(first), ['format', 'game', 'host', 'fixedHz', 'modules', 'contracts', 'operations', 'events', 'types', 'config', 'records', 'assets', 'schedule', 'schemas']);
});

test('every built bundle validates against schemas/bundle.schema.json', () => {
  const validator = createValidator(repoRoot);
  for (const [game, host] of [['with_extra', 'node'], ['without_extra', 'node'], ['limited', 'node'], ['limited', 'web']]) {
    const bundle = build(repoRoot, OK, game, host).bundle;
    assert.ok(bundle, `${game} ${host}`);
    assert.deepEqual(validator.validate('schemas/bundle.schema.json', bundle, 'bundle.json'), [], `${game} ${host}`);
  }
});

test('bundlePath puts the bundle under build/<root>/games/<game>/<host>, and root . adds nothing', () => {
  assert.equal(bundlePath('.', 'g', 'node'), 'build/games/g/node/bundle.json');
  assert.equal(bundlePath('examples', 'sandbox', 'web'), 'build/examples/games/sandbox/web/bundle.json');
  assert.equal(bundlePath('hosts/conformance', 'g', 'python'), 'build/hosts/conformance/games/g/python/bundle.json');
});

test('an entry with hosts joins only the builds for those hosts', () => {
  const ids = (host: string): string[] => build(repoRoot, OK, 'limited', host).bundle!.modules.map((m) => m.id);
  assert.deepEqual(ids('node'), ['impl', 'feature']);
  assert.deepEqual(ids('web'), ['impl', 'feature', 'view']);
  assert.deepEqual(build(repoRoot, OK, 'limited', 'node').bundle!.modules[1].absent, ['extra']);
});

test('an entry for another host is ignored with its config: each host merges only its own overrides', (t) => {
  const module = (id: string, fields: Record<string, Json> = {}): Files => ({
    [`modules/${id}/module.json`]: { id, summary: 'x', hosts: { node: 'ts/index.ts', web: 'ts/index.ts' }, ...fields },
    [`modules/${id}/ts/index.ts`]: 'export {};\n',
  });
  const game = (helper: Json): Files => ({ 'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node', 'web'], fixedHz: 60, modules: { core: {}, helper } } });
  const files: Files = {
    ...module('core', { requires: ['helper'] }),
    ...module('helper', { config: { schema: 'schemas/config.schema.json', defaults: { speed: 1 } } }),
    'modules/helper/schemas/config.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, required: ['speed'], properties: { speed: { type: 'integer' } } },
  };
  const dir = tempRepo(t, { ...files, ...game({ hosts: ['web'], config: { speed: 5 } }) });
  assert.deepEqual(build(dir, '.', 'demo', 'node').bundle!.config.helper, { speed: 1 });
  assert.deepEqual(build(dir, '.', 'demo', 'web').bundle!.config.helper, { speed: 5 });
  assert.deepEqual(build(dir, '.', 'demo', 'node').bundle!.modules.map((m) => m.id), ['helper', 'core']);

  const broken = tempRepo(t, { ...files, ...game({ hosts: ['web'], config: { speed: 'fast' } }) });
  assert.deepEqual(build(broken, '.', 'demo', 'node').problems, []);
  assert.deepEqual(where(build(broken, '.', 'demo', 'web').problems), ['error bad-config games/demo/game.json#/modules/helper/config']);
});

test('operations, events, types, config, records, assets and schemas come from the selected modules, in sorted maps', (t) => {
  const record = (extra: Json): Json => ({ $version: 1, size: [1, 1, 1], ...(extra as object) });
  const dir = tempRepo(t, {
    'modules/shapes/module.json': {
      id: 'shapes',
      summary: 'x',
      contract: true,
      types: { box: 'schemas/box.schema.json' },
      events: { made: 'schemas/made.schema.json' },
      operations: { list: {}, area: { params: 'schemas/area_params.schema.json', result: 'schemas/area_result.schema.json' } },
      config: { schema: 'schemas/config.schema.json', defaults: { unit: 'm', limit: 3 } },
    },
    'modules/shapes/schemas/box.schema.json': {
      $schema: DRAFT, type: 'object', additionalProperties: false, required: ['$version', 'size'],
      properties: {
        $schema: { type: 'string' }, $version: { const: 1 }, $comment: { type: 'string' },
        size: { type: 'array', items: { type: 'number' } }, model: { type: 'string', 'x-asset': ['glb'] },
      },
    },
    'modules/shapes/schemas/made.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false },
    'modules/shapes/schemas/area_params.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false },
    'modules/shapes/schemas/area_result.schema.json': { $schema: DRAFT, type: 'number' },
    'modules/shapes/schemas/config.schema.json': {
      $schema: DRAFT, type: 'object', additionalProperties: false, required: ['unit', 'limit'], properties: { unit: { type: 'string' }, limit: { type: 'integer' } },
    },
    'modules/shapes_impl/module.json': {
      id: 'shapes_impl',
      summary: 'x',
      implements: ['shapes'],
      state: 'schemas/state.schema.json',
      operations: { peek: {} },
      systems: [{ name: 'step', loop: 'fixed' }],
      hosts: { node: 'ts/index.ts' },
      packages: ['node:path', 'node:fs'],
    },
    'modules/shapes_impl/schemas/state.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false },
    'modules/shapes_impl/ts/index.ts': 'export {};\n',
    'modules/pack/module.json': { id: 'pack', summary: 'x', requires: ['shapes'] },
    'modules/pack/assets/crate.glb': 'glTF',
    'modules/pack/content/shapes.box/crate.json': record({ model: 'assets/crate.glb' }),
    'modules/unused/module.json': { id: 'unused', summary: 'x', requires: ['shapes'] },
    'modules/unused/content/shapes.box/spare.json': record({}),
    'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node'], fixedHz: 30, modules: { shapes_impl: {}, pack: {}, shapes: { config: { limit: 5 } } } },
  });
  const built = build(dir, '.', 'demo', 'node');
  assert.deepEqual(built.problems, []);
  const bundle = built.bundle!;
  assert.deepEqual(bundle, {
    format: 1,
    game: 'demo',
    host: 'node',
    fixedHz: 30,
    modules: [{ id: 'shapes_impl', entry: 'modules/shapes_impl/ts/index.ts', sees: ['shapes', 'shapes_impl'], absent: [], packages: ['node:fs', 'node:path'] }],
    contracts: { shapes: 'shapes_impl' },
    operations: { 'shapes.area': 'shapes_impl', 'shapes.list': 'shapes_impl', 'shapes_impl.peek': 'shapes_impl' },
    events: { 'shapes.made': 'shapes' },
    types: { 'shapes.box': 1 },
    config: { pack: {}, shapes: { unit: 'm', limit: 5 }, shapes_impl: {} },
    records: { 'shapes.box': { 'pack/crate': { size: [1, 1, 1], model: 'modules/pack/assets/crate.glb' } } },
    assets: ['modules/pack/assets/crate.glb'],
    schedule: { fixed: ['shapes_impl.step'], frame: [] },
    schemas: {
      state: { shapes_impl: 'modules/shapes_impl/schemas/state.schema.json' },
      events: { 'shapes.made': 'modules/shapes/schemas/made.schema.json' },
      params: { 'shapes.area': 'modules/shapes/schemas/area_params.schema.json' },
      results: { 'shapes.area': 'modules/shapes/schemas/area_result.schema.json' },
    },
  });
  for (const map of [bundle.contracts, bundle.operations, bundle.events, bundle.types, bundle.config, bundle.records, bundle.schemas!.state, bundle.schemas!.params]) {
    assert.deepEqual(Object.keys(map), Object.keys(map).sort());
  }
  assert.deepEqual(createValidator(dir).validate('schemas/bundle.schema.json', bundle, 'bundle.json'), []);
});

test('records of a module that is not selected stay out; records within a type are sorted by id', (t) => {
  const dir = tempRepo(t, {
    'modules/kinds/module.json': { id: 'kinds', summary: 'x', types: { item: 'schemas/item.schema.json' } },
    'modules/kinds/schemas/item.schema.json': {
      $schema: DRAFT, type: 'object', additionalProperties: false, required: ['$version'],
      properties: { $schema: { type: 'string' }, $version: { const: 1 }, $comment: { type: 'string' } },
    },
    'modules/kinds/content/kinds.item/zed.json': { $version: 1 },
    'modules/kinds/content/kinds.item/alpha.json': { $version: 1 },
    'modules/left/module.json': { id: 'left', summary: 'x', requires: ['kinds'] },
    'modules/left/content/kinds.item/mid.json': { $version: 1 },
    'modules/right/module.json': { id: 'right', summary: 'x', requires: ['kinds'] },
    'modules/right/content/kinds.item/skipped.json': { $version: 1 },
    'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node'], fixedHz: 60, modules: { left: {} } },
  });
  assert.deepEqual(build(dir, '.', 'demo', 'node').bundle!.records, { 'kinds.item': { 'kinds/alpha': {}, 'kinds/zed': {}, 'left/mid': {} } });
  assert.deepEqual(Object.keys(build(dir, '.', 'demo', 'node').bundle!.records['kinds.item']), ['kinds/alpha', 'kinds/zed', 'left/mid']);
});

test('an error from resolve gives no bundle but still the resolution and the problems', () => {
  const built = build(repoRoot, `${FIXTURES}/no-provider`, 'demo', 'node');
  assert.equal(built.bundle, undefined);
  assert.deepEqual(built.problems.map((p) => p.rule), ['no-provider']);
  assert.deepEqual(built.resolution.selected, ['api', 'user']);
});

test('errors of schedule and of config also stop the bundle', () => {
  assert.equal(build(repoRoot, `${FIXTURES}/cycle-systems`, 'demo', 'node').bundle, undefined);
  assert.equal(build(repoRoot, `${FIXTURES}/unknown-ref`, 'demo', 'node').bundle, undefined);
  const built = build(repoRoot, `${FIXTURES}/bad-config`, 'demo', 'node');
  assert.equal(built.bundle, undefined);
  assert.deepEqual(built.problems.map((p) => p.rule), ['bad-config']);
});

test('a warning alone does not stop the bundle and comes back with it', (t) => {
  const dir = tempRepo(t, {
    'modules/old/module.json': { id: 'old', summary: 'x', deprecated: 'Use new.', hosts: { node: 'ts/index.ts' } },
    'modules/old/ts/index.ts': 'export {};\n',
    'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node'], fixedHz: 60, modules: { old: {} } },
  });
  const built = build(dir, '.', 'demo', 'node');
  assert.deepEqual(where(built.problems), ['warning deprecated games/demo/game.json#/modules/old']);
  assert.deepEqual(built.bundle!.modules.map((m) => m.id), ['old']);
});

test('every map is sorted whatever the manifest order and the order of the records given, and unselected modules add nothing', (t) => {
  const object: Json = { $schema: DRAFT, type: 'object', additionalProperties: false };
  const type = (props: Record<string, Json> = {}): Json => ({
    $schema: DRAFT, type: 'object', additionalProperties: false, required: ['$version'],
    properties: { $schema: { type: 'string' }, $version: { const: 1 }, $comment: { type: 'string' }, ...props },
  });
  const impl = (id: string, contract: string): Files => ({
    [`modules/${id}/module.json`]: { id, summary: 'x', implements: [contract], hosts: { node: 'ts/index.ts' } },
    [`modules/${id}/ts/index.ts`]: 'export {};\n',
  });
  const dir = tempRepo(t, {
    'modules/base/module.json': { id: 'base', summary: 'x', contract: true },
    'modules/api/module.json': { id: 'api', summary: 'x', contract: true },
    ...impl('base_impl', 'base'),
    ...impl('impl', 'api'),
    'modules/app/module.json': {
      id: 'app',
      summary: 'x',
      requires: ['base', 'api'],
      types: { zulu: 'schemas/zulu.schema.json', alpha: 'schemas/alpha.schema.json' },
      events: { zap: 'schemas/object.schema.json', bang: 'schemas/object.schema.json' },
      operations: {
        zoom: { params: 'schemas/object.schema.json', result: 'schemas/object.schema.json' },
        aim: { params: 'schemas/object.schema.json', result: 'schemas/object.schema.json' },
      },
      hosts: { node: 'ts/index.ts' },
    },
    'modules/app/ts/index.ts': 'export {};\n',
    'modules/app/schemas/object.schema.json': object,
    'modules/app/schemas/zulu.schema.json': type(),
    'modules/app/schemas/alpha.schema.json': type({ model: { type: 'string', 'x-asset': ['glb'] } }),
    'modules/app/assets/a.glb': 'glTF',
    'modules/app/assets/b.glb': 'glTF',
    'modules/app/content/app.alpha/one.json': { $version: 1, model: 'assets/a.glb' },
    'modules/app/content/app.alpha/two.json': { $version: 1, model: 'assets/a.glb' },
    'modules/app/content/app.alpha/three.json': { $version: 1, model: 'assets/b.glb' },
    'modules/app/content/app.zulu/z.json': { $version: 1 },
    'modules/idle/module.json': {
      id: 'idle', summary: 'x', types: { thing: 'schemas/thing.schema.json' }, events: { idled: 'schemas/object.schema.json' }, operations: { nap: {} }, hosts: { node: 'ts/index.ts' },
    },
    'modules/idle/ts/index.ts': 'export {};\n',
    'modules/idle/schemas/object.schema.json': object,
    'modules/idle/schemas/thing.schema.json': type(),
    'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node'], fixedHz: 60, modules: { app: {}, impl: {}, base_impl: {} } },
  });
  const validator = createValidator(dir);
  const index = discover(dir, '.', validator);
  const loaded = loadRecords(index, validator);
  assert.deepEqual(loaded.problems, []);
  const game = index.games.get('demo')!;
  const built = buildBundle({ index, records: [...loaded.records].reverse(), composition: gameComposition(game), host: 'node', game: 'demo', fixedHz: 60, validator });
  assert.deepEqual(built.problems, []);
  const bundle = built.bundle!;
  const s = bundle.schemas!;
  assert.deepEqual(
    [bundle.contracts, bundle.operations, bundle.events, bundle.types, bundle.config, bundle.records, bundle.records['app.alpha'], s.events, s.params, s.results].map((map) => Object.keys(map)),
    [
      ['api', 'base'],
      ['app.aim', 'app.zoom'],
      ['app.bang', 'app.zap'],
      ['app.alpha', 'app.zulu'],
      ['api', 'app', 'base', 'base_impl', 'impl'],
      ['app.alpha', 'app.zulu'],
      ['app/one', 'app/three', 'app/two'],
      ['app.bang', 'app.zap'],
      ['app.aim', 'app.zoom'],
      ['app.aim', 'app.zoom'],
    ],
  );
  assert.deepEqual(bundle.assets, ['modules/app/assets/a.glb', 'modules/app/assets/b.glb']);
  assert.deepEqual([Object.keys(bundle.modules[0]), Object.keys(bundle.schedule), Object.keys(s)], [['id', 'entry', 'sees', 'absent', 'packages'], ['fixed', 'frame'], ['state', 'events', 'params', 'results']]);
});
