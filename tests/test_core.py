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
                                          fade_ms=1000,
                                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=90)}),
        # Only rotates further; x/y/z keep tracking the previous cue's values.
        Cue(id="c2", name="c2", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(fade_ms=1000, orientation_overridden=True,
                                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=450)}),
    ]
    # z est encore à mi-fondu (fade_ms=1000, on est 200ms après le début de
    # c2) alors que le lacet "fixed" a déjà basculé — z/yaw restent des
    # pistes indépendantes même si le lacet n'est plus jamais animé en
    # douceur (mission "modes d'orientation", 2026-08-04).
    mid = resolve_positions(project, 1200)["a"]
    assert (mid.x_cm, mid.y_cm, mid.z_cm) == pytest.approx((0.0, 0.0, 100.0))
    assert mid.yaw_deg == pytest.approx(450.0)  # multi-turn value, not wrapped


# ---------------------------------------------- lacet "fixed" instantané ---
#
# Mission "modes d'orientation" (2026-08-04, remplace la v1 du 07-31) :
# l'ancien mode "manual" animait le lacet en douceur comme x/y/z, avec une
# fenêtre courte (YAW_TURN_MS) pour simuler un virage rapide. Florian a
# confirmé "non tout devient discret" — le nouveau mode "fixed" en trajet
# n'anime plus DU TOUT : il bascule à sa valeur dès le premier instant de
# la fenêtre de l'activation, aussi près du début qu'on regarde.

def test_travel_fixed_yaw_is_instantaneous_not_animated():
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=0)}),
        # Déplacement long (4s) avec un virage de 90°.
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=4000,
            activations={"a": Activation(target_x_cm=1000, target_y_cm=0, fade_ms=4000,
                                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=90)}),
    ]
    # 1ms après le début du bloc : le lacet est déjà à sa cible, le
    # déplacement x/y vient tout juste de commencer (0.025 % de 1000).
    just_after_start = resolve_positions(project, 1001)["a"]
    assert just_after_start.yaw_deg == pytest.approx(90.0)
    assert just_after_start.x_cm == pytest.approx(0.25)


def test_arrival_hold_freezes_the_travel_value_at_fade_end():
    """"Ne change pas" à l'arrivée (défaut) fige ce que le trajet avait
    résolu PILE à la fin du fondu, pour le mode "fixed" comme pour tous les
    autres — généralise l'ancien comportement, propre à "path" seul avant
    le split trajet/arrivée."""
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(target_x_cm=100, target_y_cm=0, fade_ms=1000,
                                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=90,
                                          arrival_orientation_mode="hold")}),
    ]
    long_after_arrival = resolve_positions(project, 10_000)["a"]
    assert long_after_arrival.yaw_deg == pytest.approx(90.0)


def test_arrival_fixed_is_independent_of_travel_fixed():
    """L'angle "à l'arrivée" en mode Fixe est SON PROPRE angle, indépendant
    de celui du trajet (confirmé par Florian : les deux phases ne
    partagent jamais la même référence)."""
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(target_x_cm=100, target_y_cm=0, fade_ms=1000,
                                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=90,
                                          arrival_orientation_mode="fixed", arrival_fixed_yaw_deg=200)}),
    ]
    during_travel = resolve_positions(project, 1500)["a"]
    after_arrival = resolve_positions(project, 3000)["a"]
    assert during_travel.yaw_deg == pytest.approx(90.0)
    assert after_arrival.yaw_deg == pytest.approx(200.0)


# --------------------------------- décalage de départ, escalier (2026-08-03) --
#
# "le bloc fournit une valeur par défaut ... décalage de départ par acteur,
# pour des effets d'entrée en escalier/vague" (DIRECTIVES.md point 6) :
# Activation.start_offset_ms décale le moment où CETTE activation démarre
# (et gouverne LTP), indépendamment du début nominal du bloc.

def test_zero_offset_is_the_historical_behaviour():
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(target_x_cm=100, target_y_cm=0, fade_ms=1000)}),
    ]
    mid = resolve_positions(project, 1500)["a"]
    assert mid.x_cm == pytest.approx(50.0)


