"""physics_basic on Python hosts: Euler boxes on the plane y = 0 that stack."""
from typing import Any


def init(ctx: Any) -> dict[str, Any]:
    """Return the initial state: no bodies."""
    return {'bodies': {}}


def integrate(ctx: Any) -> None:
    """Add the bodies spawned this tick, then advance every body that moves."""
    bodies = ctx.state['bodies']
    records = ctx.records('physics.body')
    for spawn in ctx.events('physics.spawn'):
        if spawn['id'] in bodies or spawn['body'] not in records:
            continue
        bodies[spawn['id']] = {
            'position': list(spawn['position']),
            'velocity': [0, 0, 0],
            'size': list(records[spawn['body']]['size']),
            'resting': False,
        }
    gravity = ctx.config_of('physics')['gravity']
    substeps = ctx.config['substeps']
    h = ctx.dt / substeps
    for body_id in sorted(bodies):
        body = bodies[body_id]
        if body['resting']:
            continue
        position, velocity = body['position'], body['velocity']
        for _ in range(substeps):
            for k in range(3):
                velocity[k] += gravity[k] * h
                position[k] += velocity[k] * h


def collide(ctx: Any) -> None:
    """Stop every body that reaches the ground or a resting body."""
    bodies = ctx.state['bodies']
    ids = sorted(bodies)
    for body_id in ids:
        body = bodies[body_id]
        if body['resting']:
            continue
        p, s = body['position'], body['size']
        bottom = p[1] - s[1] / 2
        support = None
        on = 'ground'
        if bottom <= 0:
            support = 0
        else:
            # The first resting body in id order that overlaps this one in
            # x and z, reaches up to its bottom and has a lower centre.
            for other in ids:
                q, t = bodies[other]['position'], bodies[other]['size']
                top = q[1] + t[1] / 2
                if (other != body_id and bodies[other]['resting']
                        and abs(p[0] - q[0]) < (s[0] + t[0]) / 2
                        and abs(p[2] - q[2]) < (s[2] + t[2]) / 2
                        and top >= bottom and q[1] < p[1]):
                    support = top
                    on = other
                    break
        if support is None:
            continue
        p[1] = support + s[1] / 2
        body['velocity'] = [0, 0, 0]
        body['resting'] = True
        ctx.emit('physics.contact', {'id': body_id, 'with': on})


def get_position(ctx: Any, params: dict[str, Any]) -> list[float] | None:
    """Return a copy of the body's centre, or None when it does not exist."""
    body = ctx.state['bodies'].get(params['id'])
    return None if body is None else list(body['position'])


def get_bodies(ctx: Any, params: Any) -> list[dict[str, Any]]:
    """Return id, position and size of every body, sorted by id."""
    bodies = ctx.state['bodies']
    return [{'id': body_id,
             'position': list(bodies[body_id]['position']),
             'size': list(bodies[body_id]['size'])}
            for body_id in sorted(bodies)]


operations = {'position': get_position, 'bodies': get_bodies}
