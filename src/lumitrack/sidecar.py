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
import uuid
from typing import Optional

import websockets

from .core.project import (
    Project, Point, Cue, Activation, import_stancz, save_bundle, load_bundle,
)
from .core.timeline import Timeline, OutputTransform, resolve_block_context
from .core.engine import Transport, PsnBroadcaster

logger = logging.getLogger("lumitrack.sidecar")

TICK_HZ = 30


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
    return project


class Session:
    """The one open project + transport + PSN broadcaster for this sidecar
    process, and the set of connected frontend sockets to push to."""

    def __init__(self):
        self.project = _demo_project()
        self.timeline = Timeline(self.project)
        self.transport = Transport()
        self.transport.set_duration(self.timeline.duration_ms)
        self.broadcaster = PsnBroadcaster(self.transport)
        self._apply_psn_config()
        self.clients: set = set()

    def _apply_psn_config(self):
        self.broadcaster.transform = OutputTransform.from_project(self.project)
        self.broadcaster.set_project(self.project, self.timeline)
        self.broadcaster.configure(
            mcast_ip=self.project.psn_mcast_ip,
            port=self.project.psn_port,
            system_name=self.project.psn_system_name,
        )

    def set_project(self, project: Project):
        self.project = project
        self.timeline = Timeline(project)
        self.transport.set_duration(self.timeline.duration_ms)
        self._apply_psn_config()

    # ---- outbound snapshots ----

    def project_message(self) -> dict:
        return {"type": "project", "project": self.project.to_dict(),
                "psnRunning": self.broadcaster.running}

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


async def _handle_message(session: Session, msg: dict) -> Optional[dict]:
    """Apply one client command. Returns a reply message (error/ack) to send
    only to the requester, or None — in which case the caller broadcasts a
    fresh project snapshot to every connected client."""
    msg_type = msg.get("type")

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
        return None

    if msg_type == "add_point":
        pid = msg.get("id") or str(uuid.uuid4())
        session.project.points.append(Point(
            id=pid, name=msg.get("name", "Point"), number=msg.get("number"),
            color=msg.get("color", "#4F6DF5"),
        ))
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
        session.set_project(import_stancz(msg["path"]))
        return None

    if msg_type == "new_project":
        session.set_project(Project(name=msg.get("name", "Untitled")))
        return None

    if msg_type == "save_bundle":
        save_bundle(session.project, msg["path"])
        return {"type": "saved", "path": msg["path"]}

    if msg_type == "load_bundle":
        session.set_project(load_bundle(msg["path"], msg.get("version")))
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
                await session.broadcast(session.project_message())
    finally:
        session.clients.discard(websocket)


async def _run(host: str, port: int):
    session = Session()
    asyncio.create_task(_tick_loop(session))
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