def test_start_offset_delays_when_the_activation_begins_moving():
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(target_x_cm=100, target_y_cm=0, fade_ms=1000,
                                          start_offset_ms=500)}),
    ]
    # Le bloc "commence" à 1000ms mais cet acteur ne bouge pas encore : il
    # tient toujours sa position précédente jusqu'à 1000+500=1500ms.
    still_waiting = resolve_positions(project, 1400)["a"]
    assert still_waiting.x_cm == pytest.approx(0.0)
    mid_move = resolve_positions(project, 2000)["a"]  # 1500 + 1000/2
    assert mid_move.x_cm == pytest.approx(50.0)
    arrived = resolve_positions(project, 2500)["a"]
    assert arrived.x_cm == pytest.approx(100.0)


def test_staggered_offsets_create_a_wave_within_one_block():
    """Deux acteurs du MÊME bloc, décalage différent : effet escalier."""
    project = Project()
    project.points = [Point(id="a", name="A"), Point(id="b", name="B")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0, activations={
            "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0),
            "b": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0),
        }),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000, activations={
            "a": Activation(target_x_cm=100, target_y_cm=0, fade_ms=500, start_offset_ms=0),
            "b": Activation(target_x_cm=100, target_y_cm=0, fade_ms=500, start_offset_ms=500),
        }),
    ]
    # À 1250ms : "a" est à mi-chemin (démarré à 1000, fade 500 -> fini à
    # 1500), "b" n'a pas encore bougé (démarre à 1500).
    poses = resolve_positions(project, 1250)
    assert poses["a"].x_cm == pytest.approx(50.0)
    assert poses["b"].x_cm == pytest.approx(0.0)
    # À 1750ms : "a" est arrivé, "b" est à mi-chemin (démarré à 1500, fini
    # à 2000).
    poses = resolve_positions(project, 1750)
    assert poses["a"].x_cm == pytest.approx(100.0)
    assert poses["b"].x_cm == pytest.approx(50.0)


def test_start_offset_reflected_in_block_context_timing_and_start_pose():
    from lumitrack.core.timeline import resolve_block_context
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(target_x_cm=100, target_y_cm=0, fade_ms=500,
                                          start_offset_ms=300)}),
    ]
    entry = resolve_block_context(project, "c1")["entries"]["a"]
    assert entry["timing"]["startMs"] == pytest.approx(1300.0)
    assert entry["startPose"][0] == pytest.approx(0.0)  # tient encore sa position d'avant
    assert entry["targetPose"][0] == pytest.approx(100.0)


def test_start_offset_roundtrips_and_never_negative():
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=1000, activations={
        "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1000, start_offset_ms=250),
    })]
    back = Project.from_dict(project.to_dict())
    assert back.cues[0].activations["a"].start_offset_ms == pytest.approx(250.0)

    # Une valeur négative reçue (bundle corrompu, ancien format...) est
    # ramenée à 0 plutôt que de faire démarrer un acteur avant son bloc.
    d = project.to_dict()
    d["cues"][0]["activations"]["a"]["startOffsetMs"] = -50.0
    clamped = Project.from_dict(d)
    assert clamped.cues[0].activations["a"].start_offset_ms == 0.0


# ------------------------------------------ modes de rotation (2026-08-04) --
#
# "je veux pouvoir choisir entre 3 mode ... suivre courbe de trajectoire,
# orientation fixe ou focus" (Florian) — remplacé le 2026-08-04 par un
# réglage en DEUX phases indépendantes (voir project.py::Activation) :
# "en trajet" (fixed/path/focus) et "à l'arrivée" (hold/fixed/focus).
# "path" dérive le lacet de la tangente du déplacement x/y ; "focus" pointe
# vers un Point(is_focus_point=True) désigné par id, indépendamment par
# phase.

def test_orientation_mode_path_follows_movement_tangent():
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                                          travel_orientation_mode="path")}),
        # Déplacement en ligne droite le long de +Y : la tangente pointe à 90°.
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=2000,
            activations={"a": Activation(target_x_cm=0, target_y_cm=1000, fade_ms=2000,
                                          travel_orientation_mode="path")}),
    ]
    mid = resolve_positions(project, 2000)["a"]
    assert mid.yaw_deg == pytest.approx(90.0, abs=1.0)


