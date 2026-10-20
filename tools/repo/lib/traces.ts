// Lists the conformance traces of a root and compiles each for every implementation and host into a trace bundle (plan.md 4.7.5, 4.7.6).
import type { TraceBundle } from '../../../hosts/js/trace.ts';
import { buildBundle } from './bundle.ts';
import { traceComposition } from './composition.ts';
import type { Composition, TraceDoc } from './composition.ts';
import { checkRecord } from './content.ts';
import type { RecordInfo, RecordSource } from './content.ts';
import type { ModuleInfo, RootIndex } from './discover.ts';
import { absPath, isDir, joinPosix, listFiles, relativePosix } from './fsx.ts';
import { joinPointer, readJson } from './json.ts';
import type { JsonObject } from './json.ts';
import { error, hasErrors } from './problems.ts';
import type { Problem } from './problems.ts';
import { resolve } from './resolve.ts';
import type { Validator } from './validate.ts';

export interface TraceInfo { contract: string; name: string; file: string; doc: TraceDoc }

const CALL_KEYS = ['at', 'call', 'params', 'pointer', 'equals', 'near', 'within'];
const COUNT_KEYS = ['by', 'emitted', 'count'];

function byId(a: ModuleInfo, b: ModuleInfo): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function traceBundlePath(root: string, host: string, implementation: string, contract: string, name: string): string {
  return joinPosix('build', root, 'traces', host, implementation, `${contract}.${name}.json`);
}

export function listTraces(index: RootIndex, validator: Validator): { traces: TraceInfo[]; problems: Problem[] } {
  const traces: TraceInfo[] = [];
  const problems: Problem[] = [];
  for (const m of [...index.modules.values()].sort(byId)) {
    const dir = `${m.dir}/conformance`;
    if (!m.contract) {
      if (isDir(absPath(index.repoRoot, dir))) problems.push(error(dir, '', 'contract-shape', `${m.id} is not a contract; only a contract has conformance traces`));
      continue;
    }
    for (const base of listFiles(absPath(index.repoRoot, dir)).filter((f) => f.endsWith('.json'))) {
      const file = `${dir}/${base}`;
      const parsed = readJson(absPath(index.repoRoot, file));
      if (!parsed.ok) {
        problems.push(error(file, '', 'json-parse', parsed.message, parsed.line));
        continue;
      }
      const invalid = validator.validate('schemas/trace.schema.json', parsed.value, file);
      if (invalid.length > 0) {
        problems.push(...invalid);
        continue;
      }
      const expected = relativePosix(dir, 'schemas/trace.schema.json');
      const written = (parsed.value as JsonObject).$schema;
      if (written !== undefined && written !== expected) problems.push(error(file, '/$schema', 'schema-path', `$schema is ${written}; expected ${expected}`));
      traces.push({ contract: m.id, name: base.slice(0, -'.json'.length), file, doc: parsed.value as unknown as TraceDoc });
    }
  }
  return { traces, problems };
}

// The module that declares `id`, written `<module>.<name>`, as one of its events or operations.
function declaringModule(index: RootIndex, id: string, kind: 'events' | 'operations'): ModuleInfo | undefined {
  const dot = id.indexOf('.');
  const m = dot < 0 ? undefined : index.modules.get(id.slice(0, dot));
  return m !== undefined && Object.hasOwn(m[kind], id.slice(dot + 1)) ? m : undefined;
}

// The checks of 4.7.5 that read the trace against its composition and the root; every problem is at the trace file.
function checkTrace(index: RootIndex, validator: Validator, trace: TraceInfo, composition: Composition, selected: ReadonlySet<string>): Problem[] {
  const { doc, file } = trace;
  const problems: Problem[] = [];
  const fail = (rule: 'trace-expect' | 'trace-unknown' | 'bad-config', pointer: string, message: string): void => {
    problems.push(error(file, pointer, rule, message));
  };
  const inComposition = (id: string, kind: 'events' | 'operations'): ModuleInfo | undefined => {
    const m = declaringModule(index, id, kind);
    return m !== undefined && selected.has(m.id) ? m : undefined;
  };

  for (const key of Object.keys(doc.config ?? {})) {
    if (!Object.hasOwn(composition.modules, key)) fail('bad-config', joinPointer('/config', key), `${key} is not the contract, the implementation or a module of this trace`);
  }

  (doc.inputs ?? []).forEach((input, i) => {
    if (input.at >= doc.ticks) fail('trace-expect', joinPointer('/inputs', i, 'at'), `input at ${input.at} is not before ticks ${doc.ticks}`);
    const m = inComposition(input.event, 'events');
    if (m === undefined) fail('trace-unknown', joinPointer('/inputs', i, 'event'), `${input.event} is not an event of this composition`);
    else problems.push(...validator.validate(m.events[input.event.slice(m.id.length + 1)], input.payload, file, joinPointer('/inputs', i, 'payload')));
  });

  doc.expect.forEach((e, i) => {
    const at = (...tokens: string[]): string => joinPointer('/expect', i, ...tokens);
    const has = (key: string): boolean => Object.hasOwn(e, key);
    const countForm = COUNT_KEYS.some(has);
    if (countForm && CALL_KEYS.some(has)) {
      fail('trace-expect', at(), 'mixes the call form (at, call) with the count form (by, emitted, count)');
    } else if (countForm) {
      if (!COUNT_KEYS.every(has)) {
        fail('trace-expect', at(), 'the count form needs by, emitted and count');
      } else {
        if (e.by! > doc.ticks) fail('trace-expect', at('by'), `by ${e.by} is after ticks ${doc.ticks}`);
        if (declaringModule(index, e.emitted!, 'events') === undefined) fail('trace-unknown', at('emitted'), `${e.emitted} is not an event of any module of this root`);
      }
    } else if (!has('at') || !has('call') || !(has('equals') ? !has('near') && !has('within') : has('near') && has('within'))) {
      fail('trace-expect', at(), 'the call form needs at, call, and equals or near with within');
    } else {
      if (e.at! > doc.ticks) fail('trace-expect', at('at'), `at ${e.at} is after ticks ${doc.ticks}`);
      if (inComposition(e.call!, 'operations') === undefined) fail('trace-unknown', at('call'), `${e.call} is not an operation of this composition`);
    }
  });
  return problems;
}

