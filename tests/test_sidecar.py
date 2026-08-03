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
from lumitrack.core.project import Project, Point, Cue, Activation


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


def test_save_bundle_reply_reflects_the_auto_created_folder(tmp_path):
    """save_bundle peut rediriger vers un dossier dédié (core/project.py::
    _ensure_own_folder) — le sidecar doit répondre avec le chemin RÉEL, pas
    un écho brut de la demande, sinon le frontend retiendrait un "chemin
    courant" qui n'existe pas."""
    session = Session()
    naive_path = str(tmp_path / "Sauvegarde" / "Demo.lumitrack")
    reply = _run(_handle_message(session, {"type": "save_bundle", "path": naive_path}))
    expected = str(tmp_path / "Sauvegarde" / "Demo" / "Demo.lumitrack")
    assert reply == {"type": "saved", "path": expected}


def test_save_bundle_list_archive_and_load_bundle_wire_protocol(tmp_path):
    """Format de bundle 2026-07-31 (fichier .lumitrack, pas dossier) : la
    commande save_bundle prend le chemin du FICHIER, list_bundle_archive
    répond au seul demandeur (lecture seule), et load_bundle accepte
    archivedName pour restaurer une version précédente."""
    session = Session()
    file_path = str(tmp_path / "Show" / "Show.lumitrack")

    reply = _run(_handle_message(session, {"type": "save_bundle", "path": file_path}))
    assert reply == {"type": "saved", "path": file_path}

    session.project.name = "Renamed"
    reply = _run(_handle_message(session, {"type": "save_bundle", "path": file_path}))
    assert reply == {"type": "saved", "path": file_path}

    reply = _run(_handle_message(session, {"type": "list_bundle_archive", "path": file_path}))
    assert reply["type"] == "bundle_archive"
    assert reply["path"] == file_path
    assert len(reply["entries"]) == 1
    archived_name = reply["entries"][0]["name"]

    # Recharger le fichier courant : reflète le dernier nom sauvegardé.
    reply = _run(_handle_message(session, {"type": "load_bundle", "path": file_path}))
    assert reply is None  # broadcast projet
    assert session.project.name == "Renamed"

    # Recharger une version archivée : reflète l'ancien nom.
    reply = _run(_handle_message(session, {
        "type": "load_bundle", "path": file_path, "archivedName": archived_name,
    }))
    assert reply is None
    assert session.project.name == "Demo"


def test_delete_point_broadcasts_and_removes_the_actor():
    session = Session()
    assert session.project.point_by_id("p1") is not None
    reply = _run(_handle_message(session, {"type": "delete_point", "pointId": "p1"}))
    assert reply is None  # broadcast projet
    assert session.project.point_by_id("p1") is None


def test_reorder_points_broadcasts_and_reorders():
    session = Session()
    ids = [p.id for p in session.project.points]
    reversed_ids = list(reversed(ids))
    reply = _run(_handle_message(session, {"type": "reorder_points", "pointIds": reversed_ids}))
    assert reply is None
    assert [p.id for p in session.project.points] == reversed_ids


# ----------------------------------------- duree automatique (2026-08-03) --
#
# "j'ai change la vitesse des acteurs avec le preset marche ... la boite a
# change de vitesse mais les acteurs n'ont pas change de vitesse" (Florian) :
# la duree automatique et les presets de vitesse ne touchaient QUE
# cue.duration_ms (largeur visuelle du bloc), jamais le fade_ms de chaque
# activation qui gouverne reellement la vitesse de deplacement.

def _auto_duration_project():
    project = Project()
    project.reference_speed_cms = 100.0  # 1 m/s, calcul simple
    project.points = [Point(id="near", name="near"), Point(id="far", name="far")]
    project.cues = [
        Cue(id="setup", name="setup", start_ms=0, duration_ms=1, activations={
            "near": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1),
            "far": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1),
        }),
        Cue(id="move", name="move", start_ms=1000, duration_ms=1, activations={
            # "near" parcourt 100cm (1s a 1 m/s), "far" 500cm (5s).
            "near": Activation(target_x_cm=100, target_y_cm=0, fade_ms=1),
            "far": Activation(target_x_cm=500, target_y_cm=0, fade_ms=1),
        }),
    ]
    return project


def test_auto_duration_checkbox_sets_per_point_fade_not_just_block_width():
    session = Session()
    session.project = _auto_duration_project()
    reply = _run(_handle_message(session, {
        "type": "update_cue", "cueId": "move", "autoDuration": True,
    }))
    assert reply is None
    move = session.project.cue_by_id("move")
    assert move.activations["near"].fade_ms == pytest.approx(1000.0)
    assert move.activations["far"].fade_ms == pytest.approx(5000.0)
    assert move.duration_ms == pytest.approx(5000.0)  # le plus lent


def test_reference_speed_change_resyncs_every_activation_of_auto_blocks():
    session = Session()
    session.project = _auto_duration_project()
    _run(_handle_message(session, {"type": "update_cue", "cueId": "move", "autoDuration": True}))
    reply = _run(_handle_message(session, {
        "type": "update_project_settings", "referenceSpeedCms": 200.0,  # 2 m/s
    }))
    assert reply is None
    move = session.project.cue_by_id("move")
    assert move.activations["near"].fade_ms == pytest.approx(500.0)
    assert move.activations["far"].fade_ms == pytest.approx(2500.0)
    assert move.duration_ms == pytest.approx(2500.0)


def test_set_roster_groups_broadcasts_and_prunes_detached_points():
    session = Session()
    _run(_handle_message(session, {"type": "update_point", "pointId": "p1", "rosterGroupId": "g1"}))
    reply = _run(_handle_message(session, {
        "type": "set_roster_groups", "groups": [{"id": "g1", "name": "Groupe 1"}],
    }))
    assert reply is None
    assert session.project.roster_groups == [{"id": "g1", "name": "Groupe 1"}]
    assert session.project.point_by_id("p1").roster_group_id == "g1"

    # Supprimer le groupe détache l'acteur plutôt que de laisser un id mort.
    _run(_handle_message(session, {"type": "set_roster_groups", "groups": []}))
    assert session.project.point_by_id("p1").roster_group_id is None


def test_add_point_accepts_a_roster_group_id():
    session = Session()
    _run(_handle_message(session, {
        "type": "add_point", "id": "new1", "name": "Nouveau", "rosterGroupId": "g1",
    }))
    assert session.project.point_by_id("new1").roster_group_id == "g1"


def test_set_audio_updates_path_duration_and_transport():
    """Mission timeline+son : `set_audio` porte le chemin et/ou la durée
    décodée par le frontend ; la durée du transport doit suivre
    (Project.duration_ms = max(cues, audio)) et retirer l'audio doit
    ramener la durée aux cues."""
    session = Session()
    cue_end = session.project.total_cue_ms

    reply = _run(_handle_message(session, {"type": "set_audio", "path": "C:/x/show.m4a"}))
    assert reply is None  # commande mutante → broadcast projet
    assert session.project.audio_path == "C:/x/show.m4a"

    _run(_handle_message(session, {"type": "set_audio", "durationS": 120.0}))
    assert session.project.audio_duration_s == pytest.approx(120.0)
    assert session.transport.duration_ms == pytest.approx(120_000.0)

    _run(_handle_message(session, {"type": "set_audio", "path": None}))
    assert session.project.audio_path is None
    assert session.project.audio_duration_s is None
    assert session.transport.duration_ms == pytest.approx(cue_end)
