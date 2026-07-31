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
