"""Sidecar message-dispatch tests.

Regression coverage for a real bug (2026-07-28): `transport` messages used
to fall through to a full `project` broadcast like any edit command. Since
`seek` fires on every pointer-move of a cursor drag, that turned scrubbing
the timeline into a broadcast storm — each broadcast handed the frontend a
brand-new `project.cues` array reference, which was enough to trip React's
"Maximum update depth exceeded" guard in the timeline widget. `transport`
and PSN start/stop don't touch project data at all, so they must never
imply a project broadcast.
"""
import asyncio

import pytest

from lumitrack.sidecar import Session, _handle_message


def _run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("action,extra", [
    ("play", {}),
    ("pause", {}),
    ("seek", {"tMs": 500.0}),
])
def test_transport_acks_and_never_broadcasts_project(action, extra):
    session = Session()
    reply = _run(_handle_message(session, {"type": "transport", "action": action, **extra}))
    assert reply == {"type": "ack"}


def test_transport_seek_actually_moves_the_clock():
    session = Session()
    _run(_handle_message(session, {"type": "transport", "action": "seek", "tMs": 1234.0}))
    assert session.transport.now_ms() == pytest.approx(1234.0)


def test_project_mutating_commands_still_signal_a_broadcast():
    """`None` is the caller's cue to broadcast a fresh project snapshot —
    only commands that actually change points/cues/activations should
    return it."""
    session = Session()
    cue_id = session.project.cues[0].id
    reply = _run(_handle_message(session, {
        "type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 10.0,
    }))
    assert reply is None


def test_unknown_transport_action_is_reported_as_error():
    session = Session()
    reply = _run(_handle_message(session, {"type": "transport", "action": "rewind"}))
    assert reply is not None and reply["type"] == "error"
