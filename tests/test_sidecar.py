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


def test_set_timecode_chase_arms_transport_and_persists():
    """Timecode In (2026-08-06) : armer le suivi passe le transport en
    external_sync et persiste le reglage dans le projet ; desarmer fige la
    lecture. Le recepteur reseau est simule (pas de bind reel en test)."""
    session = Session()
    session.timecode_input.start = lambda: True   # pas de socket en CI
    session.timecode_input.stop = lambda: None
    started = {"v": True}
    type(session.timecode_input).running = property(lambda self: started["v"])

    reply = _run(_handle_message(session, {"type": "set_timecode_chase", "enabled": True}))
    assert reply is None
    assert session.transport.external_sync is True
    assert session.project.timecode_chase_enabled is True
    assert session.project.to_dict()["timecodeChaseEnabled"] is True

    # Un paquet TC recu fait avancer le transport, offset projet soustrait.
    # approx : now_ms extrapole a l'horloge murale depuis le paquet (fix
    # "gros delai" 2026-08-07) — quelques micro-ms ici.
    session.project.timecode_offset_ms = 1000.0
    session._on_external_timecode(5000.0, 25.0)
    assert session.transport.now_ms() == pytest.approx(4000.0, abs=20.0)
    assert session.transport.playing is True

    reply = _run(_handle_message(session, {"type": "set_timecode_chase", "enabled": False}))
    assert reply is None
    assert session.transport.external_sync is False
    assert session.transport.playing is False   # fige la ou le TC s'est arrete
    del type(session.timecode_input).running


def test_set_activations_preview_skips_broadcast_and_auto_duration():
    """Mode APERCU (2026-08-07, 'ca rame toujours' a 78 acteurs) : un
    echantillon preview:true applique les cibles + rebuild (le tick porte
    le retour visuel) mais repond un ack (pas de rediffusion projet) et
    saute la passe auto-duration ; l'ecriture finale non-preview paie tout
    une seule fois."""
    session = Session()
    cue = session.project.cues[0]
    cue.auto_duration = True
    dur_before = cue.duration_ms
    reply = _run(_handle_message(session, {
        "type": "set_activations", "cueId": cue.id, "preview": True,
        "entries": [{"pointId": "p1", "targetXCm": 4000.0, "targetYCm": 2000.0}],
    }))
    assert reply == {"type": "ack"}          # reply non-None = pas de broadcast
    assert cue.activations["p1"].target_x_cm == 4000.0
    assert cue.duration_ms == dur_before     # auto-duration sautee en preview

    reply = _run(_handle_message(session, {
        "type": "set_activations", "cueId": cue.id,
        "entries": [{"pointId": "p1", "targetXCm": 4000.0, "targetYCm": 2000.0}],
    }))
    assert reply is None                     # ecriture finale = broadcast
    assert cue.duration_ms != dur_before     # auto-duration reappliquee


def test_blocks_never_overlap_on_a_lane():
    """Invariant tranche H (2026-08-07) : jamais deux blocs superposes sur
    une meme piste, quel que soit le chemin — add_cue, update_cue
    (deplacement/etirement/changement de piste), duree auto. Politique :
    le bloc MODIFIE est reloge sur la premiere piste libre, jamais les
    autres (pas d'effet domino)."""
    session = Session()
    session.project.cues = []
    _run(_handle_message(session, {"type": "add_cue", "name": "A",
                                   "startMs": 0, "durationMs": 4000, "id": "a", "lane": 0}))
    # Creation chevauchante -> relogee piste 1, A intact.
    _run(_handle_message(session, {"type": "add_cue", "name": "B",
                                   "startMs": 2000, "durationMs": 4000, "id": "b", "lane": 0}))
    a = session.project.cue_by_id("a"); b = session.project.cue_by_id("b")
    assert (a.lane, a.start_ms) == (0, 0)
    assert b.lane == 1

    # Deplacement de B hors conflit -> il peut revenir piste 0.
    _run(_handle_message(session, {"type": "update_cue", "cueId": "b",
                                   "startMs": 5000, "lane": 0}))
    assert session.project.cue_by_id("b").lane == 0

    # Etirement de A jusque dans B -> A (le modifie) est reloge, B intact.
    _run(_handle_message(session, {"type": "update_cue", "cueId": "a",
                                   "durationMs": 6000}))
    a = session.project.cue_by_id("a"); b = session.project.cue_by_id("b")
    assert (b.lane, b.start_ms) == (0, 5000)
    assert a.lane == 1