def test_orientation_mode_path_freezes_direction_once_stopped():
    """Une fois le déplacement terminé, "ne change pas" à l'arrivée (défaut)
    garde la dernière direction de marche plutôt que de dégénérer (l'acteur
    est immobile, donc la tangente instantanée serait indéfinie)."""
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                                          travel_orientation_mode="path")}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(target_x_cm=100, target_y_cm=0, fade_ms=1000,
                                          travel_orientation_mode="path")}),
    ]
    long_after_arrival = resolve_positions(project, 10_000)["a"]
    assert long_after_arrival.yaw_deg == pytest.approx(0.0, abs=1.0)


def test_orientation_mode_focus_points_at_fixed_target():
    project = Project()
    project.points = [Point(id="a", name="A"),
                       Point(id="f", name="Focus", is_focus_point=True)]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0, activations={
            "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                             travel_orientation_mode="focus", travel_focus_point_id="f"),
            "f": Activation(target_x_cm=0, target_y_cm=1000, fade_ms=0),
        }),
    ]
    pose = resolve_positions(project, 500)["a"]
    assert pose.yaw_deg == pytest.approx(90.0, abs=1e-6)


def test_orientation_mode_focus_tracks_actor_as_it_moves():
    """Le focus reste fixe dans l'espace : à mesure que l'acteur avance, le
    lacet nécessaire pour continuer à regarder ce point change."""
    project = Project()
    project.points = [Point(id="a", name="A"),
                       Point(id="f", name="Focus", is_focus_point=True)]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0, activations={
            "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                             travel_orientation_mode="focus", travel_focus_point_id="f"),
            "f": Activation(target_x_cm=1000, target_y_cm=0, fade_ms=0),
        }),
        # L'acteur avance vers +Y : le focus (droit devant au départ) se
        # retrouve de plus en plus sur le côté.
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000,
            activations={"a": Activation(target_x_cm=0, target_y_cm=1000, fade_ms=1000,
                                          travel_orientation_mode="focus", travel_focus_point_id="f")}),
    ]
    start = resolve_positions(project, 1000)["a"]
    end = resolve_positions(project, 2000)["a"]
    assert start.yaw_deg == pytest.approx(0.0, abs=1e-6)
    assert end.yaw_deg == pytest.approx(-45.0, abs=1.0)


def test_travel_and_arrival_focus_points_are_independent():
    """Les deux phases ne partagent jamais la même référence de focus —
    confirmé explicitement par Florian ("indépendant par phase")."""
    project = Project()
    project.points = [
        Point(id="a", name="A"),
        Point(id="f1", name="Focus Est", is_focus_point=True),
        Point(id="f2", name="Focus Nord", is_focus_point=True),
    ]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0, activations={
            "f1": Activation(target_x_cm=1000, target_y_cm=0, fade_ms=0),
            "f2": Activation(target_x_cm=0, target_y_cm=1000, fade_ms=0),
        }),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1000, activations={
            "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1000,
                             travel_orientation_mode="focus", travel_focus_point_id="f1",
                             arrival_orientation_mode="focus", arrival_focus_point_id="f2"),
        }),
    ]
    during_travel = resolve_positions(project, 1500)["a"]
    after_arrival = resolve_positions(project, 3000)["a"]
    assert during_travel.yaw_deg == pytest.approx(0.0, abs=1e-6)   # face f1 (est)
    assert after_arrival.yaw_deg == pytest.approx(90.0, abs=1e-6)  # face f2 (nord)


def test_focus_reference_falls_back_to_fixed_angle_when_point_missing():
    """Un point de focus supprimé (id pendant) ne doit jamais planter la
    résolution — repli propre sur l'angle fixe de secours de la phase."""
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                                          travel_orientation_mode="focus",
                                          travel_focus_point_id="does-not-exist",
                                          travel_fixed_yaw_deg=42.0)}),
    ]
    pose = resolve_positions(project, 0)["a"]
    assert pose.yaw_deg == pytest.approx(42.0)


def test_focus_resolution_is_order_independent_across_points():
    """Point B (la cible du focus) est déclaré APRÈS le point A qui le
    vise dans project.points — la restructuration en 2 passes (x/y de TOUS
    les points d'abord, puis le lacet de tous) ne doit pas dépendre de
    l'ordre de la liste."""
    project = Project()
    project.points = [
        Point(id="a", name="A"),
        Point(id="b", name="B", is_focus_point=True),
    ]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0, activations={
            "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                             travel_orientation_mode="focus", travel_focus_point_id="b"),
            "b": Activation(target_x_cm=1000, target_y_cm=0, fade_ms=0),
        }),
    ]
    pose = resolve_positions(project, 0)["a"]
    assert pose.yaw_deg == pytest.approx(0.0, abs=1e-6)


