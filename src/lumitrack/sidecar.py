"""Local WebSocket sidecar exposing core/ to the Tauri/React frontend.

Backend-autoritaire (CONCEPTION.md §12.11/§13.1.7): this process owns the
Transport clock and all interpolation. The frontend never recomputes
positions on its own — it only ever displays what this server pushes, at
`TICK_HZ`. Project-mutating commands get echoed back as a full `project`
snapshot to every connected client rather than diffed, since the model is
small (JSON, no media inline) and this removes an entire class of
front/back drift bugs.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import time
import uuid
from typing import Optional

import websockets

from .core.project import (
    Project, Point, Cue, Activation, import_stancz, save_bundle, load_bundle, list_archive,
)
from .core.timeline import (
    Timeline, OutputTransform, resolve_block_context, required_duration_ms,
    resolve_trajectories,
)
from .core.engine import Transport, PsnBroadcaster

logger = logging.getLogger("lumitrack.sidecar")

TICK_HZ = 30
AUTOSAVE_INTERVAL_S = 2.0

# Undo/redo (§13.1.10 "non négociable", DIRECTIVES.md Mission 3). Historique
# côté sidecar (backend-autoritaire, §12.11) : le frontend ne garde jamais
# lui-même d'états passés, il envoie juste `undo`/`redo`.
#
# Une rafale d'éditions rapprochées (un drag d'acteur/de zone envoie un
# `set_activation`/`update_stage_map` toutes les ~33 ms tout le temps du
# geste, la saisie inspecteur peut committer plusieurs fois de suite) doit
# rester UN SEUL pas d'annulation, pas un par message réseau — sinon
# annuler un simple drag demanderait des dizaines de Ctrl+Z. Un nouveau
# point de reprise n'est ouvert que si la dernière édition remonte à plus de
# UNDO_COALESCE_S : tant que les messages s'enchaînent plus vite que ça
# (un geste continu), ils fusionnent dans l'entrée déjà ouverte.
UNDO_COALESCE_S = 0.7
UNDO_MAX_DEPTH = 200

# Types de commande qui modifient le contenu du projet et doivent donc être
# annulables. Volontairement exclus : transport (lecture, pas édition),
# psn_start/stop et update_psn_config (réglages réseau/sortie, pas contenu
# créatif), resolve_block_context/list_ifaces/psn_preview (lecture seule).
MUTATING_COMMANDS = {
    "set_audio", "update_point", "update_stage_map", "set_backstage_zones",
    "add_point", "add_cue", "update_cue", "delete_cue", "set_activation",
    "apply_group_transform", "delete_point", "reorder_points", "set_roster_groups",
    # Contrairement à update_psn_config (réseau/sortie) : la vitesse de
    # référence recalcule la durée de vrais blocs (contenu créatif).
    "update_project_settings",
}
# Remplacement intégral du projet : l'historique d'un AUTRE projet n'a plus
# de sens une fois chargé un nouveau, donc on le vide plutôt que de le
# rendre annulable (annuler un "Nouveau projet" ramènerait dans l'ancien
# projet sans qu'on l'ait "ouvert" — confusion garantie avec Fichier/Ouvrir).
RESET_UNDO_COMMANDS = {"new_project", "import_stancz", "load_bundle"}


def autosave_path() -> str:
    """Sauvegarde de session : %APPDATA%/Lumitrack/autosave.json (Windows),
    ~/.config/Lumitrack sinon. JSON simple (pas un bundle : les médias
    restent référencés en chemins absolus, pas copiés — et pas de dossier
    versions/ qui gonflerait à chaque autosave)."""
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    directory = os.path.join(base, "Lumitrack")
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, "autosave.json")


def _demo_project() -> Project:
    """A tiny built-in project so the frontend has something to render
    before any file is imported/opened."""
    project = Project(name="Demo", stage_width_cm=6000, stage_height_cm=4000)
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    gltf = os.path.join(repo_root, "Sources", "Belfius_Hockey_Arena.glb")
    if os.path.isfile(gltf):
        project.terrain_gltf_path = gltf

    project.points = [
        Point(id="p1", name="Astera 1", number=1, color="#4F6DF5"),
        Point(id="p2", name="Astera 2", number=2, color="#F5734F"),
        Point(id="p3", name="Astera 3", number=3, color="#4FF58C"),
    ]
    cue_a = Cue(id=str(uuid.uuid4()), name="Entree", start_ms=0, duration_ms=4000, color="#4F6DF5")
    cue_a.activations = {
        "p1": Activation(target_x_cm=1000, target_y_cm=1000, target_yaw_deg=0, fade_ms=4000),
        "p2": Activation(target_x_cm=3000, target_y_cm=1000, target_yaw_deg=90, fade_ms=4000),
        "p3": Activation(target_x_cm=5000, target_y_cm=1000, target_yaw_deg=180, fade_ms=4000),
    }
    cue_b = Cue(id=str(uuid.uuid4()), name="Rassemblement", start_ms=4000, duration_ms=4000, color="#F5734F")
    cue_b.activations = {
        "p1": Activation(target_x_cm=2500, target_y_cm=2500, target_yaw_deg=45, fade_ms=3000),
        "p2": Activation(target_x_cm=3000, target_y_cm=2500, target_yaw_deg=45, fade_ms=3000),
        "p3": Activation(target_x_cm=3500, target_y_cm=2500, target_yaw_deg=45, fade_ms=3000),
    }
    # Overlaps cue_b on purpose: demonstrates that overlapping cues need
    # their own timeline lane rather than sharing one row (§12.1).
    cue_c = Cue(id=str(uuid.uuid4()), name="Contre-jour", start_ms=5000, duration_ms=2000, color="#B06FE0")
    cue_c.activations = {
        "p2": Activation(target_yaw_deg=225, fade_ms=1500),
    }
    project.cues = [cue_a, cue_b, cue_c]
    project.transform_origin_x_cm = project.stage_width_cm / 2
    project.transform_origin_y_cm = project.stage_height_cm / 2
    project.ensure_backstage()
    return project


class Session:
    """The one open project + transport + PSN broadcaster for this sidecar
    process, and the set of connected frontend sockets to push to."""

    def __init__(self):
        # Reprise de session : la dernière autosauvegarde si elle existe,
        # sinon le projet de démonstration.
        self.project = None
        path = autosave_path()
        if os.path.isfile(path):
            try:
                self.project = Project.load(path)
                logger.info("Session restaurée depuis %s", path)
            except Exception:
                logger.exception("Autosave illisible (%s) — projet de démo", path)
        if self.project is None:
            self.project = _demo_project()
        self.dirty = False
        self.timeline = Timeline(self.project)
        self.transport = Transport()
        self.transport.set_duration(self.timeline.duration_ms)
        self.broadcaster = PsnBroadcaster(self.transport)
        self._apply_psn_config()
        self.clients: set = set()
        self._undo_stack: list = []
        self._redo_stack: list = []
        # None, not 0.0: a real time.monotonic() reading could legitimately
        # be small (platform-dependent epoch), which would collide with a
        # 0.0 sentinel and wrongly coalesce the very first edit away.
        self._last_edit_wall: Optional[float] = None

    def _apply_psn_config(self):
        self.broadcaster.transform = OutputTransform.from_project(self.project)
        self.broadcaster.set_project(self.project, self.timeline)
        self.broadcaster.configure(
            mcast_ip=self.project.psn_mcast_ip,
            port=self.project.psn_port,
            system_name=self.project.psn_system_name,
            iface_ip=getattr(self.project, "psn_iface_ip", "0.0.0.0"),
            rate_hz=int(getattr(self.project, "psn_rate_hz", 30)),
        )

    def set_project(self, project: Project):
        self.project = project
        self.dirty = True
        self.timeline = Timeline(project)
        self.transport.set_duration(self.timeline.duration_ms)
        self._apply_psn_config()

    # ---- undo/redo ----

    def checkpoint_undo(self):
        """Call BEFORE applying a mutating command. Opens a new undo entry
        unless the previous edit was less than UNDO_COALESCE_S ago — see
        module docstring for why (gesture coalescing)."""
        now = time.monotonic()
        if self._last_edit_wall is None or now - self._last_edit_wall > UNDO_COALESCE_S:
            self._undo_stack.append(self.project.to_dict())
            if len(self._undo_stack) > UNDO_MAX_DEPTH:
                del self._undo_stack[0]
            self._redo_stack.clear()
        self._last_edit_wall = now

    def reset_undo_history(self):
        self._undo_stack.clear()
        self._redo_stack.clear()
        self._last_edit_wall = None

    def undo(self) -> bool:
        if not self._undo_stack:
            return False
        current = self.project.to_dict()
        previous = self._undo_stack.pop()
        self._redo_stack.append(current)
        self.set_project(Project.from_dict(previous))
        self._last_edit_wall = None  # next edit always opens a fresh entry
        return True

    def redo(self) -> bool:
        if not self._redo_stack:
            return False
        current = self.project.to_dict()
        nxt = self._redo_stack.pop()
        self._undo_stack.append(current)
        self.set_project(Project.from_dict(nxt))
        self._last_edit_wall = None
        return True

    # ---- outbound snapshots ----

    def project_message(self) -> dict:
        return {"type": "project", "project": self.project.to_dict(),
                "psnRunning": self.broadcaster.running,
                "undoAvailable": bool(self._undo_stack),
                "redoAvailable": bool(self._redo_stack)}

    def tick_message(self) -> dict:
        t_ms = self.transport.now_ms()
        poses = self.timeline.positions_at(t_ms)
        return {
            "type": "tick",
            "tMs": t_ms,
            "playing": self.transport.playing,
            "durationMs": self.timeline.duration_ms,
            "positions": {
                pid: [pose.x_cm, pose.y_cm, pose.z_cm, pose.yaw_deg]
                for pid, pose in poses.items()
            },
        }

    async def broadcast(self, message: dict):
        if not self.clients:
            return
        payload = json.dumps(message)
        stale = []
        for ws in list(self.clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.append(ws)
        for ws in stale:
            self.clients.discard(ws)


async def _tick_loop(session: Session):
    period = 1.0 / TICK_HZ
    while True:
        await session.broadcast(session.tick_message())
        await asyncio.sleep(period)


async def _autosave_loop(session: Session):
    """Sauvegarde continue : écrit l'autosave ~2 s après la dernière
    mutation. La fermeture de l'app TUE le sidecar (kill, aucun handler ne
    tourne sous Windows) — c'est donc cette boucle qui garantit le
    « sauvegardé au quit » : au moment du kill, tout est déjà sur disque.
    Écriture ATOMIQUE (tmp + replace) : un kill en plein write ne peut pas
    corrompre le fichier."""
    path = autosave_path()
    while True:
        await asyncio.sleep(AUTOSAVE_INTERVAL_S)
        if not session.dirty:
            continue
        session.dirty = False
        try:
            tmp = path + ".tmp"
            session.project.save(tmp)
            os.replace(tmp, path)
        except Exception:
            session.dirty = True  # on retentera au prochain tour
            logger.exception("Échec de l'autosauvegarde")


async def _handle_message(session: Session, msg: dict) -> Optional[dict]:
    """Apply one client command. Returns a reply message (error/ack) to send
    only to the requester, or None — in which case the caller broadcasts a
    fresh project snapshot to every connected client."""
    msg_type = msg.get("type")

    if msg_type in MUTATING_COMMANDS:
        session.checkpoint_undo()
    elif msg_type in RESET_UNDO_COMMANDS:
        session.reset_undo_history()

    if msg_type == "undo":
        if not session.undo():
            return {"type": "ack"}  # rien à annuler : no-op silencieux
        return None

    if msg_type == "redo":
        if not session.redo():
            return {"type": "ack"}
        return None

    if msg_type == "transport":
        # Never falls through to a project broadcast: `seek` fires on every
        # pointer-move of a cursor drag, and none of play/pause/seek touch
        # project data (points/cues/activations) — the tick loop already
        # pushes the new playhead position on its own. Broadcasting the full
        # project here too turned a mouse drag into a request storm that
        # tripped React's "Maximum update depth exceeded" guard in practice
        # (observed 2026-07-28).
        action = msg.get("action")
        if action == "play":
            session.transport.play()
        elif action == "pause":
            session.transport.pause()
        elif action == "seek":
            session.transport.seek(float(msg.get("tMs", 0.0)))
        else:
            return {"type": "error", "message": f"Unknown transport action {action!r}"}
        return {"type": "ack"}

    if msg_type == "resolve_block_context":
        # Read-only: replies to the requester, never broadcasts. The
        # frontend re-requests after every project snapshot while a block
        # is selected, so the context follows edits without the sidecar
        # having to track which client is editing which cue.
        try:
            context = resolve_block_context(session.project, msg.get("cueId", ""))
        except ValueError as exc:
            return {"type": "error", "message": str(exc)}
        return {"type": "block_context", **context}

    if msg_type == "resolve_trajectories":
        # Read-only, même principe que resolve_block_context : le frontend
        # re-demande à chaque nouvelle sélection ET à chaque nouveau
        # snapshot projet (overlay de trajectoire, mission "refonte
        # AE/Reaper" — remplace la ligne d'automation x/y/z retirée du bloc).
        result = resolve_trajectories(session.project, msg.get("pointIds", []))
        return {"type": "trajectories", **result}

    if msg_type == "set_audio":
        # Piste audio du projet (mission timeline+son). `path` charge/retire
        # le fichier ; `durationS` arrive du frontend une fois le fichier
        # decode (WebAudio/wavesurfer) — le backend n'embarque aucun codec,
        # mais c'est lui qui integre la duree au transport
        # (Project.duration_ms = max(cues, audio), deja en place).
        project = session.project
        if "path" in msg:
            project.audio_path = msg["path"] or None
            if project.audio_path is None:
                project.audio_duration_s = None
        if "durationS" in msg:
            d = msg["durationS"]
            project.audio_duration_s = float(d) if d else None
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "update_psn_config":
        # Panneau Réglages PSN : tout est projet (voyage avec le bundle).
        proj = session.project
        mapping = {
            "mcastIp": ("psn_mcast_ip", str), "port": ("psn_port", int),
            "systemName": ("psn_system_name", str),
            "ifaceIp": ("psn_iface_ip", str), "rateHz": ("psn_rate_hz", int),
            "originXCm": ("transform_origin_x_cm", float),
            "originYCm": ("transform_origin_y_cm", float),
            "invertX": ("transform_invert_x", bool),
            "invertY": ("transform_invert_y", bool),
            "swapXy": ("transform_swap_xy", bool),
            "upAxis": ("transform_up_axis", str),
        }
        for key, (attr, cast) in mapping.items():
            if key in msg and msg[key] is not None:
                setattr(proj, attr, cast(msg[key]))
        session._apply_psn_config()
        return None

    if msg_type == "update_project_settings":
        # Réglages projet transverses (mission "refonte AE/Reaper") : pour
        # l'instant seule la vitesse de référence, qui pilote la durée des
        # blocs en "durée automatique" — sa mise à jour doit recalculer TOUS
        # les blocs concernés (elle change leur distance-par-seconde à tous),
        # contrairement à set_activation qui ne touche que le bloc édité.
        if "referenceSpeedCms" in msg and msg["referenceSpeedCms"] is not None:
            session.project.reference_speed_cms = max(1.0, float(msg["referenceSpeedCms"]))
            for cue in session.project.cues:
                if cue.auto_duration:
                    cue.duration_ms = required_duration_ms(session.project, cue)
            session.timeline.rebuild()
            session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "list_ifaces":
        # Adresses IPv4 locales candidates pour IP_MULTICAST_IF.
        import socket as _socket
        addrs = {"0.0.0.0"}
        try:
            for info in _socket.getaddrinfo(_socket.gethostname(), None,
                                            family=_socket.AF_INET):
                addrs.add(info[4][0])
        except OSError:
            pass
        try:
            # Route par défaut : révèle l'IP de l'interface active même
            # quand gethostname ne résout pas toutes les cartes.
            probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
            probe.connect(("8.8.8.8", 80))
            addrs.add(probe.getsockname()[0])
            probe.close()
        except OSError:
            pass
        return {"type": "ifaces", "addresses": sorted(addrs)}

    if msg_type == "psn_preview":
        # Moniteur : EXACTEMENT ce que le broadcaster émettrait maintenant
        # (même build_trackers, même transform, même convention d'axes).
        trackers = session.broadcaster.build_trackers(session.transport.now_ms())
        return {
            "type": "psn_preview",
            "running": session.broadcaster.running,
            "packetsSent": session.broadcaster.packets_sent,
            "dest": f"{session.project.psn_mcast_ip}:{session.project.psn_port}",
            "ifaceIp": getattr(session.project, "psn_iface_ip", "0.0.0.0"),
            "rateHz": int(getattr(session.project, "psn_rate_hz", 30)),
            "upAxis": getattr(session.project, "transform_up_axis", "y"),
            "lastError": session.broadcaster.last_error,
            "trackers": [
                {"id": t.id, "name": t.name,
                 "posX": t.x_m, "posY": t.y_m, "posZ": t.z_m,
                 "oriX": t.ori_x, "oriY": t.ori_y, "oriZ": t.ori_z}
                for t in trackers
            ],
        }

    if msg_type == "update_point":
        point = session.project.point_by_id(msg.get("pointId", ""))
        if point is None:
            return {"type": "error", "message": "Unknown point id"}
        if "name" in msg:
            point.name = msg["name"]
        if "number" in msg:
            point.number = msg["number"]
        if "color" in msg:
            point.color = msg["color"]
        if "psnTrackerId" in msg:
            point.psn_tracker_id = msg["psnTrackerId"]
        if "homeZoneId" in msg:
            point.home_zone_id = msg["homeZoneId"]
        if "rosterGroupId" in msg:
            point.roster_group_id = msg["rosterGroupId"]
        if "defaultHeightCm" in msg and msg["defaultHeightCm"] is not None:
            point.default_height_cm = float(msg["defaultHeightCm"])
        return None

    if msg_type == "delete_point":
        session.project.delete_point(msg.get("pointId", ""))
        session.timeline.rebuild()
        return None

    if msg_type == "reorder_points":
        session.project.reorder_points(msg.get("pointIds", []))
        return None

    if msg_type == "set_roster_groups":
        # Liste complète des sous-groupes en un seul message (création/
        # renommage/suppression) — même principe que set_backstage_zones :
        # simple, sans dérive possible entre deux appels partiels.
        session.project.roster_groups = list(msg.get("groups") or [])
        session.project.prune_roster_groups()
        return None

    if msg_type == "psn_start":
        if not session.broadcaster.start():
            return {"type": "error", "message": session.broadcaster.last_error or "PSN start failed"}
        return None

    if msg_type == "psn_stop":
        session.broadcaster.stop()
        return None

    if msg_type == "update_stage_map":
        # Where the stage rectangle sits inside the terrain glTF's own world
        # space (position/rotation), plus the rectangle's own size — driven
        # by the drag handles on the "zone de jeu" overlay in the 3D view.
        project = session.project
        if "originXM" in msg:
            project.stage_map_origin_x_m = float(msg["originXM"])
        if "originZM" in msg:
            project.stage_map_origin_z_m = float(msg["originZM"])
        if "rotationDeg" in msg:
            project.stage_map_rotation_deg = float(msg["rotationDeg"])
        if "widthCm" in msg:
            project.stage_width_cm = max(1.0, float(msg["widthCm"]))
        if "heightCm" in msg:
            project.stage_height_cm = max(1.0, float(msg["heightCm"]))
        if "gridSizeCm" in msg:
            project.grid_size_cm = max(1.0, float(msg["gridSizeCm"]))
        if "terrainRotationDeg" in msg and msg["terrainRotationDeg"] is not None:
            project.terrain_rotation_deg = float(msg["terrainRotationDeg"])
        # The stage-map placement now feeds straight into PSN output
        # (OutputTransform.to_metres, CONCEPTION.md §4) — the live
        # broadcaster's transform must be rebuilt immediately, not just on
        # the next unrelated project reload, or a zone drag would keep
        # broadcasting from the pre-drag placement.
        session._apply_psn_config()
        return None

    if msg_type == "set_backstage_zones":
        # Liste complète des zones (création/édition/suppression en un seul
        # message — le panneau envoie l'état entier, simple et sans dérive).
        zones = []
        for z in msg.get("zones") or []:
            if not z.get("id"):
                continue
            zones.append({
                "id": str(z["id"]), "name": str(z.get("name") or "Backstage"),
                "xCm": float(z.get("xCm", 0.0)), "yCm": float(z.get("yCm", 0.0)),
                "widthCm": max(60.0, float(z.get("widthCm", 400.0))),
                "heightCm": max(60.0, float(z.get("heightCm", 400.0))),
            })
        session.project.backstage_zones = zones
        session.project.ensure_backstage()
        return None

    if msg_type == "add_point":
        pid = msg.get("id") or str(uuid.uuid4())
        session.project.points.append(Point(
            id=pid, name=msg.get("name", "Point"), number=msg.get("number"),
            color=msg.get("color", "#4F6DF5"),
            roster_group_id=msg.get("rosterGroupId"),
        ))
        # Attache backstage immédiate : le nouvel acteur apparaît dans sa
        # zone au lieu d'être invisible (mission backstage).
        session.project.ensure_backstage()
        return None

    if msg_type == "add_cue":
        cue = Cue(
            id=msg.get("id") or str(uuid.uuid4()),
            name=msg.get("name", "Cue"),
            start_ms=float(msg.get("startMs", session.project.next_start_ms())),
            duration_ms=float(msg.get("durationMs", 1000.0)),
            color=msg.get("color", "#4F6DF5"),
            lane=max(0, int(msg.get("lane", 0))),
        )
        session.project.cues.append(cue)
        session.project.sort_cues()
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "update_cue":
        cue = session.project.cue_by_id(msg.get("cueId", ""))
        if cue is None:
            return {"type": "error", "message": "Unknown cue id"}
        if "name" in msg:
            cue.name = msg["name"]
        if "startMs" in msg:
            cue.start_ms = float(msg["startMs"])
        if "durationMs" in msg:
            cue.duration_ms = float(msg["durationMs"])
        if "color" in msg:
            cue.color = msg["color"]
        if "lane" in msg:
            cue.lane = max(0, int(msg["lane"]))
        if "autoDuration" in msg:
            cue.auto_duration = bool(msg["autoDuration"])
            # Activer la case recalcule tout de suite (sinon la durée reste
            # celle réglée à la main jusqu'à la prochaine activation touchée
            # — trompeur, la case semblerait ne rien faire).
            if cue.auto_duration:
                cue.duration_ms = required_duration_ms(session.project, cue)
        session.project.sort_cues()
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "delete_cue":
        cue_id = msg.get("cueId")
        session.project.cues = [c for c in session.project.cues if c.id != cue_id]
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "set_activation":
        cue = session.project.cue_by_id(msg.get("cueId", ""))
        if cue is None:
            return {"type": "error", "message": "Unknown cue id"}
        point_id = msg.get("pointId")
        if session.project.point_by_id(point_id) is None:
            return {"type": "error", "message": f"Unknown point id {point_id!r}"}
        act = cue.activations.get(point_id) or Activation()
        for field_name, json_key in (
            ("target_x_cm", "targetXCm"), ("target_y_cm", "targetYCm"),
            ("target_z_cm", "targetZCm"), ("target_yaw_deg", "targetYawDeg"),
        ):
            if json_key in msg:
                setattr(act, field_name, msg[json_key])
        if "fadeMs" in msg:
            act.fade_ms = float(msg["fadeMs"])
        if "easing" in msg:
            act.easing = msg["easing"]
        if "orientationMode" in msg:
            act.orientation_mode = msg["orientationMode"] or "manual"
        if "focusXCm" in msg:
            act.focus_x_cm = msg["focusXCm"]
        if "focusYCm" in msg:
            act.focus_y_cm = msg["focusYCm"]
        # Tracé spatial (motion path) : listes/dicts écrits tels quels,
        # null efface (retour à la ligne droite).
        if "pathPoints" in msg:
            act.path_points = msg["pathPoints"] or None
        if "startHandle" in msg:
            act.start_handle = msg["startHandle"]
        if "targetHandle" in msg:
            act.target_handle = msg["targetHandle"]
        if "curves" in msg:
            # Dict {axe: [nœuds]} du graph editor, ou None pour tout effacer.
            # Un axe portant [] ou None est retiré (retour à l'easing nommé).
            curves = msg["curves"]
            if curves is None:
                act.curves = None
            else:
                merged = dict(act.curves or {})
                for axis, nodes in curves.items():
                    if nodes:
                        merged[axis] = nodes
                    else:
                        merged.pop(axis, None)
                act.curves = merged or None
        cue.activations[point_id] = act
        # Durée automatique (mission "refonte AE/Reaper") : seul ce bloc peut
        # avoir changé de distance à parcourir, jamais ses voisins — recalcul
        # ciblé, pas un balayage de tout le projet à chaque frappe.
        if cue.auto_duration:
            cue.duration_ms = required_duration_ms(session.project, cue)
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "apply_group_transform":
        cue = session.project.cue_by_id(msg.get("cueId", ""))
        if cue is None:
            return {"type": "error", "message": "Unknown cue id"}
        session.project.apply_group_transform(
            cue, msg.get("pointIds", []),
            pivot=tuple(msg.get("pivot", (0.0, 0.0))),
            translate=tuple(msg.get("translate", (0.0, 0.0))),
            rotate_deg=float(msg.get("rotateDeg", 0.0)),
            fade_ms=float(msg.get("fadeMs", 1000.0)),
            easing=msg.get("easing", "linear"),
        )
        return None

    if msg_type == "import_stancz":
        project = import_stancz(msg["path"])
        project.ensure_backstage()
        session.set_project(project)
        return None

    if msg_type == "new_project":
        project = Project(name=msg.get("name", "Untitled"))
        project.ensure_backstage()
        session.set_project(project)
        return None

    if msg_type == "save_bundle":
        # msg["path"] est le chemin complet du FICHIER .lumitrack (format
        # 2026-07-31 : le fichier porte l'extension, pas le dossier —
        # l'ancien contenu à ce chemin, s'il existe, est archivé avant
        # d'être écrasé, voir core/project.py::save_bundle). save_bundle
        # peut CORRIGER le chemin (dossier dédié inséré si besoin) : on
        # renvoie le chemin RÉEL, pas l'écho brut de la demande, sinon le
        # frontend retiendrait un "chemin courant" qui n'existe pas.
        real_path = save_bundle(session.project, msg["path"])
        return {"type": "saved", "path": real_path}

    if msg_type == "list_bundle_archive":
        # Lecture seule pour le panneau "Historique des versions" : répond
        # au seul demandeur, jamais de broadcast (même principe que
        # resolve_block_context).
        return {"type": "bundle_archive", "path": msg["path"],
                "entries": list_archive(msg["path"])}

    if msg_type == "load_bundle":
        session.set_project(load_bundle(msg["path"], msg.get("archivedName")))
        return None

    return {"type": "error", "message": f"Unknown message type {msg_type!r}"}


async def _client_handler(session: Session, websocket):
    session.clients.add(websocket)
    try:
        await websocket.send(json.dumps(session.project_message()))
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                reply = await _handle_message(session, msg)
            except Exception as exc:  # noqa: BLE001 - report to client, keep serving
                logger.exception("Error handling message")
                reply = {"type": "error", "message": str(exc)}
            if reply is not None:
                await websocket.send(json.dumps(reply))
            else:
                # Toute commande qui aboutit à un broadcast de projet est une
                # mutation : elle arme l'autosauvegarde débouncée.
                session.dirty = True
                await session.broadcast(session.project_message())
    finally:
        session.clients.discard(websocket)


async def _run(host: str, port: int):
    session = Session()
    asyncio.create_task(_tick_loop(session))
    asyncio.create_task(_autosave_loop(session))
    async with websockets.serve(lambda ws: _client_handler(session, ws), host, port):
        logger.info("Lumitrack sidecar listening on ws://%s:%s", host, port)
        await asyncio.Future()  # run forever


def main() -> int:
    parser = argparse.ArgumentParser(description="Lumitrack Python sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17845)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(_run(args.host, args.port))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
