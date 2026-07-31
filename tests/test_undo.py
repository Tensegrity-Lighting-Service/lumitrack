"""Undo/redo (CONCEPTION.md §13.1.10 "non négociable", DIRECTIVES.md
Mission 3, resté absent depuis le début du MVP).

Backend-autoritaire (§12.11) : le sidecar seul garde les états passés, le
frontend se contente d'envoyer `undo`/`redo`. Couverture : une édition fait
un aller-retour exact, une rafale d'éditions rapprochées (drag d'acteur,
saisie inspecteur) fusionne en UN SEUL pas d'annulation — sinon défaire un
simple drag demanderait des dizaines de Ctrl+Z —, une vraie pause rouvre un
nouveau pas, refaire est invalidé par une nouvelle édition après une
annulation, et remplacer le projet entier (nouveau/import/bundle) vide
l'historique plutôt que de le rendre annulable.
"""
import asyncio

import pytest

from lumitrack.sidecar import Session, _handle_message

# _isolated_autosave (autouse) vit maintenant dans tests/conftest.py — les
# autres fichiers construisant Session() (test_block_context.py,
# test_sidecar.py) en avaient besoin tout autant.


def _run(coro):
    return asyncio.run(coro)


def _send(session, msg):
    return _run(_handle_message(session, msg))


def _set_clock(monkeypatch, t):
    monkeypatch.setattr("lumitrack.sidecar.time.monotonic", lambda: t)


def test_undo_restores_previous_project_state(monkeypatch):
    session = Session()
    _set_clock(monkeypatch, 0.0)
    before = session.project.to_dict()
    cue_id = session.project.cues[0].id

    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 999.0})
    assert session.project.to_dict() != before

    reply = _send(session, {"type": "undo"})
    assert reply is None  # broadcast d'un projet frais, comme toute édition
    assert session.project.to_dict() == before


def test_redo_reapplies_the_undone_edit(monkeypatch):
    session = Session()
    _set_clock(monkeypatch, 0.0)
    cue_id = session.project.cues[0].id
    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 999.0})
    edited = session.project.to_dict()

    _send(session, {"type": "undo"})
    reply = _send(session, {"type": "redo"})
    assert reply is None
    assert session.project.to_dict() == edited


def test_rapid_edits_within_coalesce_window_collapse_into_one_undo_step(monkeypatch):
    """Simule un drag : plusieurs set_activation à quelques dizaines de ms
    d'écart, comme le throttle ~33 ms réellement utilisé par les gestes de
    pointeur du frontend. Une seule annulation doit revenir avant le
    PREMIER message du geste, pas juste défaire le dernier."""
    session = Session()
    cue_id = session.project.cues[0].id
    _set_clock(monkeypatch, 0.0)
    before = session.project.to_dict()

    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 100.0})
    _set_clock(monkeypatch, 0.03)
    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 200.0})
    _set_clock(monkeypatch, 0.06)
    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 300.0})

    _send(session, {"type": "undo"})
    assert session.project.to_dict() == before


def test_edits_separated_by_a_real_pause_are_separate_undo_steps(monkeypatch):
    session = Session()
    cue_id = session.project.cues[0].id
    _set_clock(monkeypatch, 0.0)
    before = session.project.to_dict()

    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 100.0})
    after_first = session.project.to_dict()
    _set_clock(monkeypatch, 5.0)  # bien au-delà d'UNDO_COALESCE_S (0.7s)
    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 200.0})

    _send(session, {"type": "undo"})
    assert session.project.to_dict() == after_first
    _send(session, {"type": "undo"})
    assert session.project.to_dict() == before


def test_undo_with_empty_history_is_a_silent_ack_not_error():
    session = Session()
    reply = _send(session, {"type": "undo"})
    assert reply == {"type": "ack"}


def test_redo_with_empty_history_is_a_silent_ack_not_error():
    session = Session()
    reply = _send(session, {"type": "redo"})
    assert reply == {"type": "ack"}


def test_new_edit_after_undo_clears_the_redo_stack(monkeypatch):
    session = Session()
    cue_id = session.project.cues[0].id
    _set_clock(monkeypatch, 0.0)
    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 100.0})
    _send(session, {"type": "undo"})

    _set_clock(monkeypatch, 5.0)
    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 777.0})
    reply = _send(session, {"type": "redo"})
    assert reply == {"type": "ack"}  # la branche a changé, plus rien à refaire


@pytest.mark.parametrize("reset_msg", [
    {"type": "new_project", "name": "Autre"},
    {"type": "load_bundle", "path": "__does_not_exist__"},
])
def test_project_replacement_clears_undo_history(monkeypatch, reset_msg):
    session = Session()
    cue_id = session.project.cues[0].id
    _set_clock(monkeypatch, 0.0)
    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 100.0})

    # load_bundle sur un chemin inexistant lève — on vérifie juste que
    # l'historique a bien été vidé AVANT la tentative, pas le succès du
    # rechargement lui-même (déjà couvert ailleurs).
    try:
        _send(session, reset_msg)
    except Exception:
        pass
    assert session._undo_stack == []
    assert session._redo_stack == []


def test_project_message_reports_undo_redo_availability(monkeypatch):
    session = Session()
    msg = session.project_message()
    assert msg["undoAvailable"] is False
    assert msg["redoAvailable"] is False

    cue_id = session.project.cues[0].id
    _set_clock(monkeypatch, 0.0)
    _send(session, {"type": "set_activation", "cueId": cue_id, "pointId": "p1", "targetXCm": 100.0})
    msg = session.project_message()
    assert msg["undoAvailable"] is True
    assert msg["redoAvailable"] is False

    _send(session, {"type": "undo"})
    msg = session.project_message()
    assert msg["undoAvailable"] is False
    assert msg["redoAvailable"] is True


def test_readonly_and_transport_commands_never_open_an_undo_entry():
    session = Session()
    cue_id = session.project.cues[0].id
    _send(session, {"type": "transport", "action": "seek", "tMs": 500.0})
    _send(session, {"type": "resolve_block_context", "cueId": cue_id})
    assert session._undo_stack == []


def test_update_psn_config_and_psn_start_stop_are_not_undoable(monkeypatch):
    """Réglages réseau/sortie, pas contenu créatif — hors du périmètre de
    l'historique (choix documenté dans sidecar.py)."""
    session = Session()
    _set_clock(monkeypatch, 0.0)
    _send(session, {"type": "update_psn_config", "originXCm": 42.0})
    assert session._undo_stack == []
