"""Block-edit context resolution (§12.6 / DIRECTIVES.md mission 1).

The whole point of `resolve_block_context` is that a trajectory's start is
the last cue that *actually* touched the point (per axis, same LTP order as
playback) — never simply the neighbouring block on the timeline. These
tests pin that down for the cases called out in the mission: a point
skipped by an in-between block, overlapping cues, LTP ordering, plus the
wire-format guarantees the frontend relies on (spatial path separate from
timing, no easing baked into the polyline, snap-on-first-appearance).
"""
import asyncio

import pytest

from lumitrack.core.project import Project, Point, Cue, Activation
from lumitrack.core.timeline import resolve_block_context
from lumitrack.sidecar import Session, _handle_message


def _project_with(*cues, points=None):
    project = Project(name="t")
    project.points = points or [Point(id="p1", name="P1")]
    project.cues = list(cues)
    project.sort_cues()
    return project


def _cue(cid, start_ms, activations, fade_ms=1000.0, **kwargs):
    cue = Cue(id=cid, name=cid, start_ms=start_ms, duration_ms=fade_ms)
    for pid, targets in activations.items():
        cue.activations[pid] = Activation(fade_ms=fade_ms, **targets, **kwargs)
    return cue


def test_start_comes_from_last_cue_that_touched_the_point_not_the_neighbour():
    """Cue B sits between A and C on the timeline but never touches p1:
    C's trajectory for p1 must start at A's target, and say so."""
    project = _project_with(
        _cue("A", 0, {"p1": {"target_x_cm": 100.0, "target_y_cm": 200.0}}),
        _cue("B", 5000, {"p2": {"target_x_cm": 999.0, "target_y_cm": 999.0}}),
        _cue("C", 10000, {"p1": {"target_x_cm": 700.0, "target_y_cm": 800.0}}),
        points=[Point(id="p1", name="P1"), Point(id="p2", name="P2")],
    )
    entry = resolve_block_context(project, "C")["entries"]["p1"]
    assert entry["startPose"][:2] == [100.0, 200.0]
    assert entry["targetPose"][:2] == [700.0, 800.0]
    assert entry["sources"]["x"] == "A"
    assert entry["sources"]["y"] == "A"


def test_ltp_start_is_the_latest_started_earlier_cue():
    project = _project_with(
        _cue("A", 0, {"p1": {"target_x_cm": 100.0, "target_y_cm": 100.0}}),
        _cue("B", 1000, {"p1": {"target_x_cm": 300.0, "target_y_cm": 300.0}}),
        _cue("C", 5000, {"p1": {"target_x_cm": 900.0, "target_y_cm": 900.0}}),
    )
    entry = resolve_block_context(project, "C")["entries"]["p1"]
    assert entry["startPose"][:2] == [300.0, 300.0]
    assert entry["sources"]["x"] == "B"


def test_overlapping_cue_tracks_from_the_overlapped_ones_target():
    """B starts while A is still fading. Playback (`_resolve_axis`) makes B
    travel from A's *target*, so the displayed trajectory must too — the
    context has to match what the engine will actually do, not what is on
    screen mid-fade."""
    project = _project_with(
        _cue("A", 0, {"p1": {"target_x_cm": 400.0, "target_y_cm": 0.0}}, fade_ms=4000),
        _cue("B", 2000, {"p1": {"target_x_cm": 1000.0, "target_y_cm": 500.0}}),
    )
    entry = resolve_block_context(project, "B")["entries"]["p1"]
    assert entry["startPose"][:2] == [400.0, 0.0]
    assert entry["sources"]["x"] == "A"


def test_first_appearance_snaps_start_to_target_with_no_path():
    project = _project_with(
        _cue("A", 0, {"p1": {"target_x_cm": 100.0, "target_y_cm": 200.0}}),
    )
    entry = resolve_block_context(project, "A")["entries"]["p1"]
    assert entry["startPose"] == entry["targetPose"]
    assert entry["sources"]["x"] is None
    assert entry["path"] == []


