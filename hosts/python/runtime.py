"""Bundle runtime (contract C5) for Python hosts: load a bundle and run it."""
import importlib.util
import json
import os
import sys
from collections.abc import Callable
from typing import Any

FORMATS = (1,)

_Events = list[dict[str, Any]]

# The bundle.schemas group that names the schema of each kind of value.
_SCHEMA_GROUP = {
    'state': 'state',
    'event': 'events',
    'params': 'params',
    'result': 'results',
}


class BundleError(Exception):
    """An error with a contract message; the text is the same on every host."""


def _float(text: str) -> float:
    # json.loads hook: a zero literal, also -0.0, becomes 0.0.
    return float(text) or 0.0


def _clean(value: Any, kind: str, target: str) -> Any:
    """Return the JSON-clean copy of value (R18) or raise BundleError."""
    try:
        copy = json.loads(json.dumps(value, allow_nan=False),
                          parse_float=_float)
    except (TypeError, ValueError) as e:
        raise BundleError(f'{kind} not JSON: {target}') from e
    if copy != value:
        raise BundleError(f'{kind} not JSON: {target}')
    return copy


def _import_file(root: str, module_id: str, entry: str) -> Any:
    # A fresh module object per call, loaded by file path and registered in
    # sys.modules, where dataclasses look it up while it runs.
    path = os.path.join(root, *entry.split('/'))
    spec = importlib.util.spec_from_file_location(
        'bundle_module_' + module_id, path)
    if spec is None or spec.loader is None or not os.path.isfile(path):
        raise BundleError(f'cannot import: {entry}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Ctx:
    """What a module's code receives: its state, config and allowed calls."""

    def __init__(self, game: 'Game', module: str, info: dict[str, Any],
                 host: Any) -> None:
        self._game = game
        self._sees = set(info['sees'])
        self._absent = set(info['absent'])
        self.module = module
        self.state: Any = None
        self.config = game.bundle['config'].get(module, {})
        self.host = host

    @property
    def tick(self) -> int:
        """The number of completed fixed ticks."""
        return self._game._ticks

    @property
    def dt(self) -> float:
        """Seconds the current run advances."""
        return self._game._dt

    @property
    def alpha(self) -> float:
        """Position between the last two ticks; 0 outside a frame run."""
        return self._game._alpha

    def _is_absent(self, target: str) -> bool:
        # R10, R11: True for an absent optional owner, raises when unseen.
        owner = target.split('.', 1)[0]
        if owner in self._absent:
            return True
        if owner not in self._sees:
            raise BundleError(f'not visible: {target} from {self.module}')
        return False

    def config_of(self, module_id: str) -> Any:
        """Return the config of a visible module or contract."""
        if self._is_absent(module_id):
            raise BundleError(f'absent: {module_id}')
        config = self._game.bundle['config']
        if module_id not in config:
            raise BundleError(f'unknown: {module_id}')
        return config[module_id]

    def records(self, type_id: str) -> dict[str, Any]:
        """Return the records of a type by record id, sorted by id."""
        if self._is_absent(type_id):
            return {}
        if type_id not in self._game.bundle['types']:
            raise BundleError(f'unknown: {type_id}')
        return self._game.bundle['records'].get(type_id, {})

    def events(self, event_id: str) -> list[Any]:
        """Return the payloads of an event delivered to the current run."""
        if self._is_absent(event_id):
            return []
        if event_id not in self._game.bundle['events']:
            raise BundleError(f'unknown: {event_id}')
        return [payload for event, payload in self._game._delivered
                if event == event_id]

    def emit(self, event_id: str, payload: Any) -> None:
        """Queue an event for the next runs."""
        if self._is_absent(event_id):
            return
        if event_id not in self._game.bundle['events']:
            raise BundleError(f'unknown: {event_id}')
        self._game._emit(event_id, payload)

    def call(self, op_id: str, params: Any = None) -> Any:
        """Run an operation in its provider and return the result."""
        if self._is_absent(op_id):
            raise BundleError(f'absent: {op_id}')
        return self._game._call(op_id, params)

    def has(self, target: str) -> bool:
        """Return True for a visible owner, False for an absent one."""
        return not self._is_absent(target)


class Game:
    """A loaded bundle: run it with tick and frame, read it with snapshot."""

    def __init__(self, bundle: dict[str, Any], entries: dict[str, Any],
                 host: Any, debug: bool,
                 validate: Callable[[str, Any], str | None] | None) -> None:
        self.bundle = bundle
        self._entries = entries
        self._debug = debug
        self._validate = validate if debug else None
        self._ticks = 0
        self._fixed_dt = 1 / bundle['fixedHz']
        self._dt = self._fixed_dt
        self._alpha = 0.0
        self._loop: str | None = None
        self._fixed_inbox: list[tuple[str, Any]] = []
        self._frame_inbox: list[tuple[str, Any]] = []
        self._delivered: list[tuple[str, Any]] = []
        self._emitted: _Events | None = None
        self._initialized: set[str] = set()
        self._ctxs = {m['id']: Ctx(self, m['id'], m, host)
                      for m in bundle['modules']}
        for module_id, ctx in self._ctxs.items():
            init = getattr(entries[module_id], 'init', None)
            if callable(init):
                ctx.state = init(ctx)
            self._initialized.add(module_id)
            if debug:
                self._check_state(module_id)

    @property
    def ticks(self) -> int:
        """The number of completed fixed ticks."""
        return self._ticks

    def tick(self, inputs: _Events | None = None) -> _Events:
        """Run the fixed loop once; return the events it emitted."""
        given = []
        for item in inputs or []:
            event_id = item['event']
            if event_id not in self.bundle['events']:
                raise BundleError(f'unknown: {event_id}')
            payload = item.get('payload')
            if self._debug:
                payload = _clean(payload, 'event', event_id)
                self._check('event', event_id, payload)
            given.append((event_id, payload))
        delivered, self._fixed_inbox = self._fixed_inbox + given, []
        emitted = self._run('fixed', delivered, self._fixed_dt, 0.0)
        self._ticks += 1
        return emitted

    def frame(self, dt: float, alpha: float) -> _Events:
        """Run the frame loop once; return the events it emitted."""
        delivered, self._frame_inbox = self._frame_inbox, []
        return self._run('frame', delivered, dt, alpha)

    def call(self, op_id: str, params: Any = None) -> Any:
        """Run an operation from the host, without visibility checks."""
        return self._call(op_id, params)

    def snapshot(self) -> dict[str, Any]:
        """Return a JSON copy of the state of every module that has one."""
        return {module_id: _clean(ctx.state, 'state', module_id)
                for module_id, ctx in self._ctxs.items()
                if ctx.state is not None}

    def _run(self, loop: str, delivered: list[tuple[str, Any]], dt: float,
             alpha: float) -> _Events:
        self._loop, self._delivered, self._emitted = loop, delivered, []
        self._dt, self._alpha = dt, alpha
        try:
            for system in self.bundle['schedule'][loop]:
                owner, name = system.split('.', 1)
                getattr(self._entries[owner], name)(self._ctxs[owner])
                if self._debug:
                    self._check_state(owner)
            return self._emitted
        finally:
            self._loop, self._delivered, self._emitted = None, [], None
            self._dt, self._alpha = self._fixed_dt, 0.0

    def _emit(self, event_id: str, payload: Any) -> None:
        if self._debug:
            payload = _clean(payload, 'event', event_id)
            self._check('event', event_id, payload)
        self._fixed_inbox.append((event_id, payload))
        if self.bundle['schedule']['frame']:
            self._frame_inbox.append((event_id, payload))
        if self._emitted is not None:
            self._emitted.append({'event': event_id, 'payload': payload})

    def _call(self, op_id: str, params: Any) -> Any:
        provider = self.bundle['operations'].get(op_id)
        if provider is None:
            raise BundleError(f'unknown: {op_id}')
        if provider not in self._initialized:
            raise BundleError(f'not initialized: {op_id}')
        ctx = self._ctxs[provider]
        operation = self._entries[provider].operations[op_id.split('.', 1)[1]]
        watch = self._debug and self._loop == 'frame'
        if self._debug:
            self._check('params', op_id, _clean(params, 'params', op_id))
        before = json.dumps(ctx.state, sort_keys=False) if watch else None
        result = operation(ctx, params)
        if self._debug:
            self._check_state(provider)
            if watch and json.dumps(ctx.state, sort_keys=False) != before:
                raise BundleError(f'frame call changed state: {op_id}')
            result = _clean(result, 'result', op_id)
            self._check('result', op_id, result)
        return result

    def _check_state(self, module_id: str) -> None:
        # R18 (a), (d): the state is JSON-clean and valid, when there is one.
        state = self._ctxs[module_id].state
        if state is not None:
            self._check('state', module_id,
                        _clean(state, 'state', module_id))

    def _check(self, kind: str, target: str, value: Any) -> None:
        # R18 (d): validate against the schema the bundle names, if any.
        if self._validate is None:
            return
        schemas = self.bundle.get('schemas') or {}
        schema = schemas.get(_SCHEMA_GROUP[kind], {}).get(target)
        if schema is None:
            return
        message = self._validate(schema, value)
        if message is not None:
            raise BundleError(f'invalid {kind} for {target}: {message}')


def load(bundle: dict[str, Any], root: str = '', host: Any = None,
         debug: bool = False,
         importer: Callable[[str], Any] | None = None,
         validate: Callable[[str, Any], str | None] | None = None) -> Game:
    """Load a bundle: import its modules, check them, run every init."""
    if bundle.get('format') not in FORMATS:
        formats = ', '.join(str(f) for f in FORMATS)
        raise BundleError(
            f"bundle format {bundle.get('format')}; this host reads {formats}")
    entries = {}
    for m in bundle['modules']:
        entries[m['id']] = (importer(m['entry']) if importer is not None
                            else _import_file(root, m['id'], m['entry']))
    for system in bundle['schedule']['fixed'] + bundle['schedule']['frame']:
        owner, name = system.split('.', 1)
        if not callable(getattr(entries.get(owner), name, None)):
            raise BundleError(f'missing system: {system}')
    for op_id, provider in bundle['operations'].items():
        if provider in entries:
            operations = getattr(entries[provider], 'operations', None)
            name = op_id.split('.', 1)[1]
            if not (isinstance(operations, dict)
                    and callable(operations.get(name))):
                raise BundleError(f'missing operation: {op_id}')
    return Game(bundle, entries, host, debug, validate)
