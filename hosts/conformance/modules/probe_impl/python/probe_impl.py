"""Step interpreter: runs the probe.step records and logs each result."""
import json
from typing import Any


def _act(ctx: Any, step: dict[str, Any]) -> Any:
    do = step['do']
    if do == 'emit':
        ctx.emit(step['id'], step.get('payload'))
        return None
    if do == 'events':
        return ctx.events(step['id'])
    if do == 'call':
        return ctx.call(step['id'], step.get('payload'))
    if do == 'has':
        return ctx.has(step['id'])
    if do == 'config':
        return ctx.config
    if do == 'configOf':
        return ctx.config_of(step['id'])
    if do == 'records':
        return ctx.records(step['id'])
    return {'tick': ctx.tick, 'dt': ctx.dt}  # time


def _run(ctx: Any, where: str) -> None:
    for step in ctx.records('probe.step').values():
        if step['in'] != where or step['tick'] != ctx.tick:
            continue
        entry: dict[str, Any] = {'tick': ctx.tick, 'in': step['in'],
                                 'do': step['do']}
        if 'id' in step:
            entry['id'] = step['id']
        try:
            entry['result'] = json.loads(json.dumps(_act(ctx, step)))
        except Exception as e:  # the log records what the runtime threw
            entry['error'] = str(e)
        ctx.state['log'].append(entry)


def init(ctx: Any) -> dict[str, Any]:
    """Start an empty log and run the steps for init."""
    ctx.state = {'log': []}
    _run(ctx, 'init')
    return ctx.state


def first(ctx: Any) -> None:
    """Run the steps for first."""
    _run(ctx, 'first')


def second(ctx: Any) -> None:
    """Run the steps for second."""
    _run(ctx, 'second')


def _log(ctx: Any, params: Any) -> Any:
    """Return the log."""
    return ctx.state['log']


operations = {'log': _log}
