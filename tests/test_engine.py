"""Presets de montage de fixture (mission "modes d'orientation", phase D,
2026-08-04) : core/engine.py::apply_mount_preset et son câblage dans
PsnBroadcaster.build_trackers — dérive tangage/roulis du lacet déjà résolu,
au moment de l'émission PSN uniquement, jamais une nouvelle timeline
d'animation."""
import math

import pytest

from lumitrack.core.project import Project, Point, Cue, Activation
from lumitrack.core.timeline import Timeline, OutputTransform
from lumitrack.core.engine import PsnBroadcaster, Transport, apply_mount_preset


def test_apply_mount_preset_none_is_a_no_op():
    assert apply_mount_preset(None, 45.0) == (0.0, 0.0)


def test_apply_mount_preset_base_angles_without_tracking():
    preset = {"basePitchDeg": 90.0, "baseRollDeg": 10.0,
              "pitchTracksYaw": False, "rollTracksYaw": False}
    assert apply_mount_preset(preset, 123.0) == (90.0, 10.0)


def test_apply_mount_preset_tracks_yaw_independently_per_axis():
    preset = {"basePitchDeg": 90.0, "baseRollDeg": 0.0,
              "pitchTracksYaw": False, "rollTracksYaw": True}
    pitch, roll = apply_mount_preset(preset, 30.0)
    assert pitch == 90.0
    assert roll == 30.0


def _project_with_mounted_point(up_axis="y", roll_tracks_yaw=False):
    project = Project(name="t", transform_up_axis=up_axis)
    project.points = [Point(id="a", name="A")]
    project.fixture_mount_presets = [{
        "id": "vert", "name": "Vertical",
        "basePitchDeg": 90.0, "baseRollDeg": 0.0,
        "pitchTracksYaw": False, "rollTracksYaw": roll_tracks_yaw,
    }]
    # Recadrage 2026-08-04 : le preset se règle au niveau de l'acteur DANS
    # LE BLOC (Activation.mount_preset_id), plus par acteur globalement.
    project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=0, activations={
        "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                        travel_orientation_mode="fixed", travel_fixed_yaw_deg=45.0,
                        mount_preset_id="vert"),
    })]
    return project


def _broadcaster_for(project):
    timeline = Timeline(project)
    broadcaster = PsnBroadcaster(Transport())
    broadcaster.transform = OutputTransform.from_project(project)
    broadcaster.set_project(project, timeline)
    return broadcaster


def test_build_trackers_applies_mount_preset_pitch_to_ori_x():
    broadcaster = _broadcaster_for(_project_with_mounted_point())
    trackers = broadcaster.build_trackers(0.0)
    assert len(trackers) == 1
    t = trackers[0]
    assert t.ori_x == math.radians(90.0)
    assert t.ori_y == math.radians(45.0)  # up_axis="y" par défaut : lacet en ori_y
    assert t.ori_z == 0.0  # roulis nul ici, sur l'axe vertical restant


def test_build_trackers_puts_roll_on_the_axis_yaw_does_not_use():
    broadcaster = _broadcaster_for(_project_with_mounted_point(up_axis="z", roll_tracks_yaw=True))
    trackers = broadcaster.build_trackers(0.0)
    t = trackers[0]
    assert t.ori_x == math.radians(90.0)
    assert t.ori_z == math.radians(45.0)  # up_axis="z" : le lacet occupe ori_z
    assert t.ori_y == math.radians(45.0)  # le roulis suit le lacet, sur ori_y (axe restant)


def test_build_trackers_adds_preset_height_before_output_transform():
    """"Hauteur du tracker" du preset (demande 2026-08-06) : offset Z en cm
    scène, appliqué AVANT la transformation de sortie — un tube tenu à bout
    de bras n'émet pas au sol. Preset sans le champ (d'avant l'ajout) = 0."""
    project = _project_with_mounted_point()
    broadcaster = _broadcaster_for(project)
    base_y_m = broadcaster.build_trackers(0.0)[0].y_m  # hauteur par défaut de l'acteur

    project.fixture_mount_presets[0]["zOffsetCm"] = 150.0
    assert broadcaster.build_trackers(0.0)[0].y_m == base_y_m + 1.5  # up_axis="y" : Z scène -> Y PSN

    del project.fixture_mount_presets[0]["zOffsetCm"]
    assert broadcaster.build_trackers(0.0)[0].y_m == base_y_m


