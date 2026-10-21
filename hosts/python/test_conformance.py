"""Tests for conformance.py and play.py: output, exit codes, sys.path."""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

import conformance
import play

HERE = os.path.dirname(os.path.abspath(__file__))

COUNTER = '''\
def init(ctx):
    return {'n': 0}


def step(ctx):
    if ctx.tick >= 3:
        raise RuntimeError('only 3 ticks may run')
    for bump in ctx.events('counter.bump'):
        ctx.state['n'] += bump['by']
    ctx.state['n'] += 1
    ctx.emit('counter.tock', 0)
    ctx.emit('counter.tick', {'n': ctx.state['n']})


def get(ctx, params):
    return {'n': ctx.state['n'], 'list': [1.5, 2], 'flag': True}


operations = {'get': get}
'''

ODD = '''\
def init(ctx):
    return {'host': ctx.host}


def step(ctx):
    ctx.emit('odd.pair', (1, 2))


def echo(ctx, params):
    return [params, ctx.host]


operations = {'echo': echo}
'''

# After 3 ticks with a bump of 10 in tick 1: n is 1, 12 and 13.
PASSING = [
    {'at': 0, 'call': 'counter.get', 'pointer': '/n', 'equals': 0},
    {'at': 2, 'call': 'counter.get',
     'equals': {'n': 12, 'list': [1.5, 2], 'flag': True}},
    {'at': 3, 'call': 'counter.get', 'pointer': '/n', 'equals': 13},
    {'at': 3, 'call': 'counter.get', 'pointer': '/list/0', 'near': 1.4,
     'within': 0.2},
    {'at': 3, 'call': 'counter.get', 'pointer': '/list/1', 'near': 2.5,
     'within': 0.5},
    {'by': 3, 'emitted': 'counter.tick', 'count': 3},
    {'by': 3, 'emitted': 'counter.bump', 'count': 0},
]


def trace_bundle(name, expect, host='python'):
    """A hand-written trace bundle for the counter module."""
    return {
        'trace': f'conformance/{name}.json',
        'contract': 'counting',
        'implementation': 'counter',
        'ticks': 3,
        'bundle': {
            'format': 1,
            'game': f'counting.{name}',
            'host': host,
            'fixedHz': 10,
            'modules': [{'id': 'counter', 'entry': 'mod/counter.py',
                         'sees': ['counter'], 'absent': [], 'packages': []}],
            'contracts': {},
            'operations': {'counter.get': 'counter'},
            'events': {'counter.tick': 'counter', 'counter.tock': 'counter',
                       'counter.bump': 'counter'},
            'types': {},
            'config': {'counter': {}},
            'records': {},
            'assets': [],
            'schedule': {'fixed': ['counter.step'], 'frame': []},
        },
        'inputs': [{'at': 1, 'event': 'counter.bump', 'payload': {'by': 10}}],
        'expect': expect,
    }


def odd_bundle():
    """A bundle of the odd module, whose step emits a tuple payload."""
    return {
        'format': 1, 'game': 'odd', 'host': 'python', 'fixedHz': 10,
        'modules': [{'id': 'odd', 'entry': 'mod/odd.py', 'sees': ['odd'],
                     'absent': [], 'packages': []}],
        'contracts': {}, 'operations': {'odd.echo': 'odd'},
        'events': {'odd.pair': 'odd'}, 'types': {}, 'config': {'odd': {}},
        'records': {}, 'assets': [],
        'schedule': {'fixed': ['odd.step'], 'frame': []},
    }


class ConformanceTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = os.path.realpath(tmp.name)
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)  # runs before tmp.cleanup
        os.chdir(self.tmp)
        os.mkdir('mod')
        with open(os.path.join('mod', 'counter.py'), 'w',
                  encoding='utf-8') as f:
            f.write(COUNTER)
        with open(os.path.join('mod', 'odd.py'), 'w', encoding='utf-8') as f:
            f.write(ODD)

    def write(self, folder, **traces):
        os.makedirs(os.path.join(self.tmp, folder), exist_ok=True)
        for name, value in traces.items():
            path = os.path.join(self.tmp, folder, name + '.json')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(value, f)
        return os.path.join(self.tmp, folder)

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = conformance.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_a_passing_bundle_prints_pass_and_the_summary(self):
        folder = self.write('good', ok=trace_bundle('ok', PASSING))
        code, out, err = self.run_main(folder)
        self.assertEqual(out, 'PASS conformance/ok.json (counter)\n'
                              'python: 1 passed, 0 failed\n')
        self.assertEqual((code, err), (0, ''))

    def test_a_failed_equals_prints_expected_and_got(self):
        expect = [{'at': 3, 'call': 'counter.get', 'pointer': '/n',
                   'equals': 14}]
        folder = self.write('bad', eq=trace_bundle('eq', expect))
        code, out, _ = self.run_main(folder)
        self.assertEqual(out, 'FAIL conformance/eq.json (counter)\n'
                              '  expect[0]: counter.get /n: '
                              'expected 14, got 13\n'
                              'python: 0 passed, 1 failed\n')
        self.assertEqual(code, 1)

    def test_a_failed_near_prints_the_band(self):
        expect = [{'at': 3, 'call': 'counter.get', 'pointer': '/list/0',
                   'near': 2, 'within': 0.1}]
        folder = self.write('bad', near=trace_bundle('near', expect))
        code, out, _ = self.run_main(folder)
        self.assertEqual(out, 'FAIL conformance/near.json (counter)\n'
                              '  expect[0]: counter.get /list/0: '
                              'expected 2 within 0.1, got 1.5\n'
                              'python: 0 passed, 1 failed\n')
        self.assertEqual(code, 1)

    def test_near_needs_a_number_at_the_pointer(self):
        expect = [{'at': 3, 'call': 'counter.get', 'pointer': pointer,
                   'near': 1, 'within': 5}
                  for pointer in ('/flag', '/missing', '')]
        folder = self.write('bad', num=trace_bundle('num', expect))
        _, out, _ = self.run_main(folder)
        self.assertEqual(out.splitlines()[1:4], [
            '  expect[0]: counter.get /flag: expected 1 within 5, got true',
            '  expect[1]: counter.get /missing: expected 1 within 5, '
            'got undefined',
            '  expect[2]: counter.get : expected 1 within 5, got '
            '{"n":13,"list":[1.5,2],"flag":true}',
        ])

    def test_a_failed_count_prints_expected_and_got(self):
        expect = [{'by': 3, 'emitted': 'counter.tick', 'count': 2}]
        folder = self.write('bad', count=trace_bundle('count', expect))
        code, out, _ = self.run_main(folder)
        self.assertEqual(out, 'FAIL conformance/count.json (counter)\n'
                              '  expect[0]: counter.tick : '
                              'expected 2, got 3\n'
                              'python: 0 passed, 1 failed\n')
        self.assertEqual(code, 1)

    def test_a_bundle_for_another_host_fails_with_wrong_host(self):
        folder = self.write(
            'bad', host=trace_bundle('host', PASSING, host='node'))
        code, out, _ = self.run_main(folder)
        self.assertEqual(out, 'FAIL conformance/host.json (counter)\n'
                              '  wrong host node\n'
                              'python: 0 passed, 1 failed\n')
        self.assertEqual(code, 1)

    def test_an_exception_fails_the_file_and_stops_it(self):
        expect = [{'at': 1, 'call': 'counter.gone', 'equals': 1},
                  {'at': 3, 'call': 'counter.get', 'pointer': '/n',
                   'equals': 99}]
        folder = self.write('bad', boom=trace_bundle('boom', expect))
        code, out, _ = self.run_main(folder)
        self.assertEqual(out, 'FAIL conformance/boom.json (counter)\n'
                              '  error: unknown: counter.gone\n'
                              'python: 0 passed, 1 failed\n')
        self.assertEqual(code, 1)

    def test_a_missing_pointer_step_is_undefined(self):
        expect = [{'at': 3, 'call': 'counter.get', 'pointer': '/nothing',
                   'equals': 1}]
        folder = self.write('bad', gone=trace_bundle('gone', expect))
        _, out, _ = self.run_main(folder)
        self.assertIn('expected 1, got undefined\n', out)

    def test_files_run_in_sorted_order_across_folders_in_argument_order(self):
        good = trace_bundle('ok', PASSING)
        bad = trace_bundle('bad', [
            {'by': 0, 'emitted': 'counter.tick', 'count': 1},
            {'at': 0, 'call': 'counter.get', 'pointer': '/n', 'equals': 5}])
        first = self.write('first', b=good)
        self.write('first/a', c=bad)
        with open(os.path.join(first, 'notes.txt'), 'w') as f:
            f.write('not a trace bundle')
        second = self.write('second', a=good)
        code, out, _ = self.run_main(first, second)
        self.assertEqual(out.splitlines(), [
            'FAIL conformance/bad.json (counter)',
            '  expect[1]: counter.get /n: expected 5, got 0',
            '  expect[0]: counter.tick : expected 1, got 0',
            'PASS conformance/ok.json (counter)',
            'PASS conformance/ok.json (counter)',
            'python: 2 passed, 1 failed',
        ])
        self.assertEqual(code, 1)

    def test_bundles_load_in_debug_mode_with_host_and_params(self):
        tb = {'trace': 'conformance/odd.json', 'contract': 'odd_api',
              'implementation': 'odd', 'ticks': 1, 'bundle': odd_bundle(),
              'inputs': [],
              'expect': [{'at': 0, 'call': 'odd.echo', 'params': {'k': 1},
                          'equals': [{'k': 1}, {}]}]}
        code, out, _ = self.run_main(self.write('odd', odd=tb))
        self.assertEqual(out, 'FAIL conformance/odd.json (odd)\n'
                              '  error: event not JSON: odd.pair\n'
                              'python: 0 passed, 1 failed\n')
        self.assertEqual(code, 1)

    def test_a_file_that_is_not_a_trace_bundle_fails(self):
        folder = self.write('odd', list=[1, 2], other={'x': 1})
        with open(os.path.join(folder, 'broken.json'), 'w') as f:
            f.write('{')
        code, out, _ = self.run_main(folder)
        lines = out.splitlines()
        self.assertEqual(lines[0], f'FAIL {folder}/broken.json'.replace(
            os.sep, '/'))
        self.assertTrue(lines[1].startswith('  error: '), lines[1])
        self.assertIn('  error: not a trace bundle', lines)
        self.assertEqual(lines[-1], 'python: 0 passed, 3 failed')
        self.assertEqual(code, 1)

    def test_main_exit_codes_for_bad_arguments_and_nothing_to_run(self):
        code, out, err = self.run_main()
        self.assertEqual((code, out), (2, ''))
        self.assertTrue(err.startswith('usage: '), err)
        missing = os.path.join(self.tmp, 'missing')
        code, out, err = self.run_main(self.write('good', ok=trace_bundle(
            'ok', PASSING)), missing)
        self.assertEqual((code, out), (2, ''))
        self.assertEqual(err, f'conformance: no such directory: {missing}\n')
        code, out, err = self.run_main(self.write('empty'))
        self.assertEqual((code, out), (1, ''))
        self.assertEqual(err, 'conformance: no trace bundles found\n')

    def test_json_equal_follows_the_trace_rules(self):
        equal = conformance.json_equal
        self.assertTrue(equal(1, 1.0))
        self.assertTrue(equal({'a': [1, None, 'x'], 'b': 2},
                              {'b': 2.0, 'a': [1.0, None, 'x']}))
        self.assertFalse(equal(True, 1))
        self.assertFalse(equal(0, False))
        self.assertTrue(equal([True], [True]))
        self.assertFalse(equal([1], [1, 2]))
        self.assertFalse(equal({'a': 1}, {'a': 1, 'b': 2}))
        self.assertFalse(equal('1', 1))
        self.assertFalse(equal(None, 0))
        self.assertFalse(equal({}, []))

    def test_get_pointer_follows_rfc_6901(self):
        value = {'a/b': [10, {'~': 'x'}], 'c': None, '~1': 'y'}
        get = conformance.get_pointer
        self.assertIs(get(value, ''), value)
        self.assertEqual(get(value, '/a~1b/0'), 10)
        self.assertEqual(get(value, '/a~1b/1/~0'), 'x')
        self.assertEqual(get(value, '/~01'), 'y')
        self.assertIsNone(get(value, '/c'))
        for missing in ('/d', '/a~1b/2', '/a~1b/01', '/a~1b/-', '/c/x', 'a'):
            self.assertIs(get(value, missing), conformance.MISSING, missing)

    def run_script(self, *args):
        return subprocess.run([sys.executable, '-I', '-B', *args],
                              cwd=self.tmp, capture_output=True, text=True)

    def test_conformance_py_runs_isolated_from_another_directory(self):
        folder = self.write('good', ok=trace_bundle('ok', PASSING))
        r = self.run_script(os.path.join(HERE, 'conformance.py'), folder)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('python: 1 passed, 0 failed', r.stdout)

    def test_conformance_py_prints_any_character_through_a_pipe(self):
        expect = [{'at': 0, 'call': 'counter.get', 'pointer': '/→',
                   'equals': 1}]
        folder = self.write('arrow', ok=trace_bundle('ok', expect))
        r = subprocess.run([sys.executable, '-I', '-B',
                            os.path.join(HERE, 'conformance.py'), folder],
                           cwd=self.tmp, capture_output=True,
                           encoding='utf-8')
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn('  expect[0]: counter.get /→: expected 1, got undefined',
                      r.stdout)
        self.assertIn('python: 0 passed, 1 failed', r.stdout)

    def test_play_py_prints_the_snapshot_and_event_counts(self):
        bundle = trace_bundle('ok', PASSING)['bundle']
        path = os.path.join(self.write('bundles', ok=bundle), 'ok.json')
        r = self.run_script(os.path.join(HERE, 'play.py'), path, '3')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, '{"snapshot": {"counter": {"n": 3}}, '
                                   '"events": {"counter.tick": 3, '
                                   '"counter.tock": 3}}\n')

    def test_play_py_exit_codes_and_messages(self):
        def play_main(*argv):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = play.main(list(argv))
            return code, err.getvalue()

        folder = self.write(
            'bundles', node=trace_bundle('n', PASSING, host='node')['bundle'],
            python=trace_bundle('p', PASSING)['bundle'])
        node, python = (os.path.join(folder, n + '.json')
                        for n in ('node', 'python'))
        self.assertEqual(play_main(node, '1'),
                         (2, 'play: bundle host node; '
                             'this runner is python\n'))
        self.assertEqual(play_main(python, '1x')[0], 2)
        self.assertEqual(play_main(python)[0], 2)
        code, err = play_main(os.path.join(folder, 'none.json'), '1')
        self.assertEqual(code, 1)
        self.assertTrue(err.startswith('play: '), err)

    def test_play_py_runs_in_debug_mode_with_host(self):
        path = os.path.join(self.write('bundles', odd=odd_bundle()),
                            'odd.json')
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(play.main([path, '0']), 0)
            self.assertEqual(play.main([path, '1']), 1)
        self.assertEqual(out.getvalue(), '{"snapshot": {"odd": {"host": {}}}, '
                                         '"events": {}}\n')
        self.assertEqual(err.getvalue(), 'play: event not JSON: odd.pair\n')


if __name__ == '__main__':
    unittest.main()