# ------------------------------------------- duree automatique (2026-08-01) --
#
# "Bloc 'duree automatique' ... recalcule la duree par defaut selon
# distance/vitesse" (DIRECTIVES.md) : required_duration_ms est la fonction
# pure derriere Cue.auto_duration, branchee au sidecar (set_activation,
# update_cue, update_project_settings) mais testee ici independamment.

def test_required_duration_matches_distance_over_reference_speed():
    from lumitrack.core.timeline import required_duration_ms
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.reference_speed_cms = 200.0  # 2 m/s
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1,
            activations={"a": Activation(target_x_cm=400, target_y_cm=0, fade_ms=1)}),
    ]
    # 400 cm a 200 cm/s = 2 s pile.
    assert required_duration_ms(project, project.cues[1]) == pytest.approx(2000.0)


def test_required_duration_is_the_slowest_actor_in_the_block():
    from lumitrack.core.timeline import required_duration_ms
    project = Project()
    project.points = [Point(id="near", name="near"), Point(id="far", name="far")]
    project.reference_speed_cms = 100.0
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={
                "near": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0),
                "far": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0),
            }),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=1,
            activations={
                "near": Activation(target_x_cm=100, target_y_cm=0, fade_ms=1),
                "far": Activation(target_x_cm=500, target_y_cm=0, fade_ms=1),
            }),
    ]
    # "far" parcourt 500cm (5s), "near" 100cm (1s) : le bloc suit le plus lent.
    assert required_duration_ms(project, project.cues[1]) == pytest.approx(5000.0)


def test_required_duration_has_a_floor_when_nothing_moves():
    from lumitrack.core.timeline import required_duration_ms, MIN_AUTO_DURATION_MS
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=1,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1)}),
    ]
    assert required_duration_ms(project, project.cues[0]) == pytest.approx(MIN_AUTO_DURATION_MS)


def test_auto_duration_cue_serializes_and_roundtrips(tmp_path):
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [Cue(id="c0", name="c0", start_ms=0, duration_ms=1000,
                         auto_duration=True,
                         activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1)})]
    back = Project.from_dict(project.to_dict())
    assert back.cues[0].auto_duration is True


def test_reference_speed_roundtrips():
    project = Project()
    project.reference_speed_cms = 175.0
    back = Project.from_dict(project.to_dict())
    assert back.reference_speed_cms == pytest.approx(175.0)


# ------------------------------------ overlay de trajectoire (2026-08-01) --
#
# "sélectionner un ou plusieurs acteurs ... affiche leur courbe de
# déplacement en overlay sur la timeline" (Florian) : resolve_trajectories
# rejoue resolve_positions à un échantillonnage régulier — jamais une
# nouvelle logique de résolution.

