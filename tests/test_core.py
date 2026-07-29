"""Core tests. These cover the parts that must not silently break:
the PSN wire format, packet splitting, cue/activation timeline maths and
timecode parsing.

Run with:  pytest
"""
import math
import struct

import pytest

from lumitrack.core.psn import (
    Tracker, build_data_packet, build_info_packet,
    split_data_packets, split_info_packets, PSN_MAX_PACKET_SIZE,
)
from lumitrack.core.timeline import Timeline, OutputTransform, apply_easing, resolve_positions
from lumitrack.core.project import (
    Project, Point, Cue, Activation, save_bundle, load_bundle,
)
from lumitrack.core import timecode as tc


def _trackers(n, name_len=10):
    return [Tracker(id=i, name=("T" * name_len) + str(i),
                    x_m=i * 0.5, y_m=-i * 0.25, z_m=1.0, ori_y=0.1 * i)
            for i in range(n)]


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


def test_data_packet_orientation_roundtrip():
    pypsn = pytest.importorskip("pypsn")
    trackers = [Tracker(id=0, name="A", ori_y=math.pi / 2)]
    decoded = pypsn.parse_psn_packet(build_data_packet(trackers))
    # Convention officielle (spec 2.03) : Y est l'axe vertical, le lacet est
    # donc un vecteur axe-angle porté par ori_y.
    assert decoded.trackers[0].ori.y == pytest.approx(math.pi / 2)
    assert decoded.trackers[0].ori.x == pytest.approx(0.0)
    assert decoded.trackers[0].ori.z == pytest.approx(0.0)


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
    p.cues = [
        Cue(id="c1", name="one", start_ms=0, duration_ms=1000, activations={
            "a": Activation(target_x_cm=0.0, target_y_cm=0.0, fade_ms=1000, easing="linear"),
        }),
        Cue(id="c2", name="two", start_ms=1000, duration_ms=1000, activations={
            "a": Activation(target_x_cm=100.0, target_y_cm=200.0, fade_ms=1000, easing="linear"),
        }),
    ]
    return p


def test_timeline_interpolates_linearly():
    tl = Timeline(_demo_project())
    assert (tl.positions_at(1000)["a"].x_cm, tl.positions_at(1000)["a"].y_cm) == pytest.approx((0.0, 0.0))
    mid = tl.positions_at(1500)["a"]
    assert (mid.x_cm, mid.y_cm) == pytest.approx((50.0, 100.0))
    end = tl.positions_at(2000)["a"]
    assert (end.x_cm, end.y_cm) == pytest.approx((100.0, 200.0))


def test_point_without_position_is_absent_not_zero():
    tl = Timeline(_demo_project())
    assert "b" not in tl.positions_at(1500)


def test_point_keeps_last_position_when_not_touched_by_a_later_cue():
    project = _demo_project()
    project.cues.append(Cue(id="c3", name="three", start_ms=2000, duration_ms=1000,
                             activations={"b": Activation(target_x_cm=10.0, target_y_cm=10.0, fade_ms=1000)}))
    tl = Timeline(project)
    # 'a' is not touched by c3, so it must hold its c2 position.
    a = tl.positions_at(2500)["a"]
    assert (a.x_cm, a.y_cm) == pytest.approx((100.0, 200.0))


def test_overlapping_cues_resolve_by_latest_start_ltp():
    """Two cues that both touch the same point and overlap in time: the one
    with the later start_ms governs from the moment it starts (§12.2 LTP),
    even if the earlier cue's own fade window hasn't finished yet."""
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="early", name="early", start_ms=0, duration_ms=2000,
            activations={"a": Activation(target_x_cm=1000, target_y_cm=0, fade_ms=2000)}),
        Cue(id="late", name="late", start_ms=500, duration_ms=500,
            activations={"a": Activation(target_x_cm=0, target_y_cm=500, fade_ms=500)}),
    ]
    poses = resolve_positions(project, 1000)
    # By t=1000 the "late" cue has fully taken over and finished its own fade.
    assert (poses["a"].x_cm, poses["a"].y_cm) == pytest.approx((0.0, 500.0))


def test_first_appearance_snaps_to_target_without_animating_in():
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000,
                         activations={"a": Activation(target_x_cm=500, target_y_cm=500, fade_ms=1000)})]
    poses_before = resolve_positions(project, 500)
    assert "a" not in poses_before
    poses_at_start = resolve_positions(project, 1000)
    assert (poses_at_start["a"].x_cm, poses_at_start["a"].y_cm) == pytest.approx((500.0, 500.0))