def test_build_trackers_no_preset_is_unaffected():
    project = _project_with_mounted_point()
    project.cues[0].activations["a"].mount_preset_id = None
    broadcaster = _broadcaster_for(project)
    trackers = broadcaster.build_trackers(0.0)
    assert trackers[0].ori_x == 0.0


def test_mount_preset_is_governed_by_blocks_ltp():
    """"Ne rien changer" (None) laisse courir le preset gouvernant
    précédent ; un bloc ultérieur peut en changer ou l'effacer ("")."""
    import math
    from lumitrack.core.engine import governing_mount_preset
    project = _project_with_mounted_point()
    project.fixture_mount_presets.append({
        "id": "flat", "name": "Posé au sol",
        "basePitchDeg": 45.0, "baseRollDeg": 0.0,
        "pitchTracksYaw": False, "rollTracksYaw": False,
    })
    project.cues.append(Cue(id="c2", name="c2", start_ms=1000, duration_ms=0, activations={
        # None = ne rien changer : "vert" (posé par c1) continue de gouverner.
        "a": Activation(target_x_cm=100, target_y_cm=0, fade_ms=0),
    }))
    project.cues.append(Cue(id="c3", name="c3", start_ms=2000, duration_ms=0, activations={
        "a": Activation(target_x_cm=200, target_y_cm=0, fade_ms=0, mount_preset_id="flat"),
    }))
    project.cues.append(Cue(id="c4", name="c4", start_ms=3000, duration_ms=0, activations={
        # "" = aucun preset : efface explicitement la correction.
        "a": Activation(target_x_cm=300, target_y_cm=0, fade_ms=0, mount_preset_id=""),
    }))
    assert governing_mount_preset(project, "a", 500.0)["id"] == "vert"
    assert governing_mount_preset(project, "a", 1500.0)["id"] == "vert"   # c2 ne change rien
    assert governing_mount_preset(project, "a", 2500.0)["id"] == "flat"   # c3 bascule
    assert governing_mount_preset(project, "a", 3500.0) is None           # c4 efface

    broadcaster = _broadcaster_for(project)
    assert broadcaster.build_trackers(2500.0)[0].ori_x == math.radians(45.0)
    assert broadcaster.build_trackers(3500.0)[0].ori_x == 0.0


def test_timecode_loss_freezes_then_allows_manual_and_resumes():
    """Chase TC (fix 2026-08-06) : perte de signal = lecture figee NET et
    transport manuel rendu ; retour du signal = reprise automatique du
    pilotage par-dessus toute lecture manuelle en cours."""
    import time as _time
    t = Transport()
    t.set_duration(60000)
    t.external_sync = True
    t.apply_external(5000.0, 25.0)
    # approx : now_ms extrapole a l'horloge murale depuis le paquet
    # (fix "gros delai" 2026-08-07) — quelques micro-ms ici.
    assert t.now_ms() == pytest.approx(5000.0, abs=20.0)
    assert t.playing is True

    t._last_external_wall = _time.monotonic() - 2.0   # signal tombe
    assert t.now_ms() == 5000.0                       # fige la ou il etait
    assert t.playing is False

    t.play()                                          # manuel autorise
    _time.sleep(0.05)
    assert t.now_ms() > 5000.0

    t.apply_external(8000.0, 25.0)                    # le TC revient
    assert t.now_ms() == pytest.approx(8000.0, abs=20.0)
    assert t.playing is True


def test_preset_yaw_offset_adds_to_plan_yaw():
    """Offset rY du preset (2026-08-06) : degres AJOUTES au lacet resolu du
    plan — un tube monte a l envers se corrige au preset, trajectoires
    intactes."""
    project = _project_with_mounted_point()   # lacet fixe a 45 deg
    project.fixture_mount_presets[0]["yawOffsetDeg"] = 90.0
    broadcaster = _broadcaster_for(project)
    t = broadcaster.build_trackers(0.0)[0]
    assert t.ori_y == math.radians(45.0 + 90.0)   # up_axis="y" : lacet en ori_y