def test_overlapping_save_is_sanitized_on_load():
    """Une sauvegarde d'AVANT l'invariant (blocs superposes) est assainie
    au chargement, dans l'ordre chronologique."""
    session = Session()
    d = session.project.to_dict()
    d["cues"] = [
        {"id": "x", "name": "X", "color": "#111111", "startMs": 0,
         "durationMs": 3000, "lane": 0, "autoDuration": False, "activations": {}},
        {"id": "y", "name": "Y", "color": "#222222", "startMs": 1000,
         "durationMs": 3000, "lane": 0, "autoDuration": False, "activations": {}},
        {"id": "z", "name": "Z", "color": "#333333", "startMs": 2000,
         "durationMs": 3000, "lane": 0, "autoDuration": False, "activations": {}},
    ]
    session.set_project(Project.from_dict(d))
    lanes = {c.id: c.lane for c in session.project.cues}
    assert lanes == {"x": 0, "y": 1, "z": 2}


def test_save_bundle_reply_echoes_the_exact_path(tmp_path):
    """Format zip 2026-08-06 : plus de dossier dedie auto-cree, le fichier
    est ecrit exactement au chemin demande et la reponse le reflete."""
    session = Session()
    file_path = str(tmp_path / "Sauvegarde" / "Demo.lumitrack")
    reply = _run(_handle_message(session, {"type": "save_bundle", "path": file_path}))
    assert reply == {"type": "saved", "path": file_path}
    import zipfile
    assert zipfile.is_zipfile(file_path)


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


def test_start_offset_ms_is_actually_wired_into_set_activation():
    """Régression : le champ startOffsetMs a été ajouté cote UI (App.tsx,
    types.ts) sans jamais brancher sa lecture cote set_activation - ce
    test aurait attrape le bug avant qu'il n'atteigne Florian."""
    session = Session()
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=1000.0, activations={
        "p1": Activation(target_x_cm=0, target_y_cm=0, fade_ms=500.0),
    })]
    reply = _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "startOffsetMs": 300.0,
    }))
    assert reply is None
    assert session.project.cue_by_id("c1").activations["p1"].start_offset_ms == pytest.approx(300.0)


def test_resizing_a_block_accounts_for_start_offset_when_resyncing():
    """Synchroniser sur la durée du bloc doit faire TERMINER l'acteur pile
    à la fin du bloc, décalage déduit — pas lui donner tout le bloc en
    plus de son décalage (il déborderait)."""
    session = Session()
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=1000.0, activations={
        "p1": Activation(target_x_cm=0, target_y_cm=0, fade_ms=1000.0, start_offset_ms=300.0),
    })]
    reply = _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1", "durationMs": 4000.0,
    }))
    assert reply is None
    assert session.project.cue_by_id("c1").activations["p1"].fade_ms == pytest.approx(3700.0)


def test_auto_duration_accounts_for_start_offset_finish_time():
    """Un acteur décalé qui a besoin de 1000 ms pour sa distance termine à
    (offset + fade), pas à fade seul — le bloc doit être assez large pour
    ça, sinon le bloc suivant démarrerait avant qu'il ait fini."""
    session = Session()
    session.project = _auto_duration_project()
    cue = session.project.cue_by_id("move")
    cue.activations["near"].start_offset_ms = 2000.0  # "near" ferait 1000ms tout seul
    reply = _run(_handle_message(session, {"type": "update_cue", "cueId": "move", "autoDuration": True}))
    assert reply is None
    cue = session.project.cue_by_id("move")
    assert cue.activations["near"].fade_ms == pytest.approx(1000.0)  # inchangé, propre à sa distance
    # "near" termine à 2000+1000=3000, "far" (sans décalage) à 5000 :
    # "far" reste le plus lent au final malgré le décalage de "near".
    assert cue.duration_ms == pytest.approx(5000.0)


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