def test_z_and_yaw_default_when_never_set():
    project = _demo_project()
    pose = resolve_positions(project, 1500)["a"]
    assert pose.z_cm == pytest.approx(project.points[0].default_height_cm)
    assert pose.yaw_deg == pytest.approx(0.0)


def test_z_and_yaw_are_independent_animatable_tracks():
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c1", name="c1", start_ms=0, duration_ms=1000,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, target_z_cm=100,
                                          target_yaw_deg=90, fade_ms=1000)}),
        # Only rotates further; x/y/z keep tracking the previous cue's values.
        Cue(id="c2", name="c2", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(target_yaw_deg=450, fade_ms=1000)}),
    ]
    mid = resolve_positions(project, 1500)["a"]
    assert (mid.x_cm, mid.y_cm, mid.z_cm) == pytest.approx((0.0, 0.0, 100.0))
    assert mid.yaw_deg == pytest.approx(270.0)  # multi-turn value, not wrapped


@pytest.mark.parametrize("name", ["linear", "smooth", "bounce", "spring",
                                  "exponential", "ease-in", "ease-out",
                                  "linéaire", "doux", "rebond", "unknown-name"])
def test_easing_is_bounded_and_anchored(name):
    assert apply_easing(name, 0.0) == pytest.approx(0.0, abs=1e-6)
    assert apply_easing(name, 1.0) == pytest.approx(1.0, abs=1e-6)


# --------------------------------------------------------- transform ------

def test_transform_cm_to_metres_with_origin_and_invert():
    t = OutputTransform(origin_x_cm=2500, origin_y_cm=1500, invert_y=True)
    x, y, z = t.to_metres(3050, 3505, z_cm=180)
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
    act = back.cue_by_id("c2").activations["a"]
    assert (act.target_x_cm, act.target_y_cm) == (100.0, 200.0)


def test_tracker_id_falls_back_to_number_then_index():
    assert Point(id="x", name="x", number=7).resolved_tracker_id(0) == 7
    assert Point(id="x", name="x", number=7, psn_tracker_id=99).resolved_tracker_id(0) == 99
    assert Point(id="x", name="x").resolved_tracker_id(4) == 4


def test_apply_group_transform_gives_each_point_its_own_arc():
    """A group rotation must not move points rigidly: each point keeps its
    own distance to the pivot, so a wider point sweeps a wider arc
    (CONCEPTION.md §13.1 point 1)."""
    project = Project()
    project.points = [Point(id="near", name="near"), Point(id="far", name="far")]
    setup_cue = Cue(id="setup", name="setup", start_ms=0, duration_ms=1,
                     activations={
                         "near": Activation(target_x_cm=110, target_y_cm=100, fade_ms=1),
                         "far": Activation(target_x_cm=200, target_y_cm=100, fade_ms=1),
                     })
    move_cue = Cue(id="move", name="move", start_ms=1000, duration_ms=1000)
    project.cues = [setup_cue, move_cue]

    project.apply_group_transform(
        move_cue, ["near", "far"], pivot=(100.0, 100.0), rotate_deg=90.0,
        fade_ms=1000.0, easing="linear",
    )

    poses = resolve_positions(project, 2000)
    # 90° rotation around (100,100): (110,100) -> (100,110); (200,100) -> (100,200)
    assert (poses["near"].x_cm, poses["near"].y_cm) == pytest.approx((100.0, 110.0), abs=1e-6)
    assert (poses["far"].x_cm, poses["far"].y_cm) == pytest.approx((100.0, 200.0), abs=1e-6)
    near_radius = math.hypot(poses["near"].x_cm - 100.0, poses["near"].y_cm - 100.0)
    far_radius = math.hypot(poses["far"].x_cm - 100.0, poses["far"].y_cm - 100.0)
    assert far_radius > near_radius


def test_bundle_roundtrip_dedupes_media_by_hash(tmp_path):
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(b"fake-audio-bytes")

    project = _demo_project()
    project.name = "Bundled"
    project.audio_path = str(audio)
    bundle_dir = str(tmp_path / "Show.bundle")

    save_bundle(project, bundle_dir)
    # Re-save without changing the audio: must not create a second media file.
    save_bundle(project, bundle_dir)

    media_dir = tmp_path / "Show.bundle" / "media"
    audio_copies = list(media_dir.glob("*.m4a"))
    assert len(audio_copies) == 1

    back = load_bundle(bundle_dir)
    assert back.name == "Bundled"
    assert back.audio_path and back.audio_path.endswith(".m4a")
    with open(back.audio_path, "rb") as fh:
        assert fh.read() == b"fake-audio-bytes"


# ------------------------------------------------- courbes (graph editor) --

