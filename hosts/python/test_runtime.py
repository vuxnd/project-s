"""Tests for hosts/python/runtime.py: one test per runtime rule (R1-R22)."""
import datetime
import math
import os
import tempfile
import types
import unittest

from runtime import FORMATS, BundleError, load

NAN = float('nan')
INF = float('inf')


class Point:
    """A plain class instance, which is not a JSON value."""


def mod(module_id, sees=(), absent=(), **entry):
    """An inline module: its bundle entry and the namespace it imports as."""
    info = {
        'id': module_id,
        'entry': module_id + '.py',
        'sees': sorted({module_id, *sees}),
        'absent': sorted(absent),
        'packages': [],
    }
    return info, types.SimpleNamespace(**entry)


def bundle_of(*modules, **fields):
    """A format 1 bundle of the given modules; fields replace defaults."""
    bundle = {
        'format': 1,
        'game': 'g',
        'host': 'python',
        'fixedHz': 50,
        'modules': [info for info, _ in modules],
        'contracts': {},
        'operations': {},
        'events': {},
        'types': {},
        'config': {info['id']: {} for info, _ in modules},
        'records': {},
        'assets': [],
        'schedule': {'fixed': [], 'frame': []},
    }
    bundle.update(fields)
    return bundle


def load_inline(*modules, fixed=(), frame=(), debug=False, validate=None,
                **fields):
    """Load an inline bundle whose importer answers by entry path."""
    entries = {info['entry']: entry for info, entry in modules}
    fields.setdefault('schedule', {'fixed': list(fixed),
                                   'frame': list(frame)})
    return load(bundle_of(*modules, **fields), importer=entries.__getitem__,
                host={}, debug=debug, validate=validate)


def sign(number):
    return math.copysign(1, number)


