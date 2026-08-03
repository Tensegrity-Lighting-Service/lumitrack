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


def test_overridden_activation_is_not_overwritten_by_auto_duration():
    """"global vs sélectif" (2026-08-03) : un acteur dont le fade a été
    modifié à la main sort du recalcul automatique tant qu'il reste
    personnalisé — mais compte quand même dans la largeur du bloc."""
    session = Session()
    session.project = _auto_duration_project()
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "move", "pointId": "near",
        "fadeMs": 9000.0, "fadeOverridden": True,
    }))
    reply = _run(_handle_message(session, {
        "type": "update_cue", "cueId": "move", "autoDuration": True,
    }))
    assert reply is None
    move = session.project.cue_by_id("move")
    assert move.activations["near"].fade_ms == pytest.approx(9000.0)  # inchangé
    assert move.activations["far"].fade_ms == pytest.approx(5000.0)  # recalculé normalement
    assert move.duration_ms == pytest.approx(9000.0)  # assez large pour "near"


def test_reverting_override_puts_the_activation_back_under_auto_duration():
    session = Session()
    session.project = _auto_duration_project()
    _run(_handle_message(session, {"type": "update_cue", "cueId": "move", "autoDuration": True}))
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "move", "pointId": "near",
        "fadeMs": 9000.0, "fadeOverridden": True,
    }))
    move = session.project.cue_by_id("move")
    assert move.activations["near"].fade_overridden is True
    assert move.duration_ms == pytest.approx(9000.0)

    # "Revenir au réglage du bloc" : efface la personnalisation, ce qui la
    # remet sous contrôle de la durée automatique déjà active sur ce bloc.
    reply = _run(_handle_message(session, {
        "type": "set_activation", "cueId": "move", "pointId": "near", "fadeOverridden": False,
    }))
    assert reply is None
    move = session.project.cue_by_id("move")
    assert move.activations["near"].fade_overridden is False
    assert move.activations["near"].fade_ms == pytest.approx(1000.0)  # 100cm a 1 m/s
    assert move.duration_ms == pytest.approx(5000.0)  # "far" redevient le plus lent


# ---------------------------------- global vs sélectif, suite (2026-08-03) --
#
# "le timing de l'acteur ne suit pas le timing du bloc ... on dirait qu'ils
# sont par défaut désynchronisés du bloc" (Florian) : hors durée automatique,
# un bloc EST par définition le fade par défaut de ses membres — un nouvel
# acteur doit suivre cette durée dès sa création (pas 1000 ms fixe), et
# redimensionner le bloc doit resynchroniser les acteurs non personnalisés.

def test_new_activation_without_auto_duration_inherits_the_block_duration():
    session = Session()
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=3500.0)]
    reply = _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "targetXCm": 10.0, "targetYCm": 20.0,
    }))
    assert reply is None
    act = session.project.cue_by_id("c1").activations["p1"]
    assert act.fade_ms == pytest.approx(3500.0)  # pas les 1000 ms par défaut du dataclass
    assert act.fade_overridden is False


def test_new_activation_with_auto_duration_still_uses_speed_based_fade():
    """Le fix ci-dessus ne doit pas percuter la durée automatique déjà
    testée ailleurs : un bloc auto reste piloté par la distance/vitesse."""
    session = Session()
    session.project = _auto_duration_project()
    session.project.points.append(Point(id="extra", name="extra"))
    _run(_handle_message(session, {"type": "update_cue", "cueId": "move", "autoDuration": True}))
    reply = _run(_handle_message(session, {
        "type": "set_activation", "cueId": "move", "pointId": "extra",
        "targetXCm": 1000, "targetYCm": 0,
    }))
    assert reply is None
    move = session.project.cue_by_id("move")
    act = move.activations["extra"]
    # "extra" n'a ni zone backstage ni position connue : sa "première
    # apparition" retombe sur sa propre cible (résolution existante de
    # resolve_block_context), donc distance nulle -> le plancher, pas les
    # 1000 ms fixes du dataclass — la preuve que ce cas passe bien par le
    # calcul auto (required_fade_ms_per_point), pas par le fix du point 1.
    assert act.fade_ms == pytest.approx(200.0)
    assert act.fade_overridden is False
    assert move.duration_ms == pytest.approx(5000.0)  # "far" reste le plus lent


def test_resizing_a_block_resyncs_non_overridden_activations():
    session = Session()
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=1000.0, activations={
        "p1": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1000.0),
        "p2": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1000.0, fade_overridden=True),
    })]
    reply = _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1", "durationMs": 4000.0,
    }))
    assert reply is None
    cue = session.project.cue_by_id("c1")
    assert cue.activations["p1"].fade_ms == pytest.approx(4000.0)  # suit le bloc
    assert cue.activations["p2"].fade_ms == pytest.approx(1000.0)  # personnalisé, intouché


def test_resizing_alongside_auto_duration_toggle_does_not_clobber_preset_fades():
    """Le bouton preset envoie durationMs ET autoDuration dans le MÊME
    message, après avoir déjà écrit un fade par acteur — le resynch de
    redimensionnement ne doit pas les remplacer par une seule valeur."""
    session = Session()
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=1000.0, activations={
        "near": Activation(target_x_cm=0, target_y_cm=0, fade_ms=500.0),
        "far": Activation(target_x_cm=0, target_y_cm=0, fade_ms=2500.0),
    })]
    reply = _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1", "durationMs": 2500.0, "autoDuration": False,
    }))
    assert reply is None
    cue = session.project.cue_by_id("c1")
    assert cue.activations["near"].fade_ms == pytest.approx(500.0)  # inchangé
    assert cue.activations["far"].fade_ms == pytest.approx(2500.0)  # inchangé


def test_reverting_override_without_auto_duration_syncs_to_block_duration():
    session = Session()
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=4000.0, activations={
        "p1": Activation(target_x_cm=0, target_y_cm=0, fade_ms=800.0, fade_overridden=True),
    })]
    reply = _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "fadeOverridden": False,
    }))
    assert reply is None
    act = session.project.cue_by_id("c1").activations["p1"]
    assert act.fade_overridden is False
    assert act.fade_ms == pytest.approx(4000.0)


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