def test_set_fixture_mount_presets_broadcasts_and_prunes_detached_activations():
    session = Session()
    session.project.points = [Point(id="p1", name="P1")]
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=2000.0)]
    reply = _run(_handle_message(session, {
        "type": "set_fixture_mount_presets",
        "presets": [{"id": "vert", "name": "Vertical", "basePitchDeg": 90.0, "baseRollDeg": 0.0,
                     "pitchTracksYaw": False, "rollTracksYaw": False}],
    }))
    assert reply is None
    assert session.project.fixture_mount_presets[0]["id"] == "vert"
    # Le preset s'assigne au niveau de l'acteur DANS LE BLOC (recadrage
    # 2026-08-04), via set_activation.
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1",
        "targetXCm": 0.0, "mountPresetId": "vert",
    }))
    assert session.project.cue_by_id("c1").activations["p1"].mount_preset_id == "vert"

    # Supprimer le preset détache l'activation plutôt que de laisser un id mort.
    _run(_handle_message(session, {"type": "set_fixture_mount_presets", "presets": []}))
    assert session.project.cue_by_id("c1").activations["p1"].mount_preset_id is None


def test_add_point_accepts_a_roster_group_id():
    session = Session()
    _run(_handle_message(session, {
        "type": "add_point", "id": "new1", "name": "Nouveau", "rosterGroupId": "g1",
    }))
    assert session.project.point_by_id("new1").roster_group_id == "g1"


def test_add_point_and_update_point_accept_is_focus_point():
    session = Session()
    _run(_handle_message(session, {
        "type": "add_point", "id": "focus1", "name": "Focus A", "isFocusPoint": True,
    }))
    assert session.project.point_by_id("focus1").is_focus_point is True

    _run(_handle_message(session, {"type": "add_point", "id": "actor1", "name": "Acteur"}))
    assert session.project.point_by_id("actor1").is_focus_point is False

    _run(_handle_message(session, {
        "type": "update_point", "pointId": "actor1", "isFocusPoint": True,
    }))
    assert session.project.point_by_id("actor1").is_focus_point is True


def test_default_travel_orientation_mode_prefills_new_activation_only():
    """Préremplissage (DIRECTIVES.md point 5/6, renommé de
    default_orientation_mode le 2026-08-04) : préremplit une activation
    TOUTE NEUVE, n'a plus aucun effet une fois l'activation créée — même
    si le défaut change ensuite."""
    session = Session()
    session.project.points = [Point(id="p1", name="P1")]
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=2000.0, activations={})]

    _run(_handle_message(session, {
        "type": "update_point", "pointId": "p1", "defaultTravelOrientationMode": "focus",
    }))
    assert session.project.point_by_id("p1").default_travel_orientation_mode == "focus"

    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "targetXCm": 10.0,
    }))
    assert session.project.cue_by_id("c1").activations["p1"].travel_orientation_mode == "focus"

    _run(_handle_message(session, {
        "type": "update_point", "pointId": "p1", "defaultTravelOrientationMode": "fixed",
    }))
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "targetXCm": 20.0,
    }))
    assert session.project.cue_by_id("c1").activations["p1"].travel_orientation_mode == "focus"


def test_set_activation_explicit_orientation_mode_wins_over_point_default():
    session = Session()
    session.project.points = [Point(id="p1", name="P1", default_travel_orientation_mode="focus")]
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=2000.0, activations={})]
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1",
        "targetXCm": 10.0, "travelOrientationMode": "path",
    }))
    assert session.project.cue_by_id("c1").activations["p1"].travel_orientation_mode == "path"


# ------------------ réglage par défaut du BLOC, orientation (2026-08-04) --
#
# Même principe à 2 niveaux que le timing (point 6) : Cue.default_travel_*/
# default_arrival_* préremplit toute NOUVELLE activation du bloc et
# resynchronise (mission "global vs sélectif") toute activation existante
# non personnalisée dès que le défaut du bloc change.

def test_cue_orientation_default_prefills_new_activation():
    session = Session()
    session.project.points = [Point(id="p1", name="P1")]
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=2000.0)]
    _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1",
        "defaultTravelOrientationMode": "fixed", "defaultTravelFixedYawDeg": 45.0,
        "defaultArrivalOrientationMode": "fixed", "defaultArrivalFixedYawDeg": 200.0,
    }))
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "targetXCm": 10.0,
    }))
    act = session.project.cue_by_id("c1").activations["p1"]
    assert act.travel_orientation_mode == "fixed"
    assert act.travel_fixed_yaw_deg == pytest.approx(45.0)
    assert act.arrival_orientation_mode == "fixed"
    assert act.arrival_fixed_yaw_deg == pytest.approx(200.0)
    assert act.orientation_overridden is False


