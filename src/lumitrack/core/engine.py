"""Playback transport + PSN broadcast thread.

The send loop uses an **absolute** next-tick clock rather than a fixed sleep,
so the output rate doesn't drift as load increases. With ~100 trackers at
30-60 Hz this matters.
"""
from __future__ import annotations

import math
import threading
import time
from typing import Optional

from .project import Project
from .timeline import Timeline, OutputTransform
from .psn import PsnSender, Tracker


class Transport:
    """Owns the current project time. Either free-running (internal clock) or
    slaved to incoming timecode."""

    def __init__(self):
        self._lock = threading.RLock()
        self._playing = False
        self._t_ms = 0.0
        self._started_wall = 0.0
        self._started_t = 0.0
        self._duration_ms = 0.0
        self.external_sync = False
        self.last_external_fps: Optional[float] = None
        self._last_external_wall = 0.0

    def set_duration(self, duration_ms: float):
        with self._lock:
            self._duration_ms = max(0.0, duration_ms)

    @property
    def duration_ms(self) -> float:
        return self._duration_ms

    @property
    def playing(self) -> bool:
        return self._playing

    def now_ms(self) -> float:
        with self._lock:
            if not self._playing or self.external_sync:
                return self._t_ms
            elapsed = (time.monotonic() - self._started_wall) * 1000.0
            t = self._started_t + elapsed
            if self._duration_ms and t >= self._duration_ms:
                self._playing = False
                self._t_ms = self._duration_ms
                return self._t_ms
            return t

    def play(self):
        with self._lock:
            if self.external_sync:
                return
            self._started_wall = time.monotonic()
            self._started_t = self._t_ms
            self._playing = True

    def pause(self):
        with self._lock:
            self._t_ms = self.now_ms()
            self._playing = False

    def toggle(self):
        self.pause() if self._playing else self.play()

    def seek(self, t_ms: float):
        with self._lock:
            t_ms = max(0.0, min(self._duration_ms or t_ms, t_ms))
            self._t_ms = t_ms
            if self._playing:
                self._started_wall = time.monotonic()
                self._started_t = t_ms

    def apply_external(self, t_ms: float, fps: float):
        """Called from a timecode receiver thread."""
        with self._lock:
            self.last_external_fps = fps
            self._last_external_wall = time.monotonic()
            if self.external_sync:
                self._t_ms = max(0.0, t_ms)
                self._playing = True

    def external_is_live(self, timeout_s: float = 1.0) -> bool:
        return bool(self._last_external_wall) and (
            time.monotonic() - self._last_external_wall < timeout_s
        )


def governing_mount_preset(project: Project, point_id: str, t_ms: float) -> Optional[dict]:
    """Preset de montage GOUVERNANT ce point à l'instant t (recadrage
    2026-08-04 : le preset se règle au niveau des acteurs DANS LES BLOCS,
    pas par acteur globalement) — même règle LTP que les axes : la dernière
    activation démarrée à-ou-avant t dont mount_preset_id n'est pas None
    ("ne rien changer") l'emporte. "" = "aucun preset" (correction
    explicitement effacée). Retourne l'entrée de fixture_mount_presets, ou
    None (aucune correction)."""
    governing_id: Optional[str] = None
    governing_start = None
    for cue in project.cues:
        act = cue.activations.get(point_id)
        if act is None or act.mount_preset_id is None:
            continue
        effective_start = cue.start_ms + act.start_offset_ms
        if effective_start <= t_ms and (governing_start is None or effective_start >= governing_start):
            governing_start = effective_start
            governing_id = act.mount_preset_id
    if not governing_id:  # None (jamais touché) ou "" (efface)
        return None
    return next((p for p in project.fixture_mount_presets if p.get("id") == governing_id), None)


def apply_mount_preset(preset: Optional[dict], yaw_deg: float) -> tuple:
    """-> (pitch_deg, roll_deg), dérivés du lacet déjà résolu par la
    timeline (mission "modes d'orientation", phase D, 2026-08-04) — complète
    les axes que le graphe d'animation ne gère pas du tout (tangage/
    roulis), au moment de l'émission PSN uniquement, jamais une nouvelle
    timeline d'animation. `preset` = une entrée de
    Project.fixture_mount_presets ou None (aucune correction, émission
    identique à un projet qui n'utilise jamais cette fonctionnalité).

    Base de départ raisonnable, PAS une vérité géométrique garantie (l'ordre
    de composition de rotations 3D dépend de la convention) — à régler en
    direct face au vrai tube/à la vraie console, pas quelque chose qu'une
    revue de code peut valider seule."""
    if preset is None:
        return 0.0, 0.0
    pitch = float(preset.get("basePitchDeg", 0.0))
    roll = float(preset.get("baseRollDeg", 0.0))
    if preset.get("pitchTracksYaw"):
        pitch += yaw_deg
    if preset.get("rollTracksYaw"):
        roll += yaw_deg
    return pitch, roll


