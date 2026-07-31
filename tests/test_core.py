"""Core tests. These cover the parts that must not silently break:
the PSN wire format, packet splitting, cue/activation timeline maths and
timecode parsing.

Run with:  pytest
"""
import json
import math
import os
import shutil
import struct
import sys

import pytest

from lumitrack.core.psn import (
    Tracker, build_data_packet, build_info_packet,
    split_data_packets, split_info_packets, PSN_MAX_PACKET_SIZE,
)
from lumitrack.core.timeline import Timeline, OutputTransform, apply_easing, resolve_positions
from lumitrack.core.project import (
    Project, Point, Cue, Activation, save_bundle, load_bundle, list_archive,
    BUNDLE_FILE_EXT, ARCHIVE_MAX_VERSIONS,
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
    # Milieu de la fenêtre de lacet de c2 (YAW_TURN_MS=400, pas fade_ms=1000
    # — voir test_yaw_turns_quickly_at_start_of_move ci-dessous), pas milieu
    # du fade x/y/z : la même fraction de progression (50 %) est atteinte
    # bien plus tôt sur le lacet que sur la position.
    mid = resolve_positions(project, 1200)["a"]
    assert (mid.x_cm, mid.y_cm, mid.z_cm) == pytest.approx((0.0, 0.0, 100.0))
    assert mid.yaw_deg == pytest.approx(270.0)  # multi-turn value, not wrapped


# ------------------------------------------------- lacet en debut de trajet
#
# "Un acteur se tourne avant de prendre de courir, il ne tourne pas jusqu'à
# son arrivée" (Florian, 2026-07-31) : le lacet tourne au tout début du
# mouvement (fenêtre courte, YAW_TURN_MS), pas étalé sur toute la durée du
# déplacement x/y — mais toujours eased, jamais un cut instantané.

def test_yaw_turns_quickly_at_start_of_move_not_spread_over_it():
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, target_yaw_deg=0, fade_ms=0)}),
        # Déplacement long (4s) avec un virage de 90°.
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=4000,
            activations={"a": Activation(target_x_cm=1000, target_y_cm=0,
                                          target_yaw_deg=90, fade_ms=4000)}),
    ]
    from lumitrack.core.timeline import YAW_TURN_MS
    # Milieu de la fenêtre de lacet (200 ms sur les 400 ms de YAW_TURN_MS) :
    # le virage est déjà à moitié fait alors que le déplacement x/y vient à
    # peine de commencer (200/4000 = 5 %).
    mid_turn = resolve_positions(project, 1000 + YAW_TURN_MS / 2)["a"]
    assert mid_turn.yaw_deg == pytest.approx(45.0)
    assert mid_turn.x_cm == pytest.approx(50.0)  # 5 % de 1000, pas 45 %

    # Après la fenêtre de lacet mais bien avant l'arrivée : le lacet tient
    # déjà sa cible, le déplacement continue seul.
    mid_move = resolve_positions(project, 1000 + 2000)["a"]
    assert mid_move.yaw_deg == pytest.approx(90.0)
    assert mid_move.x_cm == pytest.approx(500.0)


def test_yaw_turn_never_outlasts_a_shorter_move():
    """Un déplacement plus court que YAW_TURN_MS ne fait jamais tourner le
    lacet plus longtemps que le mouvement lui-même — plafonné par fade_ms."""
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, target_yaw_deg=0, fade_ms=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=100,
            activations={"a": Activation(target_x_cm=100.0, target_y_cm=0,
                                          target_yaw_deg=90, fade_ms=100)}),
    ]
    at_end = resolve_positions(project, 1100)["a"]
    assert at_end.yaw_deg == pytest.approx(90.0)
    assert at_end.x_cm == pytest.approx(100.0)


def test_yaw_turn_is_eased_not_an_instant_cut():
    """Toujours un fondu, jamais un saut brut — au premier quart de la
    fenêtre de lacet, l'angle a bougé mais n'a pas encore atteint la cible."""
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, target_yaw_deg=0, fade_ms=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=4000,
            activations={"a": Activation(target_x_cm=1000, target_y_cm=0,
                                          target_yaw_deg=90, fade_ms=4000)}),
    ]
    just_after_start = resolve_positions(project, 1050)["a"]
    assert 0.0 < just_after_start.yaw_deg < 90.0


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


