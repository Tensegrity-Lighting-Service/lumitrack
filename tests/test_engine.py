"""Presets de montage de fixture (mission "modes d'orientation", phase D,
2026-08-04) : core/engine.py::apply_mount_preset et son câblage dans
PsnBroadcaster.build_trackers — dérive tangage/roulis du lacet déjà résolu,
au moment de l'émission PSN uniquement, jamais une nouvelle timeline
d'animation."""
import math

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
    project.points = [Point(id="a", name="A", mount_preset_id="vert")]
    project.fixture_mount_presets = [{
        "id": "vert", "name": "Vertical",
        "basePitchDeg": 90.0, "baseRollDeg": 0.0,
        "pitchTracksYaw": False, "rollTracksYaw": roll_tracks_yaw,
    }]
    project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=0, activations={
        "a": Activation(target_x_cm=0, target_y_cm=0, fade_ms=0,
                        travel_orientation_mode="fixed", travel_fixed_yaw_deg=45.0),
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


def test_build_trackers_no_preset_is_unaffected():
    project = _project_with_mounted_point()
    project.points[0].mount_preset_id = None
    broadcaster = _broadcaster_for(project)
    trackers = broadcaster.build_trackers(0.0)
    assert trackers[0].ori_x == 0.0