class PsnBroadcaster:
    """Background thread turning transport time into PSN packets."""

    def __init__(self, transport: Transport):
        self.transport = transport
        self.project: Optional[Project] = None
        self.timeline: Optional[Timeline] = None
        self.transform = OutputTransform()

        self.mcast_ip = "236.10.10.10"
        self.port = 56565
        self.iface_ip = "0.0.0.0"
        self.rate_hz = 30
        self.system_name = "Lumitrack"

        self._sender: Optional[PsnSender] = None
        self._sender_key = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.RLock()
        self.packets_sent = 0
        self.last_error: Optional[str] = None

    # -------------------------------------------------- configuration --

    def set_project(self, project: Project, timeline: Timeline):
        with self._lock:
            self.project = project
            self.timeline = timeline

    def configure(self, **kwargs):
        with self._lock:
            for key, value in kwargs.items():
                if hasattr(self, key):
                    setattr(self, key, value)

    # ------------------------------------------------------- lifecycle --

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> bool:
        if self._running:
            return True
        try:
            self._ensure_sender()
        except OSError as exc:
            self.last_error = str(exc)
            return False
        self._running = True
        self.last_error = None
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return True

    def stop(self):
        self._running = False
        if self._sender:
            self._sender.close()
            self._sender = None
            self._sender_key = None

    def _ensure_sender(self):
        key = (self.mcast_ip, self.port, self.iface_ip)
        if self._sender is None or self._sender_key != key:
            if self._sender is not None:
                self._sender.close()
            self._sender = PsnSender(mcast_ip=self.mcast_ip, port=self.port,
                                     iface_ip=self.iface_ip)
            self._sender_key = key
        return self._sender

    # ------------------------------------------------------------ loop --

    def build_trackers(self, t_ms: float):
        with self._lock:
            project, timeline = self.project, self.timeline
            transform = self.transform
        if project is None or timeline is None:
            return []

        poses = timeline.positions_at(t_ms)
        trackers = []
        for index, point in enumerate(project.points):
            if point.is_focus_point:
                # Un simple repère de visée, pas un fixture réel — jamais
                # émis en PSN (mission "modes d'orientation", 2026-08-04).
                # `index` continue quand même : garde stable
                # resolved_tracker_id() des acteurs déjà en place.
                continue
            pose = poses.get(point.id)
            if pose is None:
                continue  # never invent a position at (0,0)
            # Hauteur du tracker portée par le preset de montage (demande
            # 2026-08-06) : un tube tenu à bout de bras ou monté sur pied
            # n'émet pas à la même hauteur que le sol — offset appliqué en
            # coordonnées scène, AVANT la transformation de sortie.
            mount_preset = governing_mount_preset(project, point.id, t_ms)
            z_off = float(mount_preset.get("zOffsetCm", 0.0)) if mount_preset else 0.0
            x_m, y_m, z_m = transform.to_psn(pose.x_cm, pose.y_cm, pose.z_cm + z_off)
            yaw_rad = math.radians(pose.yaw_deg)
            # ORI = vecteur axe-angle : le lacet tourne autour de l'axe
            # VERTICAL de la convention de sortie (spec 2.03 : Y-up).
            up_y = getattr(transform, "up_axis", "y") == "y"
            # Preset de montage de fixture (phase D, recadré 2026-08-04) :
            # complète rX/rZ depuis rY (lacet déjà résolu) — gouverné par
            # les BLOCS (LTP par activation), jamais lu par la résolution
            # de lecture elle-même.
            pitch_deg, roll_deg = apply_mount_preset(mount_preset, pose.yaw_deg)
            pitch_rad = math.radians(pitch_deg)
            roll_rad = math.radians(roll_deg)
            trackers.append(Tracker(
                id=point.resolved_tracker_id(index),
                name=point.name or f"Point {index + 1}",
                x_m=x_m, y_m=y_m, z_m=z_m,
                # Le tangage va toujours dans ori_x (jamais permuté par
                # up_axis) ; le roulis prend l'axe vertical restant, celui
                # que le lacet n'occupe pas.
                ori_x=pitch_rad,
                ori_y=yaw_rad if up_y else roll_rad,
                ori_z=roll_rad if up_y else yaw_rad,
            ))
        return trackers

    def _loop(self):
        next_tick = time.monotonic()
        last_info = 0.0
        while self._running:
            try:
                sender = self._ensure_sender()
                trackers = self.build_trackers(self.transport.now_ms())
                if trackers:
                    sender.send_data(trackers)
                    self.packets_sent += 1
                    now = time.monotonic()
                    if now - last_info >= 1.0:
                        sender.send_info(trackers, system_name=self.system_name)
                        last_info = now
            except OSError as exc:
                self.last_error = str(exc)

            period = 1.0 / max(1, min(120, self.rate_hz))
            next_tick += period
            delay = next_tick - time.monotonic()
            if delay < -period:
                # We fell far behind; resynchronise instead of spinning.
                next_tick = time.monotonic()
                delay = 0.0
            if delay > 0:
                time.sleep(delay)