# ------------------------------------------------- stage-map -> PSN calage --
#
# Regression coverage for the 2026-07-31 mismatch: a stage centred on a
# terrain via the "Éditer la zone de jeu" gizmo (stage_map_origin_x_m/z_m,
# CONCEPTION.md §4/§14.3) used to have zero effect on PSN output, so a point
# shown correctly aligned with the terrain in Lumitrack's own 3D view landed
# roughly half a stage-width away in the previz (Capture) sharing that same
# terrain. `OutputTransform.to_metres` now folds the stage-map placement in
# before origin/invert/swap, using the identical rotate-then-translate
# formula `fit`/`StageGroup` apply in Scene.tsx.

def test_stage_map_defaults_are_a_no_op():
    """A project that never touches the terrain-mapping gizmo (defaults
    0, 0, 0°) must see byte-for-byte the same PSN output as before this
    fix — no behaviour change for stage-only projects."""
    t = OutputTransform(origin_x_cm=2500, origin_y_cm=1500, invert_y=True)
    x, y, z = t.to_metres(3050, 3505, z_cm=180)
    assert x == pytest.approx(5.5)
    assert y == pytest.approx(-20.05)
    assert z == pytest.approx(1.8)


def test_stage_centred_on_terrain_lands_at_terrain_origin():
    """The exact shape of the reported bug: a 9140x5500cm stage centred on
    a terrain (gizmo origin = -half width/height, no rotation). The
    stage's own centre must land at the terrain's (0, 0), matching what
    the 3D view already shows — not offset by half the stage width."""
    t = OutputTransform(stage_map_origin_x_m=-45.7, stage_map_origin_z_m=-27.5)
    x, y, _z = t.to_metres(4570, 2750)
    assert (x, y) == pytest.approx((0.0, 0.0), abs=1e-6)


def test_stage_map_translation_matches_reported_point():
    """The concrete point from the live project that surfaced the bug:
    p1 in "Entree" at (8541.88, 3640.70) cm must land at the same spot the
    3D view already draws it at (world X/Z from the stage-map placement),
    not at the old stage-local-origin PSN position."""
    t = OutputTransform(stage_map_origin_x_m=-45.7, stage_map_origin_z_m=-27.5)
    x, y, _z = t.to_metres(8541.882904242537, 3640.696565453493)
    assert x == pytest.approx(39.71882904242537)
    assert y == pytest.approx(8.90696565453493)


def test_stage_map_rotation_matches_frontend_convention():
    """Rotating the stage-map placement 90° must rotate positions using the
    exact same convention `toWorldX`/`toWorldZ` use in Scene.tsx's `fit`
    computation, so what's drawn on screen and what's sent over PSN never
    disagree once a terrain alignment needs rotation, not just translation."""
    t = OutputTransform(stage_map_rotation_deg=90.0)
    x, y, _z = t.to_metres(100, 0)  # 1m along local +X
    assert (x, y) == pytest.approx((0.0, -1.0), abs=1e-9)


def test_stage_map_folds_before_origin_invert_swap():
    """Origin/invert/swap remain a fine trim applied on top of the
    terrain-world position, not a competing frame of reference."""
    t = OutputTransform(stage_map_origin_x_m=10.0, stage_map_origin_z_m=5.0,
                        invert_x=True)
    x, y, _z = t.to_metres(100, 200)  # +1m local X, +2m local Y
    assert (x, y) == pytest.approx((-11.0, 7.0))


def test_output_transform_from_project_reads_stage_map():
    project = Project()
    project.stage_map_origin_x_m = -45.7
    project.stage_map_origin_z_m = -27.5
    project.stage_map_rotation_deg = 15.0
    t = OutputTransform.from_project(project)
    assert t.stage_map_origin_x_m == -45.7
    assert t.stage_map_origin_z_m == -27.5
    assert t.stage_map_rotation_deg == 15.0


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


def _bundled_project(tmp_path, audio_bytes=b"fake-audio-bytes"):
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(audio_bytes)
    project = _demo_project()
    project.name = "Bundled"
    project.audio_path = str(audio)
    return project