def test_cue_orientation_default_change_resyncs_non_overridden_activations():
    session = Session()
    session.project.points = [Point(id="p1", name="P1"), Point(id="p2", name="P2")]
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=2000.0)]
    _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1", "defaultTravelOrientationMode": "fixed",
        "defaultTravelFixedYawDeg": 10.0,
    }))
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "targetXCm": 0.0,
    }))
    # p2 est personnalisé à la main (le champ d'orientation de l'inspecteur
    # envoie toujours orientationOverridden:true avec sa valeur, comme le
    # champ de fade le fait déjà pour fadeOverridden) : ne doit jamais
    # suivre le défaut du bloc.
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p2", "targetXCm": 0.0,
        "travelOrientationMode": "path", "orientationOverridden": True,
    }))
    _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1", "defaultTravelFixedYawDeg": 99.0,
    }))
    cue = session.project.cue_by_id("c1")
    assert cue.activations["p1"].travel_fixed_yaw_deg == pytest.approx(99.0)
    assert cue.activations["p2"].travel_orientation_mode == "path"


def test_set_activations_batch_applies_all_entries_in_one_message():
    """Écriture groupée (optimisation 2026-08-06) : un geste multi-acteurs
    passe par UN message au lieu de N — mêmes effets de bord que la version
    unitaire (préremplissage, fade du bloc, durée automatique) une seule
    fois pour tout le lot."""
    session = Session()
    session.project.points = [Point(id=f"p{i}", name=f"P{i}") for i in range(3)]
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=3000.0)]
    reply = _run(_handle_message(session, {
        "type": "set_activations", "cueId": "c1", "entries": [
            {"pointId": "p0", "targetXCm": 100.0, "targetYCm": 0.0},
            {"pointId": "p1", "targetXCm": 200.0, "targetYCm": 0.0},
            {"pointId": "p2", "targetXCm": 300.0, "targetYCm": 0.0},
        ],
    }))
    assert reply is None
    cue = session.project.cue_by_id("c1")
    assert len(cue.activations) == 3
    assert cue.activations["p1"].target_x_cm == 200.0
    # Même préremplissage que la version unitaire : fade = durée du bloc.
    assert cue.activations["p2"].fade_ms == pytest.approx(3000.0)

    # Un point inconnu -> erreur, comme la version unitaire.
    err = _run(_handle_message(session, {
        "type": "set_activations", "cueId": "c1", "entries": [{"pointId": "nope", "targetXCm": 1.0}],
    }))
    assert err is not None and err["type"] == "error"


def test_new_cue_defaults_to_path_travel_and_hold_arrival():
    """Un bloc NEUF (2026-08-05) part avec trajet="suivre la trajectoire"
    et arrivée="ne change pas" — et ses nouvelles activations en héritent."""
    session = Session()
    session.project.points = [Point(id="p1", name="P1")]
    _run(_handle_message(session, {
        "type": "add_cue", "id": "c1", "name": "Bloc", "startMs": 0.0, "durationMs": 2000.0,
    }))
    cue = session.project.cue_by_id("c1")
    assert cue.default_travel_orientation_mode == "path"
    assert cue.default_arrival_orientation_mode == "hold"
    # Fade orientation par défaut 0,5 s (2026-08-06).
    assert cue.default_yaw_turn_ms == 500.0
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "targetXCm": 10.0,
    }))
    act = cue.activations["p1"]
    assert act.travel_orientation_mode == "path"
    assert act.arrival_orientation_mode == "hold"
    assert act.yaw_turn_ms == 500.0