def _curve_linear():
    return [{"t": 0.0, "v": 0.0, "inT": None, "inV": None, "outT": None, "outV": None, "mode": "corner"},
            {"t": 1.0, "v": 1.0, "inT": None, "inV": None, "outT": None, "outV": None, "mode": "corner"}]


def _curve_ease_in_out():
    # cubic-bezier(0.42, 0, 0.58, 1) en poignées absolues.
    return [{"t": 0.0, "v": 0.0, "outT": 0.42, "outV": 0.0, "inT": None, "inV": None, "mode": "smooth"},
            {"t": 1.0, "v": 1.0, "inT": 0.58, "inV": 1.0, "outT": None, "outV": None, "mode": "smooth"}]


def test_eval_curve_linear_is_identity():
    from lumitrack.core.timeline import eval_curve
    for u in (0.0, 0.25, 0.5, 0.99, 1.0):
        assert abs(eval_curve(_curve_linear(), u) - u) < 1e-6


def test_eval_curve_endpoints_and_monotonic_ease():
    from lumitrack.core.timeline import eval_curve
    c = _curve_ease_in_out()
    assert abs(eval_curve(c, 0.0)) < 1e-6
    assert abs(eval_curve(c, 1.0) - 1.0) < 1e-6
    # ease-in-out : lent au départ, rapide au milieu, symétrique.
    assert eval_curve(c, 0.1) < 0.1
    assert eval_curve(c, 0.9) > 0.9
    assert abs(eval_curve(c, 0.5) - 0.5) < 1e-3
    prev = -1.0
    for i in range(21):
        v = eval_curve(c, i / 20.0)
        assert v >= prev - 1e-9
        prev = v


def test_eval_curve_multi_node_with_overshoot():
    from lumitrack.core.timeline import eval_curve
    # 3 nœuds : montée au-dessus de 1 (overshoot) puis redescente sur 1.
    c = [{"t": 0.0, "v": 0.0, "outT": 0.1, "outV": 0.6, "inT": None, "inV": None, "mode": "corner"},
         {"t": 0.5, "v": 1.2, "inT": 0.35, "inV": 1.2, "outT": 0.65, "outV": 1.2, "mode": "smooth"},
         {"t": 1.0, "v": 1.0, "inT": 0.9, "inV": 1.0, "outT": None, "outV": None, "mode": "corner"}]
    assert abs(eval_curve(c, 0.5) - 1.2) < 1e-6  # passe par le nœud central
    assert eval_curve(c, 0.45) > 1.0             # dépassement effectif
    assert abs(eval_curve(c, 1.0) - 1.0) < 1e-6


def test_eval_curve_defensive():
    from lumitrack.core.timeline import eval_curve
    assert eval_curve([], 0.4) == 0.4            # pas de courbe -> identité
    assert eval_curve([{"t": 0, "v": 5}], 0.4) == 0.4


def test_resolution_uses_per_axis_curve():
    from lumitrack.core.project import Project, Point, Cue, Activation
    from lumitrack.core.timeline import resolve_positions
    p = Project(name="t")
    p.points.append(Point(id="p1", name="P1"))
    # Courbe "tout de suite à la cible" sur X seulement ; Y reste linéaire.
    fast = [{"t": 0.0, "v": 0.0, "outT": 0.0, "outV": 1.0, "inT": None, "inV": None, "mode": "corner"},
            {"t": 1.0, "v": 1.0, "inT": 0.3, "inV": 1.0, "outT": None, "outV": None, "mode": "corner"}]
    p.cues.append(Cue(id="c1", name="A", start_ms=0, duration_ms=1000, activations={
        "p1": Activation(target_x_cm=0.0, target_y_cm=0.0, fade_ms=0.0)}))
    p.cues.append(Cue(id="c2", name="B", start_ms=1000, duration_ms=1000, activations={
        "p1": Activation(target_x_cm=100.0, target_y_cm=100.0, fade_ms=1000.0,
                         easing="linear", curves={"x": fast})}))
    pose = resolve_positions(p, 1500.0)["p1"]
    assert pose.y_cm == 50.0                     # linéaire nommé sur Y
    assert pose.x_cm > 85.0                      # courbe rapide sur X
    assert resolve_positions(p, 2000.0)["p1"].x_cm == 100.0  # cible atteinte