@pytest.mark.skipif(sys.platform != "win32", reason="icône de dossier = convention Windows Explorer uniquement")
def test_save_bundle_sets_a_windows_folder_icon(tmp_path):
    project = _bundled_project(tmp_path)
    bundle_dir = tmp_path / "IconShow"
    file_path = str(bundle_dir / f"IconShow{BUNDLE_FILE_EXT}")

    save_bundle(project, file_path)

    ini_path = bundle_dir / "desktop.ini"
    icon_path = bundle_dir / ".lumitrack.ico"
    assert ini_path.is_file()
    assert icon_path.is_file()
    assert "IconResource=.lumitrack.ico,0" in ini_path.read_text(encoding="utf-8")

    # Idempotent : un second save ne doit ni échouer ni dupliquer quoi que
    # ce soit (desktop.ini existant = no-op côté icône).
    save_bundle(project, file_path)
    assert ini_path.is_file()


def test_bundle_roundtrip_dedupes_media_by_hash(tmp_path):
    project = _bundled_project(tmp_path)
    file_path = str(tmp_path / "Show" / f"Show{BUNDLE_FILE_EXT}")

    save_bundle(project, file_path)
    # Re-save without changing the audio: must not create a second media file.
    save_bundle(project, file_path)

    media_dir = tmp_path / "Show" / "media"
    audio_copies = list(media_dir.glob("*.m4a"))
    assert len(audio_copies) == 1

    back = load_bundle(file_path)
    assert back.name == "Bundled"
    assert back.audio_path and back.audio_path.endswith(".m4a")
    with open(back.audio_path, "rb") as fh:
        assert fh.read() == b"fake-audio-bytes"


def test_resaving_archives_the_previous_file_not_overwrites_blindly(tmp_path):
    project = _bundled_project(tmp_path)
    file_path = str(tmp_path / "Show" / f"Show{BUNDLE_FILE_EXT}")

    save_bundle(project, file_path)
    project.name = "Bundled v2"
    save_bundle(project, file_path)

    archive_dir = tmp_path / "Show" / "archive"
    archived = list(archive_dir.glob(f"*{BUNDLE_FILE_EXT}"))
    assert len(archived) == 1
    with open(archived[0], encoding="utf-8") as fh:
        assert json.load(fh)["name"] == "Bundled"  # l'ancienne version, pas la nouvelle

    # Le fichier courant, lui, porte bien la nouvelle version.
    assert load_bundle(file_path).name == "Bundled v2"


def test_first_save_never_creates_an_archive_entry(tmp_path):
    project = _bundled_project(tmp_path)
    file_path = str(tmp_path / "Show" / f"Show{BUNDLE_FILE_EXT}")
    save_bundle(project, file_path)
    assert not (tmp_path / "Show" / "archive").exists()


def test_list_archive_reports_newest_first(tmp_path):
    import time

    project = _bundled_project(tmp_path)
    file_path = str(tmp_path / "Show" / f"Show{BUNDLE_FILE_EXT}")
    save_bundle(project, file_path)
    time.sleep(1.01)  # l'horodatage du nom a une résolution de la seconde
    project.name = "v2"
    save_bundle(project, file_path)

    entries = list_archive(file_path)
    assert len(entries) == 1
    assert entries[0]["name"].startswith("Show_")
    assert entries[0]["name"].endswith(BUNDLE_FILE_EXT)


def test_load_bundle_can_restore_a_specific_archived_version(tmp_path):
    project = _bundled_project(tmp_path)
    file_path = str(tmp_path / "Show" / f"Show{BUNDLE_FILE_EXT}")
    save_bundle(project, file_path)  # "Bundled" archivé au prochain save
    project.name = "Bundled v2"
    save_bundle(project, file_path)

    entries = list_archive(file_path)
    restored = load_bundle(file_path, archived_name=entries[0]["name"])
    assert restored.name == "Bundled"
    # Les médias de la version archivée restent résolubles (même dossier media/).
    assert restored.audio_path and os.path.isfile(restored.audio_path)


def test_archive_is_pruned_beyond_max_versions(tmp_path):
    project = _bundled_project(tmp_path)
    file_path = str(tmp_path / "Show" / f"Show{BUNDLE_FILE_EXT}")
    save_bundle(project, file_path)
    for i in range(ARCHIVE_MAX_VERSIONS + 5):
        project.name = f"v{i}"
        save_bundle(project, file_path)
    archive_dir = tmp_path / "Show" / "archive"
    assert len(list(archive_dir.glob(f"*{BUNDLE_FILE_EXT}"))) == ARCHIVE_MAX_VERSIONS


