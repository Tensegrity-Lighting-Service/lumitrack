"""Timeline evaluation: project time (ms) -> per-point pose.

V2 model (CONCEPTION.md §12.1/§13.1): Cues can overlap in time and only
carry Activations for the points they explicitly touch. x, y, z and yaw are
resolved as four **independent tracks** per point: for each axis, walk every
Cue/Activation touching that point in start_ms order and keep whichever
activation most recently started at-or-before `t` (Latest Takes Precedence,
§12.2) as the "governing" keyframe for that axis. The point interpolates
from the previous governing value to this one's target over
[cue.start_ms, cue.start_ms + activation.fade_ms], then holds (tracks) the
target until a later activation touches that axis again.

A point's very first appearance on an axis has no prior value to travel
from, so it snaps directly to the target rather than animating in (matches
the documented, not-yet-confirmed-against-real-Stancz behaviour carried over
from v0.1, CONCEPTION.md §7 point 7).

x/y absent for a point at time t => the point has no known position at all
and must be excluded from the PSN stream (never faked at 0,0). z/yaw absent
fall back to the point's own default rather than excluding it, since height
and heading are secondary to "is this point positioned at all".
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from .project import Project, Cue


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


# --------------------------------------------------------- axis resolver ---

_AXIS_FIELDS = {
    "x": "target_x_cm",
    "y": "target_y_cm",
    "z": "target_z_cm",
    "yaw": "target_yaw_deg",
}


def _axis_keyframes(project: Project, point_id: str, axis: str):
    """-> [(start_ms, fade_end_ms, value, easing), ...] sorted by start_ms,
    one entry per Cue whose Activation for this point sets this axis."""
    field_name = _AXIS_FIELDS[axis]
    kfs = []
    for cue in project.cues:
        act = cue.activations.get(point_id)
        if act is None:
            continue
        value = getattr(act, field_name)
        if value is None:
            continue
        kfs.append((cue.start_ms, cue.start_ms + act.fade_ms, value, act.easing))
    kfs.sort(key=lambda k: k[0])
    return kfs


def _resolve_axis(kfs, t_ms: float) -> Optional[float]:
    governing = None
    governing_index = -1
    for i, kf in enumerate(kfs):
        if kf[0] <= t_ms:
            governing = kf
            governing_index = i
        else:
            break
    if governing is None:
        return None  # point hasn't reached its first keyframe on this axis yet

    start, fade_end, target, easing = governing
    if governing_index == 0:
        origin = target  # first appearance: no prior value, snap to target
    else:
        origin = kfs[governing_index - 1][2]

    if fade_end <= start or t_ms >= fade_end:
        return target
    progress = (t_ms - start) / (fade_end - start)
    eased = apply_easing(easing, progress)
    return origin + (target - origin) * eased


@dataclass(frozen=True)
class Pose:
    x_cm: float
    y_cm: float
    z_cm: float
    yaw_deg: float


def resolve_positions(project: Project, t_ms: float) -> dict:
    """-> {point_id: Pose}. A point absent from the result has no known x/y
    at this instant and must never be sent to PSN or drawn on the scene."""
    result = {}
    for point in project.points:
        x = _resolve_axis(_axis_keyframes(project, point.id, "x"), t_ms)
        y = _resolve_axis(_axis_keyframes(project, point.id, "y"), t_ms)
        if x is None or y is None:
            continue
        z = _resolve_axis(_axis_keyframes(project, point.id, "z"), t_ms)
        yaw = _resolve_axis(_axis_keyframes(project, point.id, "yaw"), t_ms)
        result[point.id] = Pose(
            x_cm=x, y_cm=y,
            z_cm=z if z is not None else point.default_height_cm,
            yaw_deg=yaw if yaw is not None else 0.0,
        )
    return result


class Timeline:
    """Thin, cheap-to-recreate wrapper: `resolve_positions` does the actual
    work and is what `apply_group_transform` calls directly to avoid needing
    a live Timeline instance while authoring."""

    def __init__(self, project: Project):
        self.project = project
        self.rebuild()

    def rebuild(self):
        """Call after editing cue start times so `cues_ordered` stays sorted."""
        self.project.sort_cues()

    @property
    def duration_ms(self) -> float:
        return self.project.duration_ms

    def cues_active_at(self, t_ms: float) -> list:
        """Cues whose displayed block spans `t_ms` — for UI highlighting,
        not used by position resolution (each Activation has its own fade
        window, which may be shorter or longer than the block)."""
        return [c for c in self.project.cues
                if c.start_ms <= t_ms <= c.start_ms + c.duration_ms]

    def positions_at(self, t_ms: float) -> dict:
        """-> {point_id: Pose}, points with no known position simply absent."""
        t_ms = max(0.0, min(self.duration_ms, t_ms))
        return resolve_positions(self.project, t_ms)


# ----------------------------------------------------------- transform -----

class OutputTransform:
    """Converts stage coordinates (cm, origin top-left) into PSN metres.

    Keep this separate from the timeline so the maths can be unit-tested and
    so the same positions can feed other outputs later (OSC, Art-Net...).
    """

    def __init__(self, origin_x_cm: float = 0.0, origin_y_cm: float = 0.0,
                 invert_x: bool = False, invert_y: bool = False,
                 swap_xy: bool = False):
        self.origin_x_cm = origin_x_cm
        self.origin_y_cm = origin_y_cm
        self.invert_x = invert_x
        self.invert_y = invert_y
        self.swap_xy = swap_xy

    def to_metres(self, x_cm: float, y_cm: float, z_cm: float = 0.0):
        x = (x_cm - self.origin_x_cm) / 100.0
        y = (y_cm - self.origin_y_cm) / 100.0
        z = z_cm / 100.0
        if self.invert_x:
            x = -x
        if self.invert_y:
            y = -y
        if self.swap_xy:
            x, y = y, x
        return x, y, z

    def centre_on(self, project: Project):
        self.origin_x_cm = project.stage_width_cm / 2.0
        self.origin_y_cm = project.stage_height_cm / 2.0

    @classmethod
    def from_project(cls, project: Project) -> "OutputTransform":
        return cls(
            origin_x_cm=project.transform_origin_x_cm,
            origin_y_cm=project.transform_origin_y_cm,
            invert_x=project.transform_invert_x,
            invert_y=project.transform_invert_y,
            swap_xy=project.transform_swap_xy,
        )
