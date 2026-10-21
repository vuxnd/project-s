"""sandbox_rules on Python hosts: spawns every sandbox_rules.spawn at tick 0."""
from typing import Any


def start(ctx: Any) -> None:
    """Emit physics.spawn for each spawn record on the first tick."""
    if ctx.tick != 0:
        return
    for record_id, record in ctx.records('sandbox_rules.spawn').items():
        ctx.emit('physics.spawn', {
            'id': record_id.split('/', 1)[1],
            'body': record['body'],
            'position': list(record['position']),
        })