def test_legacy_directory_bundle_still_reads(tmp_path):
    """Ancien format (avant le 2026-07-31) : le dossier lui-même est le
    paquet (manifest.json + media/ + versions/latest.json) — doit rester
    lisible pour ne pas perdre les projets déjà sauvegardés ainsi."""
    project = _bundled_project(tmp_path)
    bundle_dir = tmp_path / "OldShow.bundle"
    media_dir = bundle_dir / "media"
    versions_dir = bundle_dir / "versions"
    media_dir.mkdir(parents=True)
    versions_dir.mkdir(parents=True)

    digest = "deadbeef"
    shutil.copyfile(project.audio_path, media_dir / f"{digest}.m4a")
    snapshot = project.to_dict()
    snapshot["audioPath"] = f"media/{digest}.m4a"
    with open(versions_dir / "latest.json", "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh)
    with open(bundle_dir / "manifest.json", "w", encoding="utf-8") as fh:
        json.dump({"format": "lumitrack-bundle", "version": 1,
                   "projectName": project.name, "latestVersion": 1}, fh)

    back = load_bundle(str(bundle_dir))
    assert back.name == "Bundled"
    assert back.audio_path and os.path.isfile(back.audio_path)


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


# ----------------------------------------------------------- backstage -----

def _bs_project():
    from lumitrack.core.project import Project, Point
    p = Project(name="bs", stage_height_cm=3000)
    p.points = [Point(id=f"p{i}", name=f"P{i}") for i in range(3)]
    p.ensure_backstage()
    return p


def test_backstage_default_zone_and_slots():
    from lumitrack.core.timeline import backstage_slot, BACKSTAGE_SPACING_CM
    p = _bs_project()
    assert len(p.backstage_zones) == 1
    assert all(pt.home_zone_id == p.backstage_zones[0]["id"] for pt in p.points)
    s0 = backstage_slot(p, "p0")
    s1 = backstage_slot(p, "p1")
    assert s0 is not None and s1 is not None
    assert s0 != s1  # pas d'empilement
    zone = p.backstage_zones[0]
    for s in (s0, s1):
        assert zone["xCm"] <= s[0] <= zone["xCm"] + zone["widthCm"]
    assert abs(s1[0] - s0[0]) == BACKSTAGE_SPACING_CM or abs(s1[1] - s0[1]) == BACKSTAGE_SPACING_CM


def test_backstage_actor_without_activation_is_visible_and_fades_in():
    from lumitrack.core.project import Cue, Activation
    from lumitrack.core.timeline import resolve_positions, backstage_slot
    p = _bs_project()
    slot = backstage_slot(p, "p0")
    # Sans activation : l'acteur vit dans sa zone (visible + PSN).
    pose = resolve_positions(p, 0.0)["p0"]
    assert (pose.x_cm, pose.y_cm) == slot
    # Entrée en scène : FONDU depuis la zone, plus de snap.
    p.cues.append(Cue(id="in", name="Entrée", start_ms=1000, duration_ms=2000, activations={
        "p0": Activation(target_x_cm=2000.0, target_y_cm=1000.0,
                         fade_ms=2000.0, easing="linear")}))
    mid = resolve_positions(p, 2000.0)["p0"]
    assert abs(mid.x_cm - (slot[0] + 2000.0) / 2) < 1e-6
    assert abs(mid.y_cm - (slot[1] + 1000.0) / 2) < 1e-6
    assert resolve_positions(p, 3000.0)["p0"].x_cm == 2000.0


def test_backstage_entrance_trajectory_in_block_context():
    from lumitrack.core.project import Cue, Activation
    from lumitrack.core.timeline import resolve_block_context, backstage_slot
    p = _bs_project()
    slot = backstage_slot(p, "p1")
    p.cues.append(Cue(id="in", name="Entrée", start_ms=0, duration_ms=1000, activations={
        "p1": Activation(target_x_cm=1500.0, target_y_cm=800.0, fade_ms=1000.0)}))
    entry = resolve_block_context(p, "in")["entries"]["p1"]
    assert entry["startPose"][0] == slot[0]
    assert entry["startPose"][1] == slot[1]
    assert len(entry["path"]) > 0  # la trajectoire d'entrée est dessinée


def test_backstage_roundtrip():
    from lumitrack.core.project import Project
    p = _bs_project()
    p2 = Project.from_dict(p.to_dict())
    assert p2.backstage_zones == p.backstage_zones
    assert p2.points[0].home_zone_id == p.points[0].home_zone_id
