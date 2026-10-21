"""A counter that probe_impl may or may not have as a peer."""
from typing import Any


def init(ctx: Any) -> dict[str, int]:
    """Start the total at 0."""
    return {'total': 0}


def peer(ctx: Any) -> None:
    """Add 10 to the total and announce the tick."""
    ctx.state['total'] += 10
    ctx.emit('probe_peer.note', {'tick': ctx.tick})


def _add(ctx: Any, params: dict[str, int]) -> int:
    """Add n to the total and return it."""
    ctx.state['total'] += params['n']
    return ctx.state['total']


operations = {'add': _add}