def test_axes_resolve_independently():
    """A sets x+y, B sets only x: for block C, x tracks from B but y still
    tracks from A — per-axis chains, exactly like playback."""
    project = _project_with(
        _cue("A", 0, {"p1": {"target_x_cm": 100.0, "target_y_cm": 200.0}}),
        _cue("B", 2000, {"p1": {"target_x_cm": 500.0}}),
        _cue("C", 6000, {"p1": {"target_x_cm": 900.0, "target_y_cm": 900.0}}),
    )
    entry = resolve_block_context(project, "C")["entries"]["p1"]
    assert entry["startPose"][:2] == [500.0, 200.0]
    assert entry["sources"]["x"] == "B"
    assert entry["sources"]["y"] == "A"


def test_untouched_axis_holds_its_tracked_value():
    """Yaw-only activation (the demo's Contre-jour case): x/y start ==
    target == wherever the point already is, so there's no spatial path."""
    project = _project_with(
        _cue("A", 0, {"p1": {"target_x_cm": 100.0, "target_y_cm": 200.0,
                             "target_yaw_deg": 0.0}}),
        _cue("B", 4000, {"p1": {"target_yaw_deg": 225.0}}),
    )
    entry = resolve_block_context(project, "B")["entries"]["p1"]
    assert entry["startPose"][:2] == [100.0, 200.0]
    assert entry["targetPose"][:2] == [100.0, 200.0]
    assert entry["startPose"][3] == 0.0
    assert entry["targetPose"][3] == 225.0
    assert entry["path"] == []
    assert entry["sources"]["x"] is None  # untouched by this block


def test_point_with_no_known_position_gets_no_poses():
    """Activation touches only yaw and the point has never been positioned:
    never invent a position (mirrors the PSN rule)."""
    project = _project_with(
        _cue("A", 0, {"p1": {"target_yaw_deg": 90.0}}),
    )
    entry = resolve_block_context(project, "A")["entries"]["p1"]
    assert entry["startPose"] is None
    assert entry["targetPose"] is None
    assert entry["path"] == []


def test_path_is_spatial_only_with_no_easing_baked_in():
    """The polyline is uniform-parameter geometry; easing lives only in
    `timing`. With a strongly non-linear easing the midpoint sample must
    still be the arithmetic midpoint of start and target."""
    project = _project_with(
        _cue("A", 0, {"p1": {"target_x_cm": 0.0, "target_y_cm": 0.0}}),
        _cue("B", 2000, {"p1": {"target_x_cm": 1000.0, "target_y_cm": 500.0}},
             easing="exponential", fade_ms=3000),
    )
    entry = resolve_block_context(project, "B")["entries"]["p1"]
    path = entry["path"]
    assert path[0][:2] == [0.0, 0.0]
    assert path[-1][:2] == [1000.0, 500.0]
    mid = path[len(path) // 2]
    assert mid[0] == pytest.approx(500.0)
    assert mid[1] == pytest.approx(250.0)
    assert entry["timing"] == {"startMs": 2000.0, "fadeMs": 3000.0,
                               "easing": "exponential"}


def test_unknown_cue_raises():
    project = _project_with(
        _cue("A", 0, {"p1": {"target_x_cm": 0.0, "target_y_cm": 0.0}}),
    )
    with pytest.raises(ValueError):
        resolve_block_context(project, "nope")


# ----------------------------------------------------------- sidecar ------

def _run(coro):
    return asyncio.run(coro)


def test_sidecar_replies_block_context_to_requester_only():
    """A read-only query must return a dict (reply to the requester), never
    None (which would broadcast the whole project to every client)."""
    session = Session()
    cue_id = session.project.cues[0].id
    reply = _run(_handle_message(session, {"type": "resolve_block_context",
                                           "cueId": cue_id}))
    assert reply is not None and reply["type"] == "block_context"
    assert reply["cueId"] == cue_id
    assert set(reply["entries"]) == {"p1", "p2", "p3"}


def test_sidecar_reports_unknown_cue_as_error():
    session = Session()
    reply = _run(_handle_message(session, {"type": "resolve_block_context",
                                           "cueId": "nope"}))
    assert reply is not None and reply["type"] == "error"
