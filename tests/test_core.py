"""Core tests. These cover the parts that must not silently break:
the PSN wire format, packet splitting, timeline maths and timecode parsing.

Run with:  pytest
"""
import struct

import pytest

from stanczpsn.core.psn import (
    Tracker, build_data_packet, build_info_packet,
    split_data_packets, split_info_packets, PSN_MAX_PACKET_SIZE,
)
from stanczpsn.core.timeline import Timeline, OutputTransform, apply_easing
from stanczpsn.core.project import Project, Point, Formation
from stanczpsn.core import timecode as tc


def _trackers(n, name_len=10):
    return [Tracker(id=i, name=("T" * name_len) + str(i),
                    x_m=i * 0.5, y_m=-i * 0.25, z_m=1.0) for i in range(n)]


# --------------------------------------------------------------- PSN ------

def test_data_packet_roundtrip():
    pypsn = pytest.importorskip("pypsn")
    trackers = _trackers(3)
    decoded = pypsn.parse_psn_packet(build_data_packet(trackers, frame_id=5))
    assert len(decoded.trackers) == 3
    assert decoded.info.frame_id == 5
    assert decoded.trackers[2].pos.x == pytest.approx(1.0)
    assert decoded.trackers[2].pos.y == pytest.approx(-0.5)
    assert decoded.trackers[2].pos.z == pytest.approx(1.0)


def test_info_packet_roundtrip():
    pypsn = pytest.importorskip("pypsn")
    decoded = pypsn.parse_psn_packet(build_info_packet(_trackers(3), "sys"))
    assert decoded.name in (b"sys", "sys")
    assert len(decoded.trackers) == 3


@pytest.mark.parametrize("count", [1, 40, 92, 300])
def test_splits_respect_mtu_and_keep_every_tracker(count):
    pypsn = pytest.importorskip("pypsn")
    trackers = _trackers(count)

    data = split_data_packets(trackers, frame_id=1)
    info = split_info_packets(trackers, "sys", frame_id=1)
    assert all(len(p) <= PSN_MAX_PACKET_SIZE for p in data + info)

    got = []
    for packet in data:
        got += [t.id for t in pypsn.parse_psn_packet(packet).trackers]
    assert sorted(got) == sorted(t.id for t in trackers)

    got_info = []
    for packet in info:
        got_info += [t.tracker_id for t in pypsn.parse_psn_packet(packet).trackers]
    assert sorted(got_info) == sorted(t.id for t in trackers)


def test_packet_count_is_reported():
    pypsn = pytest.importorskip("pypsn")
    packets = split_data_packets(_trackers(200), frame_id=3)
    assert len(packets) > 1
    assert pypsn.parse_psn_packet(packets[0]).info.packet_count == len(packets)


# ---------------------------------------------------------- timeline ------

def _demo_project():
    p = Project(stage_width_cm=1000, stage_height_cm=1000)
    p.points = [Point(id="a", name="A", number=1), Point(id="b", name="B", number=2)]
    p.formations = [
        Formation(id="f1", name="one", order=10, duration_ms=1000,
                  easing="linear", positions={"a": (0.0, 0.0)}),
        Formation(id="f2", name="two", order=20, duration_ms=1000,
                  easing="linear", positions={"a": (100.0, 200.0)}),
    ]
    return p


def test_timeline_interpolates_linearly():
    tl = Timeline(_demo_project())
    assert tl.positions_at(1000)["a"] == pytest.approx((0.0, 0.0))
    mid = tl.positions_at(1500)["a"]
    assert mid == pytest.approx((50.0, 100.0))
    assert tl.positions_at(2000)["a"] == pytest.approx((100.0, 200.0))


def test_point_without_position_is_absent_not_zero():
    tl = Timeline(_demo_project())
    assert "b" not in tl.positions_at(1500)


def test_point_keeps_last_position_when_not_in_formation():
    project = _demo_project()
    project.formations.append(
        Formation(id="f3", name="three", order=30, duration_ms=1000,
                  easing="linear", positions={"b": (10.0, 10.0)}))
    tl = Timeline(project)
    # 'a' is not in f3, so it must hold its f2 position
    assert tl.positions_at(2500)["a"] == pytest.approx((100.0, 200.0))


def test_segments_are_cumulative():
    tl = Timeline(_demo_project())
    bounds = [(s, e) for s, e, _f in tl.segments]
    assert bounds == [(0.0, 1000.0), (1000.0, 2000.0)]


@pytest.mark.parametrize("name", ["linear", "smooth", "bounce", "spring",
                                  "exponential", "ease-in", "ease-out",
                                  "linéaire", "doux", "rebond", "unknown-name"])
def test_easing_is_bounded_and_anchored(name):
    assert apply_easing(name, 0.0) == pytest.approx(0.0, abs=1e-6)
    assert apply_easing(name, 1.0) == pytest.approx(1.0, abs=1e-6)


# --------------------------------------------------------- transform ------

def test_transform_cm_to_metres_with_origin_and_invert():
    t = OutputTransform(origin_x_cm=2500, origin_y_cm=1500, invert_y=True, z_m=1.8)
    x, y, z = t.to_metres(3050, 3505)
    assert x == pytest.approx(5.5)
    assert y == pytest.approx(-20.05)
    assert z == pytest.approx(1.8)


def test_transform_swap_axes():
    t = OutputTransform(swap_xy=True)
    x, y, _z = t.to_metres(100, 200)
    assert (x, y) == pytest.approx((2.0, 1.0))


# ---------------------------------------------------------- timecode ------

@pytest.mark.parametrize("text,expected_ms", [
    ("90", 90_000),
    ("1:30", 90_000),
    ("00:01:30.500", 90_500),
    ("1:02:03,250", 3_723_250),
])
def test_parse_timecode(text, expected_ms):
    assert tc.parse_timecode(text) == pytest.approx(expected_ms)


def test_parse_timecode_rejects_garbage():
    with pytest.raises(ValueError):
        tc.parse_timecode("not a timecode")


def test_format_timecode_with_and_without_frames():
    assert tc.format_timecode(90_500) == "00:01:30.500"
    assert tc.format_timecode(90_500, fps=25) == "00:01:30:12"


def test_artnet_timecode_decode():
    packet = (b"Art-Net\x00" + struct.pack("<H", 0x9700)
              + struct.pack(">H", 14) + b"\x00\x00"
              + struct.pack("<BBBBB", 12, 30, 1, 2, 1))  # 02:01:30:12 @25fps
    ms, fps = tc.parse_artnet_timecode(packet)
    assert fps == 25.0
    assert ms == pytest.approx(tc.hmsf_to_ms(2, 1, 30, 12, 25.0))


def test_artnet_ignores_other_opcodes():
    packet = b"Art-Net\x00" + struct.pack("<H", 0x5000) + b"\x00" * 20
    assert tc.parse_artnet_timecode(packet) is None


# ----------------------------------------------------------- project ------

def test_project_save_load_roundtrip(tmp_path):
    project = _demo_project()
    project.name = "Round trip"
    path = tmp_path / "p.spsn"
    project.save(str(path))
    back = Project.load(str(path))
    assert back.name == "Round trip"
    assert len(back.points) == 2
    assert back.formations[1].positions["a"] == (100.0, 200.0)


def test_tracker_id_falls_back_to_number_then_index():
    assert Point(id="x", name="x", number=7).resolved_tracker_id(0) == 7
    assert Point(id="x", name="x", number=7, psn_tracker_id=99).resolved_tracker_id(0) == 99
    assert Point(id="x", name="x").resolved_tracker_id(4) == 4