class RuntimeRules(unittest.TestCase):
    def error(self, action, *args):
        """Run action(*args), which must raise BundleError; its message."""
        with self.assertRaises(BundleError) as caught:
            action(*args)
        return str(caught.exception)

    def test_r1_a_format_other_than_1_is_rejected(self):
        self.assertEqual(FORMATS, (1,))
        for number in (0, 2):
            self.assertEqual(self.error(lambda: load_inline(format=number)),
                             f'bundle format {number}; this host reads 1')

    def test_r2_every_entry_is_imported_in_order(self):
        order = []
        modules = [mod('a'), mod('b')]
        entries = {info['entry']: entry for info, entry in modules}

        def importer(entry):
            order.append(entry)
            return entries[entry]

        load(bundle_of(*modules), importer=importer)
        self.assertEqual(order, ['a.py', 'b.py'])

    def test_r2_a_system_without_a_function_is_rejected(self):
        a = mod('a', run=lambda ctx: None, not_a_function=5)
        for loop in ('fixed', 'frame'):
            self.assertEqual(
                self.error(lambda: load_inline(a, **{loop: ['a.gone']})),
                'missing system: a.gone')
        self.assertEqual(
            self.error(lambda: load_inline(a, fixed=['a.not_a_function'])),
            'missing system: a.not_a_function')
        self.assertEqual(self.error(lambda: load_inline(a, fixed=['b.run'])),
                         'missing system: b.run')

    def test_r2_an_operation_without_a_function_is_rejected(self):
        ops = {'a.op': 'a'}
        for entry in ({}, {'operations': {}}, {'operations': {'op': 1}}):
            self.assertEqual(
                self.error(lambda: load_inline(mod('a', **entry),
                                               operations=ops)),
                'missing operation: a.op')
        load_inline(mod('a', operations={'op': lambda ctx, p: None}),
                    operations=ops)

    def test_r2_the_default_importer_loads_a_fresh_module_per_load(self):
        source = ('CALLS = []\n\n\ndef init(ctx):\n'
                  '    CALLS.append(1)\n    return {"calls": len(CALLS)}\n')
        info = {'id': 'm', 'entry': 'mods/python/m.py', 'sees': ['m'],
                'absent': [], 'packages': []}
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, 'mods', 'python'))
            path = os.path.join(tmp, 'mods', 'python', 'm.py')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(source)
            first = load(bundle_of((info, None)), tmp)
            second = load(bundle_of((info, None)), tmp)
        self.assertEqual(first.snapshot(), {'m': {'calls': 1}})
        self.assertEqual(second.snapshot(), {'m': {'calls': 1}})

    def test_r2_a_missing_entry_file_cannot_be_imported(self):
        info = {'id': 'm', 'entry': 'mods/python/m.py', 'sees': ['m'],
                'absent': [], 'packages': []}
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.error(load, bundle_of((info, None)), tmp),
                             'cannot import: mods/python/m.py')

    def test_r3_init_runs_in_module_order_and_its_result_is_the_state(self):
        order = []

        def init_of(name):
            def init(ctx):
                order.append(name)
                return {'name': name}
            return init

        game = load_inline(mod('a', init=init_of('a')),
                           mod('b', init=init_of('b')), mod('c'))
        self.assertEqual(order, ['a', 'b'])
        self.assertEqual(game.snapshot(),
                         {'a': {'name': 'a'}, 'b': {'name': 'b'}})

    def test_r3_the_result_of_init_always_replaces_ctx_state(self):
        def init(ctx):
            ctx.state = {'assigned': True}  # and returns nothing

        self.assertEqual(load_inline(mod('a', init=init)).snapshot(), {})

    def test_r3_init_sees_tick_0_and_no_events(self):
        seen = {}

        def init(ctx):
            seen.update(tick=ctx.tick, dt=ctx.dt, alpha=ctx.alpha,
                        events=ctx.events('a.e'), host=ctx.host)

        load_inline(mod('a', init=init), events={'a.e': 'a'})
        self.assertEqual(seen, {'tick': 0, 'dt': 1 / 50, 'alpha': 0,
                                'events': [], 'host': {}})

    def test_r3_events_emitted_by_init_reach_the_first_runs(self):
        seen = []
        a = mod('a', init=lambda ctx: ctx.emit('a.e', 1),
                run=lambda ctx: seen.append(('fixed', ctx.events('a.e'))),
                draw=lambda ctx: seen.append(('frame', ctx.events('a.e'))))
        game = load_inline(a, events={'a.e': 'a'}, fixed=['a.run'],
                           frame=['a.draw'])
        game.tick()
        game.frame(0.1, 0)
        self.assertEqual(seen, [('fixed', [1]), ('frame', [1])])

    def test_r3_a_call_during_init_needs_an_initialized_provider(self):
        log = []

        def init_a(ctx):
            log.append(self.error(ctx.call, 'b.op'))
            return {'x': 1}

        a = mod('a', sees=['b'], init=init_a,
                operations={'op': lambda ctx, p: ctx.state['x']})
        b = mod('b', sees=['a'], init=lambda ctx: log.append(ctx.call('a.op')),
                operations={'op': lambda ctx, p: 'b'})
        load_inline(a, b, operations={'a.op': 'a', 'b.op': 'b'})
        self.assertEqual(log, ['not initialized: b.op', 1])

    def test_r3_a_provider_that_is_not_a_loaded_module_is_not_initialized(
            self):
        game = load_inline(mod('a'), operations={'z.op': 'z'})
        self.assertEqual(self.error(game.call, 'z.op'),
                         'not initialized: z.op')

    def test_r4_tick_runs_each_fixed_system_once_in_order(self):
        seen = []

        def system(name):
            return lambda ctx: seen.append((name, ctx.tick, ctx.dt, ctx.alpha))

        a = mod('a', one=system('a.one'), two=system('a.two'))
        b = mod('b', one=system('b.one'))
        game = load_inline(a, b, fixed=['a.one', 'b.one', 'a.two'])
        game.tick()
        game.tick()
        order = ['a.one', 'b.one', 'a.two']
        self.assertEqual(seen, [(name, tick, 1 / 50, 0)
                                for tick in (0, 1) for name in order])
        self.assertEqual(game.ticks, 2)

    def test_r5_an_event_is_seen_in_the_next_tick_by_every_system_once(self):
        seen = []

        def reader(name):
            return lambda ctx: seen.append((name, ctx.tick,
                                            ctx.events('a.e')))

        a = mod('a', put=lambda ctx: ctx.emit('a.e', ctx.tick),
                read=reader('a'))
        b = mod('b', sees=['a'], read=reader('b'))
        game = load_inline(a, b, events={'a.e': 'a'},
                           fixed=['a.read', 'a.put', 'b.read'])
        for _ in range(3):
            game.tick()
        self.assertEqual(seen, [('a', 0, []), ('b', 0, []),
                                ('a', 1, [0]), ('b', 1, [0]),
                                ('a', 2, [1]), ('b', 2, [1])])

    def test_r5_there_is_no_frame_backlog_without_frame_systems(self):
        a = mod('a', put=lambda ctx: ctx.emit('a.e', 1))
        game = load_inline(a, events={'a.e': 'a'}, fixed=['a.put'])
        for _ in range(100):
            game.tick()
        # White box: nothing queues for a frame run that has no systems.
        self.assertEqual(game._frame_inbox, [])
        self.assertEqual(game.frame(0.1, 0), [])

    def test_r5_a_frame_system_sees_every_event_since_its_last_run(self):
        seen = []
        a = mod('a', put=lambda ctx: ctx.emit('a.e', ctx.tick),
                draw=lambda ctx: seen.append(ctx.events('a.e')))
        game = load_inline(a, events={'a.e': 'a'}, fixed=['a.put'],
                           frame=['a.draw'])
        for _ in range(3):
            game.tick()
        game.frame(0.1, 0.5)
        game.tick()
        game.frame(0.1, 0.5)
        game.frame(0.1, 0.5)
        self.assertEqual(seen, [[0, 1, 2], [3], []])

    def test_r5_frame_emits_reach_the_next_frame_and_fixed_runs(self):
        seen = []

        def draw(ctx):
            seen.append(('frame', ctx.events('a.f')))
            ctx.emit('a.f', len(seen))

        a = mod('a', draw=draw,
                run=lambda ctx: seen.append(('fixed', ctx.events('a.f'))))
        game = load_inline(a, events={'a.f': 'a'}, fixed=['a.run'],
                           frame=['a.draw'])
        game.frame(0.1, 0)
        game.frame(0.1, 0)
        game.tick()
        self.assertEqual(seen, [('frame', []), ('frame', [1]),
                                ('fixed', [1, 2])])

    def test_r5_a_run_that_throws_loses_its_inbox_and_is_not_counted(self):
        seen, fail = [], []

        def boom(ctx):
            if fail:
                raise ValueError('boom')

        a = mod('a', boom=boom, put=lambda ctx: ctx.emit('a.e', ctx.tick),
                read=lambda ctx: seen.append(ctx.events('a.e')))
        game = load_inline(a, events={'a.e': 'a'},
                           fixed=['a.boom', 'a.read', 'a.put'])
        game.tick()  # puts 0 into the inbox of the next run
        fail.append(1)
        with self.assertRaises(ValueError):
            game.tick()  # takes that inbox and loses it
        self.assertEqual(game.ticks, 1)
        fail.clear()
        game.tick()
        game.tick()
        self.assertEqual(seen, [[], [], [1]])
        self.assertEqual(game.ticks, 3)

    def test_r5_events_are_empty_outside_a_run(self):
        kept = []
        a = mod('a', init=kept.append, put=lambda ctx: ctx.emit('a.e', 1))
        game = load_inline(a, events={'a.e': 'a'}, fixed=['a.put'])
        game.tick()
        self.assertEqual(kept[0].events('a.e'), [])

    def test_r6_runs_return_their_events_but_not_inputs(self):
        seen = []

        def run(ctx):
            seen.append(ctx.events('a.e'))
            ctx.emit('a.e', {'tick': ctx.tick})

        a = mod('a', init=lambda ctx: ctx.emit('a.e', 'init'), run=run,
                draw=lambda ctx: ctx.emit('a.f', 1),
                operations={'op': lambda ctx, p: ctx.emit('a.e', 'op')})
        game = load_inline(a, events={'a.e': 'a', 'a.f': 'a'},
                           operations={'a.op': 'a'}, fixed=['a.run'],
                           frame=['a.draw'])
        game.call('a.op')
        self.assertEqual(
            game.tick([{'event': 'a.e', 'payload': 'input'}]),
            [{'event': 'a.e', 'payload': {'tick': 0}}])
        self.assertEqual(game.frame(0.1, 0),
                         [{'event': 'a.f', 'payload': 1}])
        self.assertEqual(game.tick(),
                         [{'event': 'a.e', 'payload': {'tick': 1}}])
        # init and game.call events were delivered, though no run returned
        # them.
        self.assertEqual(seen[0], ['init', 'op', 'input'])

    def test_r6_events_emitted_by_called_operations_are_returned(self):
        a = mod('a', operations={'op': lambda ctx, p: ctx.emit('a.e', p)})
        b = mod('b', sees=['a'], run=lambda ctx: ctx.call('a.op', 1),
                draw=lambda ctx: ctx.call('a.op', 2))
        game = load_inline(a, b, events={'a.e': 'a'},
                           operations={'a.op': 'a'}, fixed=['b.run'],
                           frame=['b.draw'])
        self.assertEqual(game.tick(), [{'event': 'a.e', 'payload': 1}])
        self.assertEqual(game.frame(0.1, 0),
                         [{'event': 'a.e', 'payload': 2}])

    def test_r7_an_unknown_input_event_is_rejected(self):
        a = mod('a', run=lambda ctx: None)
        game = load_inline(a, events={'a.e': 'a'}, fixed=['a.run'])
        self.assertEqual(
            self.error(game.tick, [{'event': 'a.gone', 'payload': 1}]),
            'unknown: a.gone')
        self.assertEqual(game.ticks, 0)

    def test_r7_inputs_reach_only_their_run_and_are_not_visibility_checked(
            self):
        seen = []
        a = mod('a', run=lambda ctx: seen.append(ctx.events('a.e')))
        game = load_inline(a, events={'a.e': 'a', 'z.e': 'z'},
                           fixed=['a.run'])
        game.tick([{'event': 'a.e', 'payload': 1},
                   {'event': 'z.e', 'payload': 2}])
        game.tick()
        self.assertEqual(seen, [[1], []])

    def test_r8_frame_runs_frame_systems_with_dt_alpha_and_ticks(self):
        seen, kept = [], []
        a = mod('a', init=kept.append,
                run=lambda ctx: seen.append(('fixed', ctx.dt, ctx.alpha)),
                draw=lambda ctx: seen.append((ctx.tick, ctx.dt, ctx.alpha)))
        game = load_inline(a, fixed=['a.run'], frame=['a.draw'])
        game.tick()
        game.frame(0.25, 0.5)
        self.assertEqual((kept[0].dt, kept[0].alpha), (1 / 50, 0))
        game.tick()
        self.assertEqual(seen, [('fixed', 1 / 50, 0), (1, 0.25, 0.5),
                                ('fixed', 1 / 50, 0)])

    def test_r9_a_frame_call_may_not_change_state_in_debug_mode(self):
        def bump(ctx, params):
            ctx.state['n'] += 1

        which = []
        a = mod('a', init=lambda ctx: {'n': 0},
                operations={'bump': bump, 'peek': lambda ctx, p: ctx.state})
        b = mod('b', sees=['a'], draw=lambda ctx: ctx.call(which[0]))
        c = mod('c', sees=['a'], run=lambda ctx: ctx.call('a.bump'))
        ops = {'a.bump': 'a', 'a.peek': 'a'}
        which[:] = ['a.peek']
        game = load_inline(a, b, c, operations=ops, fixed=['c.run'],
                           frame=['b.draw'], debug=True)
        game.frame(0.1, 0)
        game.tick()  # a fixed system may change state through a call
        game.call('a.bump')  # and so may the host
        which[:] = ['a.bump']
        self.assertEqual(self.error(game.frame, 0.1, 0),
                         'frame call changed state: a.bump')
        game = load_inline(a, b, c, operations=ops, frame=['b.draw'])
        game.frame(0.1, 0)  # release mode does not compare state

    def test_r9_calls_nested_in_a_frame_call_are_watched_too(self):
        def bump(ctx, params):
            ctx.state['n'] += 1

        a = mod('a', init=lambda ctx: {'n': 0}, operations={'bump': bump})
        d = mod('d', sees=['a'],
                operations={'relay': lambda ctx, p: ctx.call('a.bump')})
        e = mod('e', sees=['d'], draw=lambda ctx: ctx.call('d.relay'))
        game = load_inline(a, d, e, operations={'a.bump': 'a', 'd.relay': 'd'},
                           frame=['e.draw'], debug=True)
        self.assertEqual(self.error(game.frame, 0.1, 0),
                         'frame call changed state: a.bump')

    def test_r9_a_new_key_order_is_a_change(self):
        def reorder(ctx, params):
            ctx.state = {'b': ctx.state['b'], 'a': ctx.state['a']}

        a = mod('a', init=lambda ctx: {'a': 1, 'b': 2},
                operations={'reorder': reorder})
        b = mod('b', sees=['a'], draw=lambda ctx: ctx.call('a.reorder'))
        game = load_inline(a, b, operations={'a.reorder': 'a'},
                           frame=['b.draw'], debug=True)
        self.assertEqual(self.error(game.frame, 0.1, 0),
                         'frame call changed state: a.reorder')

    def test_r10_ids_of_modules_that_are_not_visible_are_rejected(self):
        kept = []
        load_inline(mod('a', init=kept.append), events={'z.e': 'z'},
                    operations={'z.op': 'z'}, types={'z.t': 1},
                    config={'a': {}, 'z': {}})
        ctx = kept[0]
        probes = [
            (lambda: ctx.records('z.t'), 'z.t'),
            (lambda: ctx.events('z.e'), 'z.e'),
            (lambda: ctx.events('y.undeclared'), 'y.undeclared'),
            (lambda: ctx.emit('z.e', 1), 'z.e'),
            (lambda: ctx.call('z.op'), 'z.op'),
            (lambda: ctx.config_of('z'), 'z'),
            (lambda: ctx.has('z'), 'z'),
        ]
        for probe, target in probes:
            self.assertEqual(self.error(probe),
                             f'not visible: {target} from a')

    def test_r11_absent_modules_are_handled_quietly(self):
        kept = []
        a = mod('a', absent=['z'], init=kept.append,
                put=lambda ctx: ctx.emit('z.e', 1))
        game = load_inline(a, fixed=['a.put'])
        ctx = kept[0]
        self.assertFalse(ctx.has('z'))
        self.assertEqual(ctx.events('z.e'), [])
        self.assertEqual(ctx.records('z.t'), {})
        self.assertIsNone(ctx.emit('z.e', 1))
        self.assertEqual(game.tick(), [])
        self.assertEqual(self.error(lambda: ctx.call('z.op')),
                         'absent: z.op')
        self.assertEqual(self.error(lambda: ctx.config_of('z')), 'absent: z')

    def test_r12_undeclared_ids_of_visible_modules_are_rejected(self):
        kept = []
        game = load_inline(mod('a', init=kept.append), config={})
        ctx = kept[0]
        probes = [
            lambda: ctx.events('a.gone'),
            lambda: ctx.emit('a.gone', 1),
            lambda: ctx.call('a.gone'),
            lambda: ctx.records('a.gone'),
            lambda: ctx.config_of('a'),
        ]
        for probe, target in zip(probes, ['a.gone'] * 4 + ['a']):
            self.assertEqual(self.error(probe), f'unknown: {target}')
        self.assertEqual(ctx.config, {})
        self.assertEqual(game.bundle['config'], {})

    def test_r13_has_is_true_for_a_visible_owner(self):
        kept = []
        load_inline(mod('a', sees=['b'], absent=['c'], init=kept.append))
        ctx = kept[0]
        self.assertTrue(ctx.has('a'))
        self.assertTrue(ctx.has('b'))
        self.assertTrue(ctx.has('b.anything'))
        self.assertFalse(ctx.has('c'))

    def test_r14_config_is_the_bundle_config(self):
        kept = []
        config = {'a': {'speed': 3}, 'b': {'mode': 'x'}}
        load_inline(mod('a', sees=['b'], init=kept.append), config=config)
        self.assertIs(kept[0].config, config['a'])
        self.assertIs(kept[0].config_of('b'), config['b'])

    def test_r15_records_returns_the_records_of_the_type(self):
        kept = []
        records = {'a.t': {'a/one': {'x': 1}, 'a/two': {'x': 2}}}
        load_inline(mod('a', init=kept.append), types={'a.t': 1, 'a.u': 1},
                    records=records)
        self.assertIs(kept[0].records('a.t'), records['a.t'])
        self.assertEqual(list(kept[0].records('a.t')), ['a/one', 'a/two'])
        self.assertEqual(kept[0].records('a.u'), {})

    def test_r16_a_call_runs_in_the_provider_with_its_own_ctx(self):
        seen = []
        impl = mod('i', sees=['c'],
                   operations={'op': lambda ctx, p: [ctx.module, p]})
        user = mod('u', sees=['c'],
                   run=lambda ctx: seen.append(ctx.call('c.op', {'k': 1})))
        game = load_inline(impl, user, contracts={'c': 'i'},
                           operations={'c.op': 'i'}, fixed=['u.run'])
        game.tick()
        self.assertEqual(seen, [['i', {'k': 1}]])

    def test_r17_a_ctx_kept_from_init_sees_the_current_state(self):
        kept, seen = [], []

        def init(ctx):
            kept.append(ctx)
            return {'pending': []}

        def draw(ctx):
            seen.append((ctx is kept[0], list(ctx.state['pending'])))
            ctx.state = {'pending': []}  # a system may replace the state

        m = mod('m', init=init, draw=draw,
                operations={'same': lambda ctx, p: ctx is kept[0]})
        game = load_inline(m, operations={'m.same': 'm'}, frame=['m.draw'])
        kept[0].state['pending'].append(1)  # a listener attached by init
        game.frame(0.1, 0)
        kept[0].state['pending'].append(2)  # after draw replaced the state
        game.frame(0.1, 0)
        self.assertEqual(seen, [(True, [1]), (True, [2])])
        self.assertIs(game.call('m.same'), True)
        self.assertEqual(kept[0].state, {'pending': []})

    def test_r18_nan_in_state_is_rejected_after_init_system_operation(self):
        def poison(ctx, params=None):
            ctx.state = {'x': NAN}

        init_nan = mod('m', init=lambda ctx: {'x': NAN})
        self.assertEqual(
            self.error(lambda: load_inline(init_nan, debug=True)),
            'state not JSON: m')
        release = load_inline(init_nan)  # release mode does not check
        self.assertEqual(self.error(release.snapshot), 'state not JSON: m')
        clean = {'init': lambda ctx: {'x': 1}}
        game = load_inline(mod('m', run=poison, **clean),
                           fixed=['m.run'], debug=True)
        self.assertEqual(self.error(game.tick), 'state not JSON: m')
        game = load_inline(mod('m', operations={'op': poison}, **clean),
                           operations={'m.op': 'm'}, debug=True)
        self.assertEqual(self.error(game.call, 'm.op'), 'state not JSON: m')

    def test_r18_event_payloads_that_are_not_json_are_rejected(self):
        cycle = []
        cycle.append(cycle)
        bad = [INF, -INF, NAN, (1, 2), {1, 2}, {1: 'a'}, object(), b'x',
               cycle, datetime.date(2026, 1, 1), Point(), lambda: 0]
        for payload in bad:
            with self.subTest(payload=repr(payload)):
                put = mod('m', put=lambda ctx, p=payload: ctx.emit('m.e', p))
                game = load_inline(put, events={'m.e': 'm'},
                                   fixed=['m.put'], debug=True)
                self.assertEqual(self.error(game.tick), 'event not JSON: m.e')
                game = load_inline(mod('m'), events={'m.e': 'm'}, debug=True)
                self.assertEqual(
                    self.error(game.tick, [{'event': 'm.e',
                                            'payload': payload}]),
                    'event not JSON: m.e')
                load_inline(put, events={'m.e': 'm'},
                            fixed=['m.put']).tick()  # release: no check

    def test_r18_minus_zero_is_delivered_as_zero(self):
        seen = []

        def run(ctx):
            seen.extend(ctx.events('m.e'))
            ctx.emit('m.e', {'z': -0.0, 'l': [-0.0, 1.5]})

        game = load_inline(mod('m', run=run), events={'m.e': 'm'},
                           fixed=['m.run'], debug=True)
        emitted = game.tick([{'event': 'm.e', 'payload': -0.0}])
        game.tick()
        self.assertEqual(sign(seen[0]), 1)
        self.assertEqual(seen[1], {'z': 0.0, 'l': [0.0, 1.5]})
        self.assertEqual(sign(seen[1]['z']), 1)
        self.assertEqual(sign(seen[1]['l'][0]), 1)
        self.assertEqual(sign(emitted[0]['payload']['l'][0]), 1)

    def test_r18_none_passes_at_the_top_level(self):
        seen = []

        def run(ctx):
            seen.append(ctx.events('m.e'))
            ctx.emit('m.e', None)

        m = mod('m', run=run, operations={'op': lambda ctx, p: None})
        game = load_inline(m, events={'m.e': 'm'}, operations={'m.op': 'm'},
                           fixed=['m.run'], debug=True)
        self.assertEqual(game.tick([{'event': 'm.e'}]),
                         [{'event': 'm.e', 'payload': None}])
        game.tick()
        self.assertEqual(seen, [[None], [None]])
        self.assertIsNone(game.call('m.op'))
        self.assertEqual(game.snapshot(), {})

    def test_r18_params_are_checked_and_results_are_json_clean_copies(self):
        received = []

        def echo(ctx, params):
            received.append(params)
            return params

        ops = {'echo': echo, 'pair': lambda ctx, params: (1, 2)}
        m = mod('m', operations=ops)
        user = mod('u', sees=['m'], run=lambda ctx: ctx.call('m.pair'))
        game = load_inline(m, user, operations={'m.echo': 'm', 'm.pair': 'm'},
                           fixed=['u.run'], debug=True)
        sent = {'a': [1, 2.5]}
        got = game.call('m.echo', sent)
        self.assertEqual(got, sent)
        self.assertIs(received[0], sent)  # params are handed over as given
        self.assertIsNot(got, sent)  # a result is a copy
        self.assertEqual(self.error(game.call, 'm.pair'),
                         'result not JSON: m.pair')
        self.assertEqual(self.error(game.tick), 'result not JSON: m.pair')
        for params in ((1, 2), NAN):
            self.assertEqual(self.error(game.call, 'm.echo', params),
                             'params not JSON: m.echo')

    def test_r18_validate_rejects_values_that_fail_their_schema(self):
        failing, calls = set(), []
        schemas = {'state': {'m': 'state.json'},
                   'events': {'m.e': 'event.json'},
                   'params': {'m.op': 'params.json'},
                   'results': {'m.op': 'result.json'}}

        def validate(schema, value):
            calls.append((schema, value))
            return f'no {schema}' if schema in failing else None

        def start():
            m = mod('m', init=lambda ctx: {'n': 0},
                    put=lambda ctx: ctx.emit('m.e', 1),
                    operations={'op': lambda ctx, p: 7})
            return load_inline(m, events={'m.e': 'm'},
                               operations={'m.op': 'm'}, fixed=['m.put'],
                               schemas=schemas, debug=True, validate=validate)

        failing.add('state.json')
        self.assertEqual(self.error(start),
                         'invalid state for m: no state.json')
        failing.clear()
        game = start()
        self.assertIn(('state.json', {'n': 0}), calls)
        failing.add('event.json')
        self.assertEqual(self.error(game.tick),
                         'invalid event for m.e: no event.json')
        self.assertEqual(
            self.error(game.tick, [{'event': 'm.e', 'payload': 2}]),
            'invalid event for m.e: no event.json')
        failing.clear()
        failing.add('params.json')
        self.assertEqual(self.error(game.call, 'm.op', {'k': 1}),
                         'invalid params for m.op: no params.json')
        failing.clear()
        failing.add('result.json')
        self.assertEqual(self.error(game.call, 'm.op'),
                         'invalid result for m.op: no result.json')
        self.assertIn(('result.json', 7), calls)

    def test_r18_checks_apply_only_in_debug_mode(self):
        calls = []
        m = mod('m', init=lambda ctx: {'x': NAN},
                put=lambda ctx: ctx.emit('m.e', (1, 2)),
                operations={'op': lambda ctx, p: (p,)})
        game = load_inline(m, events={'m.e': 'm'}, operations={'m.op': 'm'},
                           fixed=['m.put'], schemas={'state': {'m': 's.json'}},
                           validate=lambda schema, value: calls.append(schema))
        game.tick()
        self.assertEqual(game.call('m.op', (1,)), ((1,),))
        self.assertEqual(calls, [])

    def test_r19_game_call_skips_visibility_and_rejects_unknown_ids(self):
        b = mod('b', operations={'op': lambda ctx, p: [ctx.module, p]})
        game = load_inline(mod('a'), b, operations={'b.op': 'b'}, debug=True)
        self.assertEqual(game.call('b.op', 5), ['b', 5])
        self.assertEqual(self.error(game.call, 'b.gone'), 'unknown: b.gone')
        self.assertEqual(self.error(game.call, 'b.op', NAN),
                         'params not JSON: b.op')

    def test_r20_snapshot_is_a_json_copy_of_each_state_in_load_order(self):
        a = mod('a', init=lambda ctx: {'n': 1, 'z': -0.0})
        c = mod('c', init=lambda ctx: [1, {'k': None}])
        d = mod('d', init=lambda ctx: 0)
        e = mod('e', init=lambda ctx: {})
        game = load_inline(a, mod('b'), c, d, e)
        snapshot = game.snapshot()
        self.assertEqual(list(snapshot), ['a', 'c', 'd', 'e'])
        self.assertEqual(snapshot, {'a': {'n': 1, 'z': 0.0},
                                    'c': [1, {'k': None}], 'd': 0, 'e': {}})
        self.assertEqual(sign(snapshot['a']['z']), 1)
        snapshot['a']['n'] = 99
        self.assertEqual(game.snapshot()['a']['n'], 1)

    def test_r21_errors_from_module_code_propagate_unchanged(self):
        boom = ValueError('boom')

        def explode(*args):
            raise boom

        with self.assertRaises(ValueError) as caught:
            load_inline(mod('a', init=explode))
        self.assertIs(caught.exception, boom)
        a = mod('a', run=explode, draw=explode, operations={'op': explode})
        game = load_inline(a, operations={'a.op': 'a'}, fixed=['a.run'],
                           frame=['a.draw'])
        for action in (game.tick, lambda: game.frame(0.1, 0),
                       lambda: game.call('a.op')):
            with self.assertRaises(ValueError) as caught:
                action()
            self.assertIs(caught.exception, boom)
        self.assertEqual(game.ticks, 0)

    def test_r22_unknown_fields_are_ignored(self):
        a = mod('a', init=lambda ctx: {'n': 1})
        a[0]['x_future'] = {'any': 'thing'}
        game = load_inline(a, x_future=1)
        self.assertEqual(game.snapshot(), {'a': {'n': 1}})


if __name__ == '__main__':
    unittest.main()