def test_curves_survive_bundle_roundtrip(tmp_path):
    from lumitrack.core.project import Project, Point, Cue, Activation, save_bundle, load_bundle
    p = Project(name="rt")
    p.points.append(Point(id="p1", name="P1"))
    curve = _curve_ease_in_out()
    p.cues.append(Cue(id="c1", name="A", start_ms=0, duration_ms=500, activations={
        "p1": Activation(target_x_cm=10.0, curves={"x": curve, "yaw": _curve_linear()})}))
    path = str(tmp_path / "rt.lumitrack")
    save_bundle(p, path)
    p2 = load_bundle(path)
    act = p2.cues[0].activations["p1"]
    assert act.curves is not None and set(act.curves.keys()) == {"x", "yaw"}
    assert act.curves["x"][0]["outT"] == 0.42


# ---------------------------------------------------- tracé spatial (AE) ---

def _path_project():
    from lumitrack.core.project import Project, Point, Cue, Activation
    p = Project(name="path")
    p.points.append(Point(id="p1", name="P1"))
    p.cues.append(Cue(id="c1", name="A", start_ms=0, duration_ms=500, activations={
        "p1": Activation(target_x_cm=0.0, target_y_cm=0.0, fade_ms=0.0)}))
    p.cues.append(Cue(id="c2", name="B", start_ms=1000, duration_ms=2000, activations={
        "p1": Activation(target_x_cm=1000.0, target_y_cm=0.0, fade_ms=2000.0,
                         easing="linear",
                         path_points=[{"xCm": 500.0, "yCm": 400.0,
                                       "inDxCm": None, "inDyCm": None,
                                       "outDxCm": None, "outDyCm": None}])}))
    return p


def test_spatial_path_bends_through_waypoint():
    from lumitrack.core.timeline import resolve_positions
    p = _path_project()
    # Extrémités exactes.
    assert resolve_positions(p, 1000.0)["p1"].y_cm == 0.0
    end = resolve_positions(p, 3000.0)["p1"]
    assert (end.x_cm, end.y_cm) == (1000.0, 0.0)
    # À mi-parcours (longueur d'arc), le tracé passe près du waypoint —
    # loin de la droite y=0.
    mid = resolve_positions(p, 2000.0)["p1"]
    assert mid.y_cm > 250.0
    # Sans tracé, la même config reste sur la droite.
    p.cues[1].activations["p1"].path_points = None
    mid2 = resolve_positions(p, 2000.0)["p1"]
    assert abs(mid2.y_cm) < 1e-9


def test_spatial_path_arc_length_uniform_speed():
    from lumitrack.core.timeline import resolve_positions
    import math as m
    p = _path_project()
    # Vitesse ~constante : les distances entre échantillons réguliers sont
    # proches les unes des autres (paramétrage par longueur d'arc).
    poses = [resolve_positions(p, 1000.0 + i * 200.0)["p1"] for i in range(11)]
    dists = [m.hypot(b.x_cm - a.x_cm, b.y_cm - a.y_cm)
             for a, b in zip(poses, poses[1:])]
    assert max(dists) / min(dists) < 1.20


def test_spatial_path_ltp_steals_one_axis():
    from lumitrack.core.project import Cue, Activation
    from lumitrack.core.timeline import resolve_positions
    p = _path_project()
    # Un cue postérieur vole X en plein parcours : X suit le nouveau cue,
    # Y retombe sur la résolution par axe (tracé écrasé, pas de crash).
    p.cues.append(Cue(id="c3", name="C", start_ms=1500, duration_ms=500, activations={
        "p1": Activation(target_x_cm=-200.0, fade_ms=500.0, easing="linear")}))
    pose = resolve_positions(p, 1750.0)["p1"]
    # Reprise sans téléportation (fix 2026-07-29) : à 1500, x résolu de c2
    # vaut 250 (quart de fade) — c3 fond donc de 250 vers -200 ; mi-fade=25.
    assert abs(pose.x_cm - 25.0) < 1e-6
    assert pose.y_cm == 0.0    # par axe : y gouverné par c2, droite linéaire


def test_spatial_path_block_context_curved():
    from lumitrack.core.timeline import resolve_block_context
    p = _path_project()
    entries = resolve_block_context(p, "c2")["entries"]
    path = entries["p1"]["path"]
    assert len(path) == 25
    assert max(pt[1] for pt in path) > 300.0  # le tracé affiché est courbé
    assert path[0][:2] == [0.0, 0.0] and path[-1][:2] == [1000.0, 0.0]