def test_cue_default_mount_preset_and_yaw_turn_sync():
    """Preset orientation + temps de rotation au niveau BLOC (2026-08-05) :
    même resynchronisation que trajet/arrivée ; "" remet les
    non-personnalisés à "ne rien changer" (None)."""
    session = Session()
    session.project.points = [Point(id="p1", name="P1")]
    session.project.fixture_mount_presets = [{"id": "vert", "name": "Vertical"}]
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=2000.0)]
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "targetXCm": 0.0,
    }))
    _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1",
        "defaultMountPresetId": "vert", "defaultYawTurnMs": 400.0,
    }))
    act = session.project.cue_by_id("c1").activations["p1"]
    assert act.mount_preset_id == "vert"
    assert act.yaw_turn_ms == 400.0
    # "" = défaut explicite "ne rien changer" -> resynchronise à None.
    _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1", "defaultMountPresetId": "",
    }))
    assert session.project.cue_by_id("c1").activations["p1"].mount_preset_id is None


def test_reverting_orientation_override_resyncs_to_cue_default():
    session = Session()
    session.project.points = [Point(id="p1", name="P1")]
    session.project.cues = [Cue(id="c1", name="c1", start_ms=0, duration_ms=2000.0)]
    _run(_handle_message(session, {
        "type": "update_cue", "cueId": "c1", "defaultTravelOrientationMode": "fixed",
        "defaultTravelFixedYawDeg": 10.0,
    }))
    _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "targetXCm": 0.0,
        "travelOrientationMode": "path", "orientationOverridden": True,
    }))
    assert session.project.cue_by_id("c1").activations["p1"].orientation_overridden is True

    # "Revenir au bloc" : orientationOverridden:false seul resynchronise
    # depuis les défauts ACTUELS du bloc.
    reply = _run(_handle_message(session, {
        "type": "set_activation", "cueId": "c1", "pointId": "p1", "orientationOverridden": False,
    }))
    assert reply is None
    act = session.project.cue_by_id("c1").activations["p1"]
    assert act.orientation_overridden is False
    assert act.travel_orientation_mode == "fixed"
    assert act.travel_fixed_yaw_deg == pytest.approx(10.0)


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


# ---- Fichier de secours anti-crash (2026-08-07) --------------------------
# Contrat : ecrit en continu pendant l'usage, EFFACE a toute sortie propre
# (clean_exit, sauvegarde ou non) ; present au demarrage = crash -> le
# frontend est notifie (rescue_available) et choisit load/discard.

def test_clean_exit_removes_rescue_and_freezes_writes(tmp_path):
    import os
    from lumitrack.sidecar import rescue_path
    session = Session()
    path = rescue_path()
    session.project.save(path)
    assert os.path.isfile(path)
    reply = _run(_handle_message(session, {"type": "clean_exit"}))
    assert reply == {"type": "ack"}
    assert not os.path.isfile(path)
    assert session.exiting is True


def test_rescue_detected_then_loaded():
    import os
    from lumitrack.sidecar import rescue_path
    seed = Session()
    seed.project.name = "CrashShow"
    seed.project.save(rescue_path())

    session = Session()  # nouveau demarrage : fichier present = crash
    assert session.rescue_available is True
    assert session.project.name != "CrashShow"  # PAS charge silencieusement

    reply = _run(_handle_message(session, {"type": "load_rescue"}))
    assert reply is None  # mutation -> broadcast projet
    assert session.project.name == "CrashShow"
    assert session.rescue_available is False
    assert os.path.isfile(rescue_path())  # garde le filet jusqu'a la sortie propre


def test_rescue_discarded_deletes_file():
    import os
    from lumitrack.sidecar import rescue_path
    seed = Session()
    seed.project.save(rescue_path())

    session = Session()
    assert session.rescue_available is True
    reply = _run(_handle_message(session, {"type": "discard_rescue"}))
    assert reply == {"type": "ack"}
    assert session.rescue_available is False
    assert not os.path.isfile(rescue_path())


def test_legacy_autosave_migrates_to_rescue():
    import os
    from lumitrack.sidecar import rescue_path
    seed = Session()
    seed.project.name = "AncienneSession"
    legacy = os.path.join(os.path.dirname(rescue_path()), "autosave.json")
    seed.project.save(legacy)
    os.remove(rescue_path()) if os.path.isfile(rescue_path()) else None

    session = Session()
    assert not os.path.isfile(legacy)
    assert session.rescue_available is True
    _run(_handle_message(session, {"type": "load_rescue"}))
    assert session.project.name == "AncienneSession"