// A problem of resolve or resolveConfig at the trace file, moved from the composition's pointer to the trace's own.
function atTrace(p: Problem, trace: TraceInfo, own: ReadonlySet<string>): Problem {
  if (p.file !== trace.file) return p;
  const config = /^\/([^/]+)\/config$/.exec(p.pointer);
  if (config) return { ...p, pointer: joinPointer('/config', config[1]) };
  const id = /^\/([^/]+)$/.exec(p.pointer)?.[1];
  if (id === undefined) return p;
  const i = own.has(id) ? -1 : (trace.doc.modules ?? []).indexOf(id);
  return { ...p, pointer: i < 0 ? '' : joinPointer('/modules', i) };
}

function compileOne(index: RootIndex, records: readonly RecordInfo[], trace: TraceInfo, contract: ModuleInfo, implementation: ModuleInfo, host: string, validator: Validator): { value?: TraceBundle; problems: Problem[] } {
  const { doc, file } = trace;
  const composition = traceComposition(contract, implementation, doc, file);
  const selected = new Set(resolve(index, composition, host).selected);
  const problems = checkTrace(index, validator, trace, composition, selected);

  const sources: RecordSource[] = Object.entries(doc.records ?? {}).flatMap(([type, byName]) =>
    Object.entries(byName).map(([name, value]) => ({ type, id: `trace/${name}`, module: 'trace', file, pointer: joinPointer('/records', type, name), value })));
  const known = new Set([...records.filter((r) => selected.has(r.module)).map((r) => `${r.type} ${r.id}`), ...sources.map((s) => `${s.type} ${s.id}`)]);
  const traceRecords: RecordInfo[] = [];
  for (const source of sources) {
    const checked = checkRecord(index, validator, source, known);
    problems.push(...checked.problems);
    if (checked.record) traceRecords.push(checked.record);
  }

  const built = buildBundle({ index, records: [...records, ...traceRecords], composition, host, game: `${trace.contract}.${trace.name}`, fixedHz: doc.fixedHz, validator });
  problems.push(...built.problems.map((p) => atTrace(p, trace, new Set([contract.id, implementation.id]))));
  if (hasErrors(problems) || built.bundle === undefined) return { problems };
  return {
    value: { trace: file, contract: contract.id, implementation: implementation.id, ticks: doc.ticks, bundle: built.bundle, inputs: doc.inputs ?? [], expect: doc.expect },
    problems,
  };
}

export function compileTraces(index: RootIndex, records: readonly RecordInfo[], traces: readonly TraceInfo[], hosts: readonly string[] | 'all', validator: Validator): { bundles: { path: string; value: TraceBundle }[]; problems: Problem[] } {
  const bundles: { path: string; value: TraceBundle }[] = [];
  const problems: Problem[] = [];
  const modules = [...index.modules.values()].sort(byId);
  for (const trace of traces) {
    const contract = index.modules.get(trace.contract);
    if (contract === undefined) continue;
    for (const implementation of modules.filter((m) => m.implements.includes(trace.contract))) {
      const wanted = hosts === 'all' ? Object.keys(implementation.hosts).sort() : [...new Set(hosts)];
      for (const host of wanted.filter((h) => Object.hasOwn(implementation.hosts, h))) {
        const compiled = compileOne(index, records, trace, contract, implementation, host, validator);
        problems.push(...compiled.problems);
        if (compiled.value !== undefined) bundles.push({ path: traceBundlePath(index.root, host, implementation.id, trace.contract, trace.name), value: compiled.value });
      }
    }
  }
  return { bundles, problems };
}