def test_global_ori_offsets_add_to_emitted_axes():
    """Offsets d orientation GLOBAUX (2026-08-06) : fin de la chaine
    additive, ajoutes aux axes ori tels qu emis (= ce que le moniteur
    affiche)."""
    project = _project_with_mounted_point()   # pitch preset 90, lacet 45
    project.output_ori_x_deg = 10.0
    project.output_ori_y_deg = 20.0
    project.output_ori_z_deg = 30.0
    broadcaster = _broadcaster_for(project)
    t = broadcaster.build_trackers(0.0)[0]
    assert abs(t.ori_x - math.radians(90.0 + 10.0)) < 1e-9
    assert abs(t.ori_y - math.radians(45.0 + 20.0)) < 1e-9
    assert abs(t.ori_z - math.radians(0.0 + 30.0)) < 1e-9


# ---- Timing par waypoint (tFrac, 2026-08-07) -----------------------------
# Un waypoint peut imposer SA fraction temporelle de passage ; sans tFrac,
# repartition par longueur d'arc (comportement historique intact).

def test_path_position_without_tfrac_is_arc_length():
    from lumitrack.core.timeline import path_position
    act = Activation(target_x_cm=1000, target_y_cm=0, fade_ms=1000,
                     path_points=[{"xCm": 500.0, "yCm": 0.0, "inDxCm": None,
                                   "inDyCm": None, "outDxCm": None, "outDyCm": None}])
    # Trajet rectiligne 0->1000 avec waypoint au milieu : a p=0.5 on est
    # pile au waypoint (arc uniforme), a p=0.25 au quart.
    x, y = path_position((0.0, 0.0), act, (1000.0, 0.0), 0.5)
    assert x == pytest.approx(500.0, abs=2.0)
    x, _ = path_position((0.0, 0.0), act, (1000.0, 0.0), 0.25)
    assert x == pytest.approx(250.0, abs=2.0)


def test_path_position_tfrac_retimes_waypoint_passage():
    from lumitrack.core.timeline import path_position
    act = Activation(target_x_cm=1000, target_y_cm=0, fade_ms=1000,
                     path_points=[{"xCm": 500.0, "yCm": 0.0, "tFrac": 0.25,
                                   "inDxCm": None, "inDyCm": None,
                                   "outDxCm": None, "outDyCm": None}])
    # tFrac=0.25 : l'acteur atteint le milieu SPATIAL au quart du temps...
    x, _ = path_position((0.0, 0.0), act, (1000.0, 0.0), 0.25)
    assert x == pytest.approx(500.0, abs=2.0)
    # ...puis parcourt la seconde moitie sur les 3/4 restants (a p=0.625,
    # mi-chemin de ce second troncon : 750 cm).
    x, _ = path_position((0.0, 0.0), act, (1000.0, 0.0), 0.625)
    assert x == pytest.approx(750.0, abs=2.0)
    # Extremites intactes.
    x, _ = path_position((0.0, 0.0), act, (1000.0, 0.0), 1.0)
    assert x == pytest.approx(1000.0, abs=0.5)


def test_external_timecode_extrapolates_between_packets(monkeypatch):
    """Fix "gros delai" (2026-08-07) : entre deux paquets TC (un par frame),
    le transport avance a l'horloge murale au lieu de figer en escalier ;
    borne a +100 ms pour ne pas deriver si le flux tombe."""
    import lumitrack.core.engine as eng
    base = [100.0]
    monkeypatch.setattr(eng.time, "monotonic", lambda: base[0])
    t = eng.Transport()
    t.external_sync = True
    t.apply_external(1000.0, 30.0)
    assert t.now_ms() == pytest.approx(1000.0)
    base[0] += 0.040  # 40 ms apres le paquet : extrapole
    assert t.now_ms() == pytest.approx(1040.0)
    base[0] += 0.030
    assert t.now_ms() == pytest.approx(1070.0)
    base[0] += 2.0  # flux tombe (> timeout 1 s) : gel net au dernier paquet
    assert t.now_ms() == pytest.approx(1000.0)
    assert t.playing is False
