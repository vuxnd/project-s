"""Trace runner (contract C6): run compiled trace bundles on the runtime."""
import json
import os
import re
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from runtime import load  # noqa: E402

HOST = 'python'
MISSING = object()  # what get_pointer returns when a step does not exist


def json_equal(a: Any, b: Any) -> bool:
    """Compare JSON values: a bool equals only a bool, numbers by value."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, list) or isinstance(b, list):
        return (isinstance(a, list) and isinstance(b, list)
                and len(a) == len(b)
                and all(json_equal(x, y) for x, y in zip(a, b)))
    if isinstance(a, dict) or isinstance(b, dict):
        return (isinstance(a, dict) and isinstance(b, dict)
                and a.keys() == b.keys()
                and all(json_equal(a[k], b[k]) for k in a))
    return a == b


def get_pointer(value: Any, pointer: str) -> Any:
    """Follow an RFC 6901 pointer; return MISSING when a step is absent."""
    if pointer == '':
        return value
    if not pointer.startswith('/'):
        return MISSING
    for raw in pointer[1:].split('/'):
        token = raw.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            if (not re.fullmatch(r'0|[1-9][0-9]*', token)
                    or int(token) >= len(value)):
                return MISSING
            value = value[int(token)]
        elif isinstance(value, dict) and token in value:
            value = value[token]
        else:
            return MISSING
    return value


def _show(value: Any) -> str:
    if value is MISSING:
        return 'undefined'
    return json.dumps(value, separators=(',', ':'))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _meets(e: dict[str, Any], value: Any) -> bool:
    # A call expectation passes on equals, or on near within.
    if 'equals' in e and json_equal(value, e['equals']):
        return True
    return ('near' in e and _is_number(value)
            and abs(value - e['near']) <= e['within'])


def _check_call(game: Any, i: int, e: dict[str, Any],
                lines: list[str]) -> None:
    pointer = e.get('pointer', '')
    value = get_pointer(game.call(e['call'], e.get('params')), pointer)
    if _meets(e, value):
        return
    if 'near' in e:
        want = f"{json.dumps(e['near'])} within {json.dumps(e['within'])}"
    else:
        want = _show(e.get('equals'))
    lines.append(f"  expect[{i}]: {e['call']} {pointer}: "
                 f"expected {want}, got {_show(value)}")


def _execute(tb: dict[str, Any], root: str, lines: list[str]) -> None:
    # Appends one line per failed expectation to lines.
    game = load(tb['bundle'], root, host={}, debug=True)
    counts: dict[str, int] = {}
    for t in range(tb['ticks'] + 1):
        for i, e in enumerate(tb['expect']):
            if e.get('at') == t:
                _check_call(game, i, e, lines)
        for i, e in enumerate(tb['expect']):
            if e.get('by') == t:
                got = counts.get(e['emitted'], 0)
                if got != e['count']:
                    lines.append(f"  expect[{i}]: {e['emitted']} : "
                                 f"expected {e['count']}, got {got}")
        if t == tb['ticks']:
            break
        for event in game.tick([x for x in tb['inputs'] if x['at'] == t]):
            counts[event['event']] = counts.get(event['event'], 0) + 1


def run_trace_bundle(path: str, tb: dict[str, Any],
                     root: str) -> tuple[bool, list[str]]:
    """Run one trace bundle; return if it passed and its output lines."""
    try:
        head = f"{tb['trace']} ({tb['implementation']})"
    except (KeyError, TypeError):
        return False, [f'FAIL {path}', '  error: not a trace bundle']
    lines: list[str] = []
    try:
        host = tb['bundle']['host']
        if host != HOST:
            lines.append(f'  wrong host {host}')
        else:
            _execute(tb, root, lines)
    except Exception as e:  # module code may raise anything (R21)
        lines.append(f'  error: {e}')
    ok = not lines
    return ok, [f"{'PASS' if ok else 'FAIL'} {head}", *lines]


def _trace_files(directory: str) -> list[str]:
    found = []
    for folder, _, names in os.walk(directory):
        found += [os.path.join(folder, n).replace(os.sep, '/')
                  for n in names if n.endswith('.json')]
    return sorted(found)


def main(argv: list[str]) -> int:
    """Run every trace bundle below the directories in argv; exit code."""
    if not argv:
        print('usage: python hosts/python/conformance.py <dir>...',
              file=sys.stderr)
        return 2
    for directory in argv:
        if not os.path.isdir(directory):
            print(f'conformance: no such directory: {directory}',
                  file=sys.stderr)
            return 2
    files = [path for directory in argv for path in _trace_files(directory)]
    if not files:
        print('conformance: no trace bundles found', file=sys.stderr)
        return 1
    root = os.getcwd()
    passed = failed = 0
    for path in files:
        try:
            with open(path, encoding='utf-8-sig') as f:
                ok, lines = run_trace_bundle(path, json.load(f), root)
        except (OSError, ValueError) as e:
            ok, lines = False, [f'FAIL {path}', f'  error: {e}']
        print('\n'.join(lines))
        if ok:
            passed += 1
        else:
            failed += 1
    print(f'{HOST}: {passed} passed, {failed} failed')
    return 1 if failed else 0


if __name__ == '__main__':
    # Lines carry text from traces and module code, which a Windows code page
    # cannot always print; -I ignores PYTHONIOENCODING.
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    sys.exit(main(sys.argv[1:]))
