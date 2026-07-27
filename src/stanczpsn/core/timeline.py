"""Timeline evaluation: project time (ms) -> {point_id: (x_cm, y_cm)}.

Formations are sequential segments. `duration_ms` is the length of the segment
that ends ON that formation, so:

    segment[0] = [0, d0]        -> reaches formation[0] at d0
    segment[i] = [sum(d<i), sum(d<=i)]

A point absent from a formation's `positions` is not moved: it keeps its last
known position.
"""
from __future__ import annotations

import math
from typing import Optional

from .project import Project, Formation


# ------------------------------------------------------------- easing ------

def _linear(t: float) -> float:
    return t


def _smooth(t: float) -> float:
    """smoothstep / ease-in-out"""
    return t * t * (3 - 2 * t)


def _ease_in(t: float) -> float:
    return t * t * t


def _ease_out(t: float) -> float:
    return 1 - pow(1 - t, 3)


def _bounce(t: float) -> float:
    n1, d1 = 7.5625, 2.75
    if t < 1 / d1:
        return n1 * t * t
    if t < 2 / d1:
        t -= 1.5 / d1
        return n1 * t * t + 0.75
    if t < 2.5 / d1:
        t -= 2.25 / d1
        return n1 * t * t + 0.9375
    t -= 2.625 / d1
    return n1 * t * t + 0.984375


def _spring(t: float) -> float:
    c4 = (2 * math.pi) / 3
    if t <= 0:
        return 0.0
    if t >= 1:
        return 1.0
    return pow(2, -10 * t) * math.sin((t * 10 - 0.75) * c4) + 1


def _exponential(t: float) -> float:
    if t <= 0:
        return 0.0
    if t >= 1:
        return 1.0
    return pow(2, 10 * t - 10)


#: Canonical curve name -> function. Aliases below cover the French labels
#: used by Stancz's UI so imported projects keep their intent.
EASING_FUNCS = {
    "linear": _linear,
    "smooth": _smooth,
    "ease-in": _ease_in,
    "ease-out": _ease_out,
    "bounce": _bounce,
    "spring": _spring,
    "exponential": _exponential,
}

EASING_ALIASES = {
    "lineaire": "linear", "linéaire": "linear",
    "doux": "smooth", "ease": "smooth", "ease-in-out": "smooth",
    "rebond": "bounce",
    "ressort": "spring",
    "exponentiel": "exponential",
}

#: Order used to populate UI combo boxes.
EASING_NAMES = list(EASING_FUNCS.keys())


def apply_easing(name: str, t: float) -> float:
    t = max(0.0, min(1.0, t))
    key = (name or "linear").strip().lower()
    key = EASING_ALIASES.get(key, key)
    return EASING_FUNCS.get(key, _linear)(t)


# ------------------------------------------------------------ timeline -----

class Timeline:
    def __init__(self, project: Project):
        self.project = project
        self.rebuild()

    def rebuild(self):
        """Recompute segment bounds. Call after editing formation durations."""
        self.project.sort_formations()
        self._segments = []  # (start_ms, end_ms, formation)
        cursor = 0.0
        for f in self.project.formations:
            self._segments.append((cursor, cursor + f.duration_ms, f))
            cursor += f.duration_ms

    @property
    def segments(self):
        return list(self._segments)

    @property
    def duration_ms(self) -> float:
        return self.project.duration_ms

    def formation_at(self, t_ms: float) -> Optional[Formation]:
        for start, end, f in self._segments:
            if start <= t_ms <= end:
                return f
        return self._segments[-1][2] if self._segments else None

    def positions_at(self, t_ms: float) -> dict:
        """-> {point_id: (x_cm, y_cm)}. Points with no known position at this
        time are simply absent from the result (never faked at 0,0)."""
        if not self._segments:
            return {}

        t_ms = max(0.0, min(self.duration_ms, t_ms))

        index = len(self._segments) - 1
        for i, (start, end, _f) in enumerate(self._segments):
            if start <= t_ms <= end:
                index = i
                break

        start, end, formation = self._segments[index]
        progress = 0.0 if end <= start else (t_ms - start) / (end - start)
        eased = apply_easing(formation.easing, progress)

        # Last known position for every point, from all earlier formations.
        last_known: dict = {}
        for i in range(index):
            last_known.update(self._segments[i][2].positions)

        prev_formation = self._segments[index - 1][2] if index > 0 else None

        result = {}
        for point in self.project.points:
            pid = point.id
            target = formation.positions.get(pid)
            origin = None
            if prev_formation is not None:
                origin = prev_formation.positions.get(pid)
            if origin is None:
                origin = last_known.get(pid)

            if target is None:
                if origin is not None:
                    result[pid] = origin
                continue

            if origin is None:
                # First appearance: no origin to travel from.
                result[pid] = target
                continue

            result[pid] = (
                origin[0] + (target[0] - origin[0]) * eased,
                origin[1] + (target[1] - origin[1]) * eased,
            )
        return result


# ----------------------------------------------------------- transform -----

class OutputTransform:
    """Converts stage coordinates (cm, origin top-left) into PSN metres.

    Keep this separate from the timeline so the maths can be unit-tested and
    so the same positions can feed other outputs later (OSC, Art-Net...).
    """

    def __init__(self, origin_x_cm: float = 0.0, origin_y_cm: float = 0.0,
                 invert_x: bool = False, invert_y: bool = False,
                 swap_xy: bool = False, z_m: float = 0.0):
        self.origin_x_cm = origin_x_cm
        self.origin_y_cm = origin_y_cm
        self.invert_x = invert_x
        self.invert_y = invert_y
        self.swap_xy = swap_xy
        self.z_m = z_m

    def to_metres(self, x_cm: float, y_cm: float):
        x = (x_cm - self.origin_x_cm) / 100.0
        y = (y_cm - self.origin_y_cm) / 100.0
        if self.invert_x:
            x = -x
        if self.invert_y:
            y = -y
        if self.swap_xy:
            x, y = y, x
        return x, y, self.z_m

    def centre_on(self, project: Project):
        self.origin_x_cm = project.stage_width_cm / 2.0
        self.origin_y_cm = project.stage_height_cm / 2.0
