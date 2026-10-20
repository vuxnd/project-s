"""Bundle player: run a Python bundle and print its snapshot and events."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from runtime import load  # noqa: E402


def main(argv: list[str]) -> int:
    """Run the bundle argv[0] for argv[1] ticks; print one JSON line."""
    if len(argv) != 2 or not argv[1].isdecimal():
        print('usage: python hosts/python/play.py <bundle.json> <ticks>',
              file=sys.stderr)
        return 2
    try:
        with open(argv[0], encoding='utf-8-sig') as f:
            bundle = json.load(f)
        if bundle['host'] != 'python':
            print(f"play: bundle host {bundle['host']}; "
                  'this runner is python', file=sys.stderr)
            return 2
        game = load(bundle, os.getcwd(), host={}, debug=True)
        counts: dict[str, int] = {}
        for _ in range(int(argv[1])):
            for event in game.tick():
                counts[event['event']] = counts.get(event['event'], 0) + 1
        print(json.dumps({'snapshot': game.snapshot(),
                          'events': dict(sorted(counts.items()))},
                         allow_nan=False))
    except Exception as e:
        print(f'play: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
