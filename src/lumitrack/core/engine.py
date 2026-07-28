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
            pose = poses.get(point.id)
            if pose is None:
                continue  # never invent a position at (0,0)
            x_m, y_m, z_m = transform.to_metres(pose.x_cm, pose.y_cm, pose.z_cm)
            trackers.append(Tracker(
                id=point.resolved_tracker_id(index),
                name=point.name or f"Point {index + 1}",
                x_m=x_m, y_m=y_m, z_m=z_m,
                yaw_rad=math.radians(pose.yaw_deg),
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