def test_spatial_path_handles_and_roundtrip(tmp_path):
    from lumitrack.core.project import save_bundle, load_bundle
    from lumitrack.core.timeline import resolve_positions
    p = _path_project()
    act = p.cues[1].activations["p1"]
    act.start_handle = {"dxCm": 0.0, "dyCm": 300.0}
    act.target_handle = {"dxCm": 0.0, "dyCm": 300.0}
    path = str(tmp_path / "p.lumitrack")
    save_bundle(p, path)
    p2 = load_bundle(path)
    act2 = p2.cues[1].activations["p1"]
    assert act2.start_handle == {"dxCm": 0.0, "dyCm": 300.0}
    assert act2.path_points[0]["xCm"] == 500.0
    # Les poignées influencent le parcours (départ tiré vers +y).
    early = resolve_positions(p2, 1200.0)["p1"]
    assert early.y_cm > 50.0


# ------------------------------------------------------ pistes (timeline) --

def test_lane_roundtrip_and_migration(tmp_path):
    import json
    from lumitrack.core.project import Project, Cue
    p = Project(name="lanes")
    p.cues.append(Cue(id="a", name="A", start_ms=0, duration_ms=2000, lane=2))
    d = p.to_dict()
    assert d["cues"][0]["lane"] == 2
    assert Project.from_dict(d).cues[0].lane == 2
    # Migration : un projet SANS lane et avec chevauchements retrouve
    # l'ancien empilement glouton (aucun chevauchement sur une même piste).
    legacy = Project(name="old")
    legacy.cues = [Cue(id="a", name="A", start_ms=0, duration_ms=3000),
                   Cue(id="b", name="B", start_ms=1000, duration_ms=3000),
                   Cue(id="c", name="C", start_ms=3500, duration_ms=1000)]
    d = legacy.to_dict()
    for c in d["cues"]:
        del c["lane"]
    migrated = Project.from_dict(json.loads(json.dumps(d)))
    lanes = {c.id: c.lane for c in migrated.cues}
    assert lanes["a"] == 0 and lanes["b"] == 1
    assert lanes["c"] == 0  # la piste 0 est libre à 3500 ms


# --------------------------------------------- reprise entre blocs (fix) ---

def test_overlapping_blocks_hand_over_without_teleport():
    """Un bloc qui démarre pendant le fade d'un autre reprend l'acteur LÀ OÙ
    IL EST (fix téléportation 2026-07-29), pas à la cible théorique du
    premier bloc."""
    from lumitrack.core.project import Project, Point, Cue, Activation
    from lumitrack.core.timeline import resolve_positions
    p = Project(name="handoff")
    p.points.append(Point(id="p1", name="P1"))
    p.cues.append(Cue(id="a", name="A", start_ms=0, duration_ms=2000, activations={
        "p1": Activation(target_x_cm=0.0, target_y_cm=0.0, fade_ms=0.0)}))
    # A' : part vers x=1000 en 2 s (linéaire).
    p.cues.append(Cue(id="b", name="B", start_ms=1000, duration_ms=2000, activations={
        "p1": Activation(target_x_cm=1000.0, fade_ms=2000.0, easing="linear")}))
    # C démarre à 2000, en PLEIN fade de B (B est à 500 à cet instant).
    p.cues.append(Cue(id="c", name="C", start_ms=2000, duration_ms=1000, activations={
        "p1": Activation(target_x_cm=0.0, fade_ms=1000.0, easing="linear")}))
    just_before = resolve_positions(p, 1999.9)["p1"].x_cm
    just_after = resolve_positions(p, 2000.1)["p1"].x_cm
    assert abs(just_before - 500.0) < 1.0
    # Continuité : pas de saut à la prise de main de C.
    assert abs(just_after - just_before) < 2.0
    # Mi-fade de C : de ~500 vers 0 -> ~250.
    assert abs(resolve_positions(p, 2500.0)["p1"].x_cm - 250.0) < 2.0
    assert resolve_positions(p, 3000.0)["p1"].x_cm == 0.0


def test_sequential_blocks_still_track_from_target():
    """Blocs SANS chevauchement : comportement inchangé (l'acteur est déjà à
    la cible du précédent quand le suivant démarre)."""
    from lumitrack.core.project import Project, Point, Cue, Activation
    from lumitrack.core.timeline import resolve_positions
    p = Project(name="seq")
    p.points.append(Point(id="p1", name="P1"))
    p.cues.append(Cue(id="a", name="A", start_ms=0, duration_ms=1000, activations={
        "p1": Activation(target_x_cm=100.0, target_y_cm=0.0, fade_ms=500.0)}))
    p.cues.append(Cue(id="b", name="B", start_ms=2000, duration_ms=1000, activations={
        "p1": Activation(target_x_cm=300.0, fade_ms=1000.0, easing="linear")}))
    assert resolve_positions(p, 2000.0)["p1"].x_cm == 100.0
    assert abs(resolve_positions(p, 2500.0)["p1"].x_cm - 200.0) < 1e-6