def test_resolve_trajectories_matches_resolve_positions_at_each_sample():
    from lumitrack.core.timeline import resolve_trajectories
    project = Project()
    project.points = [Point(id="a", name="A")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0,
            activations={"a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0)}),
        Cue(id="c1", name="c1", start_ms=1000, duration_ms=2000,
            activations={"a": Activation(target_x_cm=500, target_y_cm=200, fade_ms=2000)}),
    ]
    result = resolve_trajectories(project, ["a"], samples=8)
    assert len(result["timesMs"]) == 9
    for t, pose in zip(result["timesMs"], result["trajectories"]["a"]):
        expected = resolve_positions(project, t)["a"]
        assert pose == pytest.approx([expected.x_cm, expected.y_cm, expected.z_cm, expected.yaw_deg])


def test_resolve_trajectories_is_none_when_point_has_no_known_position():
    from lumitrack.core.timeline import resolve_trajectories
    project = Project()
    project.points = [Point(id="a", name="A")]  # aucune activation, aucune zone backstage
    result = resolve_trajectories(project, ["a"], samples=4)
    assert all(pose is None for pose in result["trajectories"]["a"])


def test_resolve_trajectories_handles_multiple_points_in_one_call():
    from lumitrack.core.timeline import resolve_trajectories
    project = Project()
    project.points = [Point(id="a", name="A"), Point(id="b", name="B")]
    project.cues = [
        Cue(id="c0", name="c0", start_ms=0, duration_ms=0, activations={
            "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0),
            "b": Activation(target_x_cm=100, target_y_cm=100, fade_ms=0),
        }),
    ]
    result = resolve_trajectories(project, ["a", "b"], samples=2)
    assert set(result["trajectories"].keys()) == {"a", "b"}
    assert result["trajectories"]["b"][0][:2] == pytest.approx([100.0, 100.0])


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


# ------------------------------------------------ hiérarchie du roster ----
# Mission "hiérarchie du roster" (2026-07-31) : sous-groupes purement
# organisationnels — jamais construits avant cette session, contrairement
# aux groupes animables complets du §12.2 (reportés en v1.1). Un acteur
# n'appartient qu'à AU PLUS un sous-groupe.

def test_delete_point_also_removes_its_activations_everywhere():
    """Jamais possible avant cette mission : le roster ne savait qu'ajouter.
    Supprimer un acteur ne doit pas laisser d'activations fantômes dans les
    cues où il était déjà activé."""
    project = _demo_project()
    assert "a" in project.cues[0].activations

    project.delete_point("a")

    assert [p.id for p in project.points] == ["b"]
    assert "a" not in project.cues[0].activations
    assert "a" not in project.cues[1].activations


def test_delete_point_is_a_no_op_for_an_unknown_id():
    project = _demo_project()
    before = [p.id for p in project.points]
    project.delete_point("does-not-exist")
    assert [p.id for p in project.points] == before


def test_reorder_points_matches_the_given_order():
    project = Project()
    project.points = [Point(id="a", name="A"), Point(id="b", name="B"), Point(id="c", name="C")]
    project.reorder_points(["c", "a", "b"])
    assert [p.id for p in project.points] == ["c", "a", "b"]


def test_reorder_points_keeps_omitted_points_at_the_end_in_relative_order():
    """Un glisser-déposer qui ne réordonne qu'UN sous-groupe ne doit pas
    faire disparaître les acteurs des autres groupes — ils restent, dans
    leur ordre relatif d'origine, après ceux explicitement replacés."""
    project = Project()
    project.points = [Point(id="a", name="A"), Point(id="b", name="B"), Point(id="c", name="C")]
    project.reorder_points(["c"])
    assert [p.id for p in project.points] == ["c", "a", "b"]


def test_reorder_points_ignores_unknown_ids():
    project = Project()
    project.points = [Point(id="a", name="A"), Point(id="b", name="B")]
    project.reorder_points(["ghost", "b", "a"])
    assert [p.id for p in project.points] == ["b", "a"]


def test_prune_roster_groups_detaches_points_from_a_deleted_group():
    project = Project()
    project.points = [Point(id="a", name="A", roster_group_id="g1"),
                       Point(id="b", name="B", roster_group_id="g2")]
    project.roster_groups = [{"id": "g1", "name": "Groupe 1"}]  # g2 supprimé
    project.prune_roster_groups()
    assert project.point_by_id("a").roster_group_id == "g1"  # groupe valide, intact
    assert project.point_by_id("b").roster_group_id is None  # groupe disparu, détaché


def test_point_and_roster_groups_roundtrip_through_dict():
    project = Project()
    project.points = [Point(id="a", name="A", roster_group_id="g1")]
    project.roster_groups = [{"id": "g1", "name": "Groupe 1"}]
    back = Project.from_dict(project.to_dict())
    assert back.roster_groups == [{"id": "g1", "name": "Groupe 1"}]
    assert back.point_by_id("a").roster_group_id == "g1"


def test_point_default_travel_orientation_mode_defaults_and_roundtrips():
    """Préremplissage des nouvelles activations (DIRECTIVES.md point 5/6) —
    renommé de default_orientation_mode (mission "modes d'orientation",
    2026-08-04) : c'est maintenant un repli pour la phase TRAJET
    uniquement. Un vieux projet en "manual" (lacet animé, disparu) migre
    vers "fixed", la nouvelle valeur instantanée équivalente."""
    assert Point(id="a", name="A").default_travel_orientation_mode == "fixed"
    project = Project()
    project.points = [Point(id="a", name="A", default_travel_orientation_mode="focus")]
    back = Project.from_dict(project.to_dict())
    assert back.point_by_id("a").default_travel_orientation_mode == "focus"
    assert Point.from_dict({"id": "b", "name": "B"}).default_travel_orientation_mode == "fixed"
    # Ancien format (avant le split trajet/arrivée) : defaultOrientationMode
    # au lieu de defaultTravelOrientationMode.
    legacy_manual = Point.from_dict({"id": "c", "name": "C", "defaultOrientationMode": "manual"})
    assert legacy_manual.default_travel_orientation_mode == "fixed"
    legacy_path = Point.from_dict({"id": "d", "name": "D", "defaultOrientationMode": "path"})
    assert legacy_path.default_travel_orientation_mode == "path"


def _bundled_project(tmp_path, audio_bytes=b"fake-audio-bytes"):
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(audio_bytes)
    project = _demo_project()
    project.name = "Bundled"
    project.audio_path = str(audio)
    return project


def test_save_bundle_creates_its_own_dedicated_folder(tmp_path):
    """Bug réel (2026-07-31) : "Enregistrer sous" ne fait que choisir un
    chemin de fichier — naviguer dans un dossier existant ("Sauvegarde/")
    et taper juste "Demo.lumitrack" mettait media/archive DIRECTEMENT dans
    "Sauvegarde/", partagés avec n'importe quel autre projet qui s'y
    sauvegarderait. Chaque projet doit vivre dans son propre dossier."""
    project = _bundled_project(tmp_path)
    naive_path = str(tmp_path / "Sauvegarde" / "Demo.lumitrack")

    real_path = save_bundle(project, naive_path)

    assert real_path == str(tmp_path / "Sauvegarde" / "Demo" / "Demo.lumitrack")
    assert os.path.isfile(real_path)
    assert not os.path.isfile(naive_path)  # jamais écrit au chemin naïf
    assert (tmp_path / "Sauvegarde" / "Demo" / "media").is_dir()
    assert not (tmp_path / "Sauvegarde" / "media").exists()  # pas mélangé au parent

    back = load_bundle(real_path)
    assert back.name == "Bundled"


def test_save_bundle_does_not_double_nest_when_already_in_own_folder(tmp_path):
    project = _bundled_project(tmp_path)
    already_own = str(tmp_path / "Demo" / "Demo.lumitrack")

    real_path = save_bundle(project, already_own)

    assert real_path == already_own
    assert not (tmp_path / "Demo" / "Demo").exists()


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
    path = save_bundle(p, str(tmp_path / "rt.lumitrack"))
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
    path = save_bundle(p, str(tmp_path / "p.lumitrack"))
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


def test_focus_point_is_excluded_from_backstage_grid():
    """Mission "modes d'orientation" (2026-08-04) : un point de focus n'est
    qu'un repère de visée, pas un acteur réel — jamais placé en coulisse, et
    ne doit pas non plus voler une case à un vrai acteur qui partage la même
    zone."""
    from lumitrack.core.timeline import backstage_slot, BACKSTAGE_SPACING_CM
    p = _bs_project()
    p.points[1].is_focus_point = True

    assert backstage_slot(p, "p1") is None  # jamais de place en coulisse

    # p0 et p2 restent adjacents (p1, exclu, ne creuse pas d'écart entre eux).
    s0 = backstage_slot(p, "p0")
    s2 = backstage_slot(p, "p2")
    assert abs(s2[0] - s0[0]) == BACKSTAGE_SPACING_CM or abs(s2[1] - s0[1]) == BACKSTAGE_SPACING_CM


def test_focus_point_default_and_roundtrip():
    from lumitrack.core.project import Point, Project
    assert Point(id="a", name="A").is_focus_point is False
    p = _bs_project()
    p.points[0].is_focus_point = True
    p2 = Project.from_dict(p.to_dict())
    assert p2.points[0].is_focus_point is True
    assert p2.points[1].is_focus_point is False


# --------------------- migration : anciens projets sans le split (2026-08-04) --
#
# Avant la mission "modes d'orientation", une activation stockait
# orientationMode ("manual"/"path"/"focus") + targetYawDeg + focusXCm/
# focusYCm directement. Project.from_dict détecte ce format via l'absence
# de la clé "travelOrientationMode".

def _legacy_project_dict(activations_by_cue: dict) -> dict:
    """Un dict de projet minimal AU FORMAT D'AVANT LE SPLIT (pas de
    to_dict() actuel, qui n'écrirait plus jamais orientationMode)."""
    return {
        "format": "lumitrack-project", "version": 2, "name": "legacy",
        "points": [{"id": "a", "name": "A"}],
        "cues": [
            {"id": cid, "name": cid, "startMs": 0.0, "durationMs": 1000.0,
             "activations": acts}
            for cid, acts in activations_by_cue.items()
        ],
    }


def test_migration_manual_becomes_instantaneous_fixed():
    from lumitrack.core.project import Project, PROJECT_FORMAT
    d = _legacy_project_dict({
        "c1": {"a": {"targetXCm": 0.0, "targetYCm": 0.0, "targetYawDeg": 30.0, "fadeMs": 0.0}},
    })
    d["format"] = PROJECT_FORMAT
    proj = Project.from_dict(d)
    act = proj.cues[0].activations["a"]
    assert act.travel_orientation_mode == "fixed"
    assert act.travel_fixed_yaw_deg == pytest.approx(30.0)
    assert act.arrival_orientation_mode == "hold"
    assert act.orientation_overridden is True


def test_migration_path_mode_carries_over_directly():
    from lumitrack.core.project import Project, PROJECT_FORMAT
    d = _legacy_project_dict({
        "c1": {"a": {"targetXCm": 0.0, "targetYCm": 0.0, "orientationMode": "path", "fadeMs": 0.0}},
    })
    d["format"] = PROJECT_FORMAT
    proj = Project.from_dict(d)
    act = proj.cues[0].activations["a"]
    assert act.travel_orientation_mode == "path"
    assert act.arrival_orientation_mode == "hold"
    assert act.orientation_overridden is True


def test_migration_focus_synthesizes_a_new_focus_point():
    """Un ancien projet en mode focus fait apparaître un nouveau
    Point(is_focus_point=True) dans le roster au chargement — effet
    visible, signalé, pas une perte de données."""
    from lumitrack.core.project import Project, PROJECT_FORMAT
    d = _legacy_project_dict({
        "c1": {"a": {"targetXCm": 0.0, "targetYCm": 0.0,
                     "orientationMode": "focus", "focusXCm": 500.0, "focusYCm": 500.0,
                     "fadeMs": 0.0}},
    })
    d["format"] = PROJECT_FORMAT
    proj = Project.from_dict(d)
    act = proj.cue_by_id("c1").activations["a"]
    assert act.travel_orientation_mode == "focus"
    assert act.travel_focus_point_id is not None
    focus_point = proj.point_by_id(act.travel_focus_point_id)
    assert focus_point is not None
    assert focus_point.is_focus_point is True
    # Le point synthétisé a une vraie position dès t=0 (règle "première
    # apparition") : résolvable immédiatement, pas seulement référencé.
    from lumitrack.core.timeline import resolve_positions
    pose = resolve_positions(proj, 0.0)[focus_point.id]
    assert (pose.x_cm, pose.y_cm) == pytest.approx((500.0, 500.0))


def test_migration_deduplicates_identical_focus_coordinates():
    """Deux activations visant EXACTEMENT le même point (500,500) doivent
    partager le MÊME point de focus synthétisé, pas en créer deux."""
    from lumitrack.core.project import Project, PROJECT_FORMAT
    d = _legacy_project_dict({
        "c1": {"a": {"targetXCm": 0.0, "targetYCm": 0.0,
                     "orientationMode": "focus", "focusXCm": 500.0, "focusYCm": 500.0,
                     "fadeMs": 0.0}},
    })
    d["points"].append({"id": "b", "name": "B"})
    d["cues"][0]["activations"]["b"] = {
        "targetXCm": 100.0, "targetYCm": 100.0,
        "orientationMode": "focus", "focusXCm": 500.0, "focusYCm": 500.0,
        "fadeMs": 0.0,
    }
    d["format"] = PROJECT_FORMAT
    proj = Project.from_dict(d)
    focus_ids = {act.travel_focus_point_id for act in proj.cue_by_id("c1").activations.values()}
    assert len(focus_ids) == 1
    assert sum(1 for p in proj.points if p.is_focus_point) == 1
