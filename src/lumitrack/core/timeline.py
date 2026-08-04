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


# ------------------------------------------------------- courbes (graph) ---
# Graph editor (spec KeysView de Friction) : une courbe est une liste de
# nœuds {t, v, inT, inV, outT, outV, mode} triés par t, t et poignées en
# coordonnées ABSOLUES normalisées (t: 0..1 = progression du fade, v: 0..1 =
# progrès, dépassements autorisés pour l'overshoot). Chaque segment est une
# Bézier cubique ; le temps étant l'abscisse, on résout s tel que Bx(s) = u
# par bissection (Bx est rendu monotone en serrant les poignées dans
# [t0, t3] à l'évaluation, comme le fait CSS cubic-bezier).


def _bezier_component(p0: float, p1: float, p2: float, p3: float, s: float) -> float:
    m = 1.0 - s
    return m * m * m * p0 + 3 * m * m * s * p1 + 3 * m * s * s * p2 + s * s * s * p3


def eval_curve(nodes: list, u: float) -> float:
    """Progrès (v) à la fraction de temps u pour une courbe du graph editor.
    Défensif : < 2 nœuds valides -> identité (linéaire)."""
    if not nodes or len(nodes) < 2:
        return max(0.0, min(1.0, u))
    pts = sorted(nodes, key=lambda n: float(n.get("t", 0.0)))
    u = max(float(pts[0].get("t", 0.0)), min(float(pts[-1].get("t", 1.0)), u))
    for a, b in zip(pts, pts[1:]):
        t0, t3 = float(a.get("t", 0.0)), float(b.get("t", 1.0))
        if not (t0 <= u <= t3):
            continue
        v0, v3 = float(a.get("v", 0.0)), float(b.get("v", 1.0))
        if t3 <= t0:
            return v3
        # Poignées absolues ; absentes -> segment linéaire (tiers de corde).
        t1 = a.get("outT");  v1 = a.get("outV")
        t2 = b.get("inT");   v2 = b.get("inV")
        t1 = t0 + (t3 - t0) / 3.0 if t1 is None else max(t0, min(t3, float(t1)))
        v1 = v0 + (v3 - v0) / 3.0 if v1 is None else float(v1)
        t2 = t3 - (t3 - t0) / 3.0 if t2 is None else max(t0, min(t3, float(t2)))
        v2 = v3 - (v3 - v0) / 3.0 if v2 is None else float(v2)
        # Bissection sur s : Bx(s) est monotone croissante (poignées serrées).
        lo, hi = 0.0, 1.0
        for _ in range(48):
            mid = (lo + hi) / 2.0
            if _bezier_component(t0, t1, t2, t3, mid) < u:
                lo = mid
            else:
                hi = mid
        s = (lo + hi) / 2.0
        return _bezier_component(v0, v1, v2, v3, s)
    return float(pts[-1].get("v", 1.0))


def axis_progress(act, axis: str, progress: float) -> float:
    """Progrès effectif d'un axe : courbe personnalisée si présente, sinon
    easing nommé de l'activation."""
    curves = getattr(act, "curves", None)
    if curves and curves.get(axis):
        return eval_curve(curves[axis], max(0.0, min(1.0, progress)))
    return apply_easing(act.easing, progress)


# ------------------------------------------------------- tracé spatial -----
# Motion path (spec AE) : le chemin réellement PARCOURU au sol peut être
# courbé par des points de passage et des poignées (Activation.path_points /
# start_handle / target_handle). Le départ reste DYNAMIQUE (résolu par le
# tracking) : le premier segment part d'où le point se trouve vraiment.
# L'abscisse curviligne est uniformisée par table de longueur d'arc
# (PATH_LUT_STEPS échantillons par segment) pour une vitesse constante le
# long du tracé — le profil de vitesse vient de l'easing/courbe de l'axe X.

PATH_LUT_STEPS = 24  # même constante dans native/src/path.rs (parité)


def _spatial_segments(start_xy, act, target_xy):
    """-> [(p0, p1, p2, p3)], contrôles 2D absolus de chaque segment cubique.
    Poignée absente -> tiers de corde (segment quasi rectiligne)."""
    anchors = [tuple(start_xy)]
    for wp in (act.path_points or []):
        anchors.append((float(wp["xCm"]), float(wp["yCm"])))
    anchors.append(tuple(target_xy))

    def out_handle(i):
        a = anchors[i]
        b = anchors[i + 1]
        if i == 0:
            h = act.start_handle
            if h is not None:
                return (a[0] + float(h["dxCm"]), a[1] + float(h["dyCm"]))
        else:
            wp = (act.path_points or [])[i - 1]
            if wp.get("outDxCm") is not None:
                return (a[0] + float(wp["outDxCm"]), a[1] + float(wp.get("outDyCm") or 0.0))
        return (a[0] + (b[0] - a[0]) / 3.0, a[1] + (b[1] - a[1]) / 3.0)

    def in_handle(i):
        a = anchors[i]
        b = anchors[i + 1]
        if i + 1 == len(anchors) - 1:
            h = act.target_handle
            if h is not None:
                return (b[0] + float(h["dxCm"]), b[1] + float(h["dyCm"]))
        else:
            wp = (act.path_points or [])[i]
            if wp.get("inDxCm") is not None:
                return (b[0] + float(wp["inDxCm"]), b[1] + float(wp.get("inDyCm") or 0.0))
        return (b[0] - (b[0] - a[0]) / 3.0, b[1] - (b[1] - a[1]) / 3.0)

    return [(anchors[i], out_handle(i), in_handle(i), anchors[i + 1])
            for i in range(len(anchors) - 1)]


def _bezier2(p0, p1, p2, p3, s):
    m = 1.0 - s
    a = m * m * m
    b = 3 * m * m * s
    c = 3 * m * s * s
    d = s * s * s
    return (a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
            a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1])


def path_position(start_xy, act, target_xy, p: float):
    """Position (x, y) à la fraction de parcours p (0..1, DÉJÀ passée par
    l'easing). Paramétrage par longueur d'arc : p = fraction de la distance
    réellement parcourue, pas du paramètre de Bézier."""
    p = max(0.0, min(1.0, p))
    segments = _spatial_segments(start_xy, act, target_xy)
    # Table cumulative : PATH_LUT_STEPS pas par segment, interpolation
    # linéaire entre échantillons. Identique dans le moteur Rust.
    pts = []
    for seg in segments:
        for i in range(PATH_LUT_STEPS):
            pts.append(_bezier2(*seg, i / PATH_LUT_STEPS))
    pts.append(tuple(target_xy))
    lengths = [0.0]
    for a, b in zip(pts, pts[1:]):
        lengths.append(lengths[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = lengths[-1]
    if total <= 0.0:
        return tuple(target_xy)
    goal = p * total
    for i in range(1, len(lengths)):
        if lengths[i] >= goal:
            span = lengths[i] - lengths[i - 1]
            f = (goal - lengths[i - 1]) / span if span > 0 else 0.0
            a, b = pts[i - 1], pts[i]
            return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
    return tuple(target_xy)


# ---------------------------------------------------------- backstage ------

BACKSTAGE_SPACING_CM = 60.0


def backstage_slot(project: Project, point_id: str):
    """-> (x_cm, y_cm) de la place de l'acteur dans sa zone backstage, ou
    None (aucune zone). Grille auto (arbitrage Florian) : rangées espacées
    de BACKSTAGE_SPACING_CM, dans l'ordre du roster parmi les occupants de
    la MÊME zone — même constante dans native/src/timeline.rs (parité)."""
    if not project.backstage_zones:
        return None
    zones = {z["id"]: z for z in project.backstage_zones}
    default_id = project.backstage_zones[0]["id"]

    def zone_of(pt):
        return pt.home_zone_id if pt.home_zone_id in zones else default_id

    me = project.point_by_id(point_id)
    if me is None:
        return None
    # Un point de focus n'est qu'un repère de visée, pas un acteur réel : il
    # n'attend jamais en coulisse (mission "modes d'orientation", 2026-08-04).
    if me.is_focus_point:
        return None
    my_zone_id = zone_of(me)
    zone = zones[my_zone_id]
    # Exclut aussi les points de focus des occupants — sinon un point de
    # focus partageant la zone d'un acteur lui volerait une case dans la
    # grille (décalage visible) sans jamais l'occuper lui-même (garde
    # ci-dessus).
    occupants = [pt.id for pt in project.points if zone_of(pt) == my_zone_id and not pt.is_focus_point]
    idx = occupants.index(point_id)
    cols = max(1, int(float(zone["widthCm"]) // BACKSTAGE_SPACING_CM))
    row, col = divmod(idx, cols)
    x = float(zone["xCm"]) + BACKSTAGE_SPACING_CM / 2.0 + col * BACKSTAGE_SPACING_CM
    y = float(zone["yCm"]) + BACKSTAGE_SPACING_CM / 2.0 + row * BACKSTAGE_SPACING_CM
    return x, y


# --------------------------------------------------------- axis resolver ---

_AXIS_FIELDS = {
    "x": "target_x_cm",
    "y": "target_y_cm",
    "z": "target_z_cm",
}


def _axis_keyframes(project: Project, point_id: str, axis: str):
    """-> [(start_ms, fade_end_ms, value, activation, cue_id, axis), ...]
    sorted by start_ms, one entry per Cue whose Activation for this point
    sets this axis. The activation rides along so `_resolve_axis` can apply
    its per-axis curve (graph editor) or named easing; the cue id (index 4)
    lets `resolve_block_context` name which cue a start value tracks from.

    Only called for x/y/z now (mission "modes d'orientation", 2026-08-04) —
    yaw is resolved entirely separately by `_orientation_keyframes`/
    `_resolve_yaw`, since it's never a simple stored target anymore."""
    field_name = _AXIS_FIELDS[axis]
    kfs = []
    for cue in project.cues:
        act = cue.activations.get(point_id)
        if act is None:
            continue
        value = getattr(act, field_name)
        if value is None:
            continue
        # Décalage de départ (mission "global vs sélectif", 2026-08-03) :
        # cette activation démarre (et gouverne LTP) start_offset_ms après
        # le début nominal du bloc, pas exactement dessus — entrées en
        # escalier/vague. 0 par défaut = comportement historique inchangé.
        effective_start = cue.start_ms + act.start_offset_ms
        kfs.append((effective_start, effective_start + act.fade_ms, value, act, cue.id, axis))
    kfs.sort(key=lambda k: k[0])
    return kfs


def _resolve_axis(kfs, t_ms: float, first_origin: Optional[float] = None) -> Optional[float]:
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

    start, fade_end, target, act, _cue_id, axis = governing
    if governing_index == 0:
        # Première apparition : depuis la zone backstage si l'acteur en a
        # une (ENTRÉE en fondu, mission backstage) — sinon snap historique.
        origin = first_origin if first_origin is not None else target
    else:
        # L'origine est la position RÉELLEMENT résolue à l'instant où ce
        # keyframe démarre — évaluée sur la chaîne des prédécesseurs (fix
        # « téléportation » 2026-07-29 : avant, on prenait la CIBLE brute du
        # keyframe précédent, donc un bloc démarrant pendant le fade d'un
        # autre faisait sauter l'acteur à l'arrivée théorique du premier).
        # Récursif : profondeur = nombre de fades imbriqués, trivial en
        # pratique. Les blocs travaillent ainsi ENTRE eux.
        origin = _resolve_axis(kfs[:governing_index], start)
        if origin is None:
            origin = target

    if fade_end <= start or t_ms >= fade_end:
        return target
    progress = (t_ms - start) / (fade_end - start)
    eased = axis_progress(act, axis, progress)
    return origin + (target - origin) * eased


@dataclass(frozen=True)
class Pose:
    x_cm: float
    y_cm: float
    z_cm: float
    yaw_deg: float


def _governing_index(kfs, t_ms: float) -> int:
    """Index du keyframe gouvernant (dernier démarré à-ou-avant t), -1 si
    aucun — même parcours que `_resolve_axis`."""
    idx = -1
    for i, kf in enumerate(kfs):
        if kf[0] <= t_ms:
            idx = i
        else:
            break
    return idx


# Fenêtre d'échantillonnage (ms) pour dériver la tangente de trajectoire en
# mode "path" — assez courte pour rester réactive à un virage, assez large
# pour ne pas être dominée par le bruit numérique d'un pas de temps fin.
PATH_YAW_SAMPLE_MS = 50.0


def _orientation_keyframes(project: Project, point_id: str):
    """-> [(start_ms, fade_end_ms, activation, cue_id), ...] sorted by
    start_ms, one entry per Cue whose Activation for this point "touches
    orientation" (Activation.touches_orientation() — moves x/y, or was
    explicitly personalized via orientation_overridden even with no
    movement at all). Mission "modes d'orientation" (2026-08-04, remplace
    la v1 du 08-01) : plus de plafond YAW_TURN_MS ici — le mode "fixed" en
    trajet est déjà instantané par construction, ce plafond n'a plus de
    raison d'être."""
    kfs = []
    for cue in project.cues:
        act = cue.activations.get(point_id)
        if act is None or not act.touches_orientation():
            continue
        effective_start = cue.start_ms + act.start_offset_ms
        kfs.append((effective_start, effective_start + act.fade_ms, act, cue.id))
    kfs.sort(key=lambda k: k[0])
    return kfs


def _resolve_yaw(project: Project, point_id: str, t_ms: float, x: float, y: float,
                  resolved_xy: dict, kfs: Optional[list] = None) -> float:
    """Lacet à l'instant t, en DEUX phases indépendantes (mission "modes
    d'orientation", 2026-08-04, remplace le régime unique "manual"/"path"/
    "focus" du 2026-08-01) : "en trajet" pendant le fondu de l'activation
    gouvernante, "à l'arrivée" une fois le fondu terminé. `resolved_xy` est
    la position x/y déjà résolue de TOUS les points à cet instant (calculée
    par `resolve_positions` en une première passe) — nécessaire pour que le
    mode "focus" puisse viser un autre point sans dépendre de son propre
    lacet (aucun risque de cycle : la position ne dépend jamais du lacet
    d'un autre point). `kfs`, si fourni (par `resolve_block_context`, pour
    évaluer la valeur qui gouvernait AVANT qu'une activation "fixed" ne
    prenne le relais — LTP, comme x/y/z), remplace le parcours complet des
    keyframes d'orientation du point."""
    if kfs is None:
        kfs = _orientation_keyframes(project, point_id)
    idx = _governing_index(kfs, t_ms)
    if idx < 0:
        return 0.0
    start, fade_end, act, _cue_id = kfs[idx]

    def focus_angle(focus_point_id: Optional[str], fallback_deg: float) -> float:
        target = resolved_xy.get(focus_point_id) if focus_point_id else None
        if target is None:
            return fallback_deg
        fx, fy = target
        if abs(fx - x) < 1e-6 and abs(fy - y) < 1e-6:
            return fallback_deg
        return math.degrees(math.atan2(fy - y, fx - x))

    def travel_value(t_for_path: float) -> float:
        if act.travel_orientation_mode == "focus":
            return focus_angle(act.travel_focus_point_id, act.travel_fixed_yaw_deg)
        if act.travel_orientation_mode == "path":
            # Tangente de la trajectoire x/y résolue (approximée en ligne
            # droite même si un tracé courbe existe entre départ et cible —
            # simplification v1, inchangée depuis 2026-08-01).
            sample_t = min(t_for_path, fade_end - PATH_YAW_SAMPLE_MS) if fade_end > start else t_for_path
            sample_t = max(sample_t, start)
            kfs_x = _axis_keyframes(project, point_id, "x")
            kfs_y = _axis_keyframes(project, point_id, "y")
            t0 = max(0.0, sample_t - PATH_YAW_SAMPLE_MS)
            t1 = sample_t + PATH_YAW_SAMPLE_MS
            x0, y0 = _resolve_axis(kfs_x, t0), _resolve_axis(kfs_y, t0)
            x1, y1 = _resolve_axis(kfs_x, t1), _resolve_axis(kfs_y, t1)
            if x0 is None or y0 is None or x1 is None or y1 is None:
                return act.travel_fixed_yaw_deg
            dx, dy = x1 - x0, y1 - y0
            if abs(dx) < 1e-6 and abs(dy) < 1e-6:
                return act.travel_fixed_yaw_deg
            return math.degrees(math.atan2(dy, dx))
        # "fixed" (défaut — et repli sûr pour une valeur non reconnue).
        return act.travel_fixed_yaw_deg

    if t_ms < fade_end:
        return travel_value(t_ms)
    if act.arrival_orientation_mode == "fixed":
        return act.arrival_fixed_yaw_deg
    if act.arrival_orientation_mode == "focus":
        return focus_angle(act.arrival_focus_point_id, act.arrival_fixed_yaw_deg)
    # "hold" (défaut — et repli sûr) : fige ce que le trajet avait résolu
    # PILE à l'instant où le fondu s'est terminé — généralise à tous les
    # modes de trajet ce que "path" faisait déjà seul avant le split.
    return travel_value(fade_end)


def resolve_positions(project: Project, t_ms: float) -> dict:
    """-> {point_id: Pose}. A point absent from the result has no known x/y
    at this instant and must never be sent to PSN or drawn on the scene.

    Two passes (mission "modes d'orientation", 2026-08-04) : x/y/z for
    EVERY point first, THEN yaw for every point — required since "focus"
    mode must read another point's already-resolved x/y at this same
    instant. No cycle risk: a point's position never depends on any other
    point's yaw."""
    result = {}
    resolved_xy: dict = {}
    needs_yaw = []  # (point_id, x, y, z)
    for point in project.points:
        kfs_x = _axis_keyframes(project, point.id, "x")
        kfs_y = _axis_keyframes(project, point.id, "y")
        slot = backstage_slot(project, point.id)
        x = _resolve_axis(kfs_x, t_ms, slot[0] if slot else None)
        y = _resolve_axis(kfs_y, t_ms, slot[1] if slot else None)
        if x is None or y is None:
            # Aucune activation démarrée : l'acteur EXISTE dans sa zone
            # backstage (visible + émis PSN). Sans zone : invisible, comme
            # avant — jamais de fausse position.
            if slot is None:
                continue
            result[point.id] = Pose(
                x_cm=slot[0], y_cm=slot[1],
                z_cm=point.default_height_cm, yaw_deg=0.0,
            )
            resolved_xy[point.id] = (slot[0], slot[1])
            continue
        # Tracé spatial (motion path) : quand le MÊME cue gouverne x ET y,
        # que son activation porte un tracé courbe et qu'on est en plein
        # fade, la position vient du tracé — les deux axes cessent d'être
        # indépendants le temps de ce parcours. Si un autre cue vole un des
        # deux axes (LTP), on retombe sur la résolution par axe : le tracé
        # est partiellement écrasé, comme n'importe quelle cible.
        ix = _governing_index(kfs_x, t_ms)
        iy = _governing_index(kfs_y, t_ms)
        if ix >= 0 and iy >= 0 and kfs_x[ix][4] == kfs_y[iy][4]:
            start, fade_end, _tx, act, _cid, _ax = kfs_x[ix]
            if act.has_spatial_path() and fade_end > start and t_ms < fade_end:
                ox = _resolve_axis(kfs_x[:ix], start) if ix > 0 else (slot[0] if slot else None)
                oy = _resolve_axis(kfs_y[:iy], start) if iy > 0 else (slot[1] if slot else None)
                origin = (ox if ox is not None else kfs_x[ix][2],
                          oy if oy is not None else kfs_y[iy][2])
                target = (kfs_x[ix][2], kfs_y[iy][2])
                progress = (t_ms - start) / (fade_end - start)
                # Le profil de vitesse du tracé = courbe/easing de l'axe X.
                eased = axis_progress(act, "x", progress)
                x, y = path_position(origin, act, target, eased)
        z = _resolve_axis(_axis_keyframes(project, point.id, "z"), t_ms)
        z_resolved = z if z is not None else point.default_height_cm
        resolved_xy[point.id] = (x, y)
        needs_yaw.append((point.id, x, y, z_resolved))
    for point_id, x, y, z in needs_yaw:
        result[point_id] = Pose(
            x_cm=x, y_cm=y, z_cm=z,
            yaw_deg=_resolve_yaw(project, point_id, t_ms, x, y, resolved_xy),
        )
    return result


# ---------------------------------------------------- block edit context ---

#: Sample count for the spatial polyline sent to the frontend. The path is a
#: straight segment today, but the wire format is already a polyline so the
#: Bézier/vector editor (§12.5) won't need a protocol change.
TRAJECTORY_SAMPLES = 24


def resolve_block_context(project: Project, cue_id: str,
                          samples: int = TRAJECTORY_SAMPLES) -> dict:
    """Everything the scene needs to enter block-edit mode for one cue
    (§12.6): for each point the cue activates, where its trajectory really
    starts, where it ends, a backend-sampled spatial polyline between the
    two, and which cue each start value tracks from.

    The start of an axis is the target of the previous keyframe on that
    axis in the same LTP order the playback resolver uses (`_resolve_axis`
    picks the latest-started activation as governing and interpolates from
    the previous one's target) — i.e. the last cue that *actually touched
    this point's axis*, not the neighbouring block on the timeline, so a
    point skipped by an unrelated in-between block still tracks from the
    right place. A first appearance snaps to its own target (§7 point 7):
    start == target and no path.

    Spatial path and timing are deliberately separate structures
    (§13.1.11): `path` is pure geometry, sampled at uniform parameter with
    no easing baked in; `timing` (startMs/fadeMs/easing) is what maps time
    onto that geometry. The frontend never re-derives one from the other.
    """
    cue = project.cue_by_id(cue_id)
    if cue is None:
        raise ValueError(f"Unknown cue id {cue_id!r}")

    entries = {}
    for point in project.points:
        act = cue.activations.get(point.id)
        if act is None:
            continue
        # Décalage de départ (2026-08-03) : le moment où CETTE activation
        # démarre vraiment, pas forcément le début nominal du bloc — tout
        # ce qui suit doit interroger les autres tracks à CET instant, pas
        # à cue.start_ms brut (sinon l'aperçu de départ/cible mentirait dès
        # qu'un acteur a un décalage).
        effective_start = cue.start_ms + act.start_offset_ms

        axis_start = {}
        axis_target = {}
        sources = {}
        for axis, field_name in _AXIS_FIELDS.items():
            kfs = _axis_keyframes(project, point.id, axis)
            value = getattr(act, field_name)
            if value is None:
                # Axis untouched by this activation: during the block it
                # keeps tracking whatever governs it at the block's start.
                resolved = _resolve_axis(kfs, effective_start)
                axis_start[axis] = resolved
                axis_target[axis] = resolved
                sources[axis] = None
                continue
            index = next(i for i, kf in enumerate(kfs) if kf[4] == cue_id)
            if index == 0:
                # Première apparition : la trajectoire d'ENTRÉE part de la
                # zone backstage quand l'acteur en a une.
                slot = backstage_slot(project, point.id)
                if slot is not None and axis in ("x", "y"):
                    axis_start[axis] = slot[0] if axis == "x" else slot[1]
                else:
                    axis_start[axis] = value
                sources[axis] = None
            else:
                resolved = _resolve_axis(kfs[:index], effective_start)
                axis_start[axis] = resolved if resolved is not None else kfs[index - 1][2]
                sources[axis] = kfs[index - 1][4]
            axis_target[axis] = value

        # Le lacet est toujours dérivé (mission "modes d'orientation",
        # 2026-08-04 : plus de mode "manual" stocké) — jamais traité par la
        # boucle générique ci-dessus (absent de _AXIS_FIELDS). On calcule ici
        # le lacet réellement affiché au départ/à la cible de CE bloc, à
        # partir des positions x/y déjà résolues juste au-dessus. Un
        # éventuel point de focus référencé est cherché dans la résolution
        # GLOBALE du projet à cet instant (`_resolved_xy_at`) — sa propre
        # position ne dépend jamais de ce bloc.
        def _resolved_xy_at(t: float) -> dict:
            return {pid: (pose.x_cm, pose.y_cm) for pid, pose in resolve_positions(project, t).items()}

        axis_start["yaw"] = None
        axis_target["yaw"] = None
        kfs_orient = _orientation_keyframes(project, point.id)
        orient_idx = next((i for i, kf in enumerate(kfs_orient) if kf[3] == cue_id), None)
        if (orient_idx is not None and axis_start.get("x") is not None
                and axis_start.get("y") is not None):
            if orient_idx == 0 or act.travel_orientation_mode != "fixed":
                # Mode dérivé (path/focus) ou première apparition : pas de
                # notion de "valeur précédente" — la valeur EST celle de
                # cette activation elle-même à cet instant (comportement
                # inchangé depuis 2026-08-01 pour path/focus).
                axis_start["yaw"] = _resolve_yaw(
                    project, point.id, effective_start, axis_start["x"], axis_start["y"],
                    _resolved_xy_at(effective_start))
            else:
                # "fixed" : LTP comme x/y/z — la valeur qui gouvernait JUSTE
                # AVANT que cette activation ne prenne le relais.
                axis_start["yaw"] = _resolve_yaw(
                    project, point.id, effective_start, axis_start["x"], axis_start["y"],
                    _resolved_xy_at(effective_start), kfs=kfs_orient[:orient_idx])
        if (orient_idx is not None and axis_target.get("x") is not None
                and axis_target.get("y") is not None):
            axis_target["yaw"] = _resolve_yaw(
                project, point.id, effective_start + act.fade_ms, axis_target["x"], axis_target["y"],
                _resolved_xy_at(effective_start + act.fade_ms))
        sources["yaw"] = None

        def pose_or_none(values):
            if values["x"] is None or values["y"] is None:
                return None  # no known position: never invent one (§13.1.7)
            z = values["z"] if values["z"] is not None else point.default_height_cm
            yaw = values["yaw"] if values["yaw"] is not None else 0.0
            return [values["x"], values["y"], z, yaw]

        start_pose = pose_or_none(axis_start)
        target_pose = pose_or_none(axis_target)

        path = []
        if (start_pose is not None and target_pose is not None
                and (start_pose[:3] != target_pose[:3] or act.has_spatial_path())):
            # Échantillonnage à abscisse curviligne uniforme, sans easing
            # (§13.1.11) : le tracé courbe passe par path_position, la
            # hauteur reste linéaire le long du parcours.
            curved = act.has_spatial_path()
            for i in range(samples + 1):
                s = i / samples
                if curved:
                    px, py = path_position(
                        (start_pose[0], start_pose[1]), act,
                        (target_pose[0], target_pose[1]), s)
                else:
                    px = start_pose[0] + (target_pose[0] - start_pose[0]) * s
                    py = start_pose[1] + (target_pose[1] - start_pose[1]) * s
                path.append([px, py,
                             start_pose[2] + (target_pose[2] - start_pose[2]) * s])

        entries[point.id] = {
            "startPose": start_pose,
            "targetPose": target_pose,
            "path": path,
            "timing": {"startMs": effective_start, "fadeMs": act.fade_ms,
                       "easing": act.easing},
            "sources": sources,
        }

    return {"cueId": cue_id, "entries": entries}


TRAJECTORY_OVERLAY_SAMPLES = 120


def resolve_trajectories(project: Project, point_ids, samples: int = TRAJECTORY_OVERLAY_SAMPLES) -> dict:
    """Mission "refonte AE/Reaper" (2026-08-01) : la courbe de déplacement
    d'un ou plusieurs acteurs sur toute la durée du projet, échantillonnée
    uniformément — l'overlay de trajectoire à la sélection qui remplace la
    ligne d'automation x/y/z retirée du bloc (redondante avec la scène ;
    voir BlockAutomation côté frontend). Aucune nouvelle résolution : rejoue
    `resolve_positions` à chaque instant échantillonné, seule source de
    vérité — un point absent à un instant donné (pas encore en scène, sans
    zone backstage) donne None à cet index plutôt qu'un repli (0,0)."""
    duration = project.duration_ms
    times = [0.0] if duration <= 0 or samples < 1 else [
        duration * i / samples for i in range(samples + 1)]
    trajectories: dict = {pid: [] for pid in point_ids}
    for t in times:
        poses = resolve_positions(project, t)
        for pid in point_ids:
            pose = poses.get(pid)
            trajectories[pid].append(
                [pose.x_cm, pose.y_cm, pose.z_cm, pose.yaw_deg] if pose else None)
    return {"timesMs": times, "trajectories": trajectories}


MIN_AUTO_DURATION_MS = 200.0


def required_fade_ms_per_point(project: Project, cue: Cue) -> dict:
    """Mission "refonte AE/Reaper" (2026-08-01) : durée (fade_ms) nécessaire
    pour CHAQUE acteur de ce bloc parcoure SA distance à la vitesse de
    référence du projet — un acteur avec moins de chemin à faire arrive
    juste plus tôt et attend (mécanique de maintien déjà existante, aucune
    logique spéciale), il ne doit pas hériter du fade des autres. Corrige
    le bug "la boîte change de vitesse mais les acteurs non" (signalé
    2026-08-03) : `Cue.auto_duration` et les presets de vitesse ne
    touchaient QUE `cue.duration_ms` (largeur visuelle du bloc), jamais le
    `fade_ms` de chaque activation qui gouverne réellement la vitesse de
    déplacement. Prend le départ/la cible EXACTS déjà calculés par
    `resolve_block_context` (même logique de "première apparition"/zone
    backstage/téléportation, aucune duplication) ; seule la distance x/y
    compte, pas la hauteur ni le lacet."""
    speed_cms_per_s = max(1.0, project.reference_speed_cms)
    result = {}
    for point_id, entry in resolve_block_context(project, cue.id)["entries"].items():
        start, target = entry["startPose"], entry["targetPose"]
        if start is None or target is None:
            continue
        distance_cm = math.hypot(target[0] - start[0], target[1] - start[1])
        result[point_id] = max(MIN_AUTO_DURATION_MS, (distance_cm / speed_cms_per_s) * 1000.0)
    return result


def required_duration_ms(project: Project, cue: Cue) -> float:
    """Durée du bloc entier = l'instant où le DERNIER acteur termine
    réellement son mouvement — décalage de départ inclus (2026-08-03) : un
    acteur décalé de 500 ms qui a besoin de 1000 ms pour parcourir sa
    distance ne termine pas à 1000 ms mais à 1500 ms, sinon le bloc serait
    trop court pour le contenir en entier. Un bloc sans déplacement réel
    (cible = départ, ou aucun point encore positionnable) garde le
    plancher MIN_AUTO_DURATION_MS plutôt que 0."""
    per_point = required_fade_ms_per_point(project, cue)
    finish_times = [
        cue.activations[pid].start_offset_ms + fade_ms
        for pid, fade_ms in per_point.items() if pid in cue.activations
    ]
    return max(finish_times, default=MIN_AUTO_DURATION_MS)


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

    Two placements are folded together here, in this order:

    1. **Stage-map placement** (`stage_map_*`) — the rigid transform (drag +
       rotate gizmo, §12.11) that positions the stage rectangle inside a
       terrain glTF's own world space, purely for on-screen 3D alignment
       until this point. When the previz software (Capture/MA3) has the
       *same* terrain loaded — the common case once a venue survey exists —
       PSN output must land in that shared world frame too, or a point
       shown correctly aligned with the terrain in Lumitrack's own 3D view
       arrives at the wrong spot in the previz (observed 2026-07-31: a
       ~45m offset, half the stage width, on a project whose stage had been
       centred on the terrain via this gizmo). Defaults to (0, 0, 0°), an
       identity transform, so projects that never touch the terrain-mapping
       gizmo see no change in PSN output from this step.
    2. **Origin/invert/swap** (`origin_*_cm`/`invert_*`/`swap_xy`) — a fine
       trim applied on top, in the same world frame, for any residual axis
       convention mismatch the terrain alignment doesn't already resolve
       (e.g. Capture's Y-inversion habits, §4).
    """

    def __init__(self, origin_x_cm: float = 0.0, origin_y_cm: float = 0.0,
                 invert_x: bool = False, invert_y: bool = False,
                 swap_xy: bool = False, up_axis: str = "y",
                 stage_map_origin_x_m: float = 0.0, stage_map_origin_z_m: float = 0.0,
                 stage_map_rotation_deg: float = 0.0):
        self.origin_x_cm = origin_x_cm
        self.origin_y_cm = origin_y_cm
        self.invert_x = invert_x
        self.invert_y = invert_y
        self.swap_xy = swap_xy
        self.up_axis = up_axis
        self.stage_map_origin_x_m = stage_map_origin_x_m
        self.stage_map_origin_z_m = stage_map_origin_z_m
        self.stage_map_rotation_deg = stage_map_rotation_deg

    def to_metres(self, x_cm: float, y_cm: float, z_cm: float = 0.0):
        # Stage-local metres (the fine-trim origin, in the rectangle's own
        # top-left-origin frame — same pivot the stage-map rotation below
        # applies around, matching `StageGroup` in Scene.tsx).
        lx = (x_cm - self.origin_x_cm) / 100.0
        ly = (y_cm - self.origin_y_cm) / 100.0
        z = z_cm / 100.0

        # Place into the terrain's own world frame: identical rigid
        # transform (rotate then translate) to the one `StageGroup`/`fit`
        # apply in Scene.tsx, so a point drawn at a given spot in the
        # terrain-aligned 3D view lands at that same spot in PSN.
        angle = math.radians(self.stage_map_rotation_deg)
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        x = self.stage_map_origin_x_m + lx * cos_a + ly * sin_a
        y = self.stage_map_origin_z_m + (-lx * sin_a + ly * cos_a)

        if self.invert_x:
            x = -x
        if self.invert_y:
            y = -y
        if self.swap_xy:
            x, y = y, x
        return x, y, z

    def to_psn(self, x_cm: float, y_cm: float, z_cm: float = 0.0):
        """-> (pos_x, pos_y, pos_z) au sens de la SPEC PSN 2.03 p.8 :
        « positive x is right, positive y is up, positive z is depth ».
        up_axis "y" (conforme) : la hauteur part en Y, la profondeur du
        plateau en Z ; "z" (héritage) : hauteur en Z."""
        x, y, h = self.to_metres(x_cm, y_cm, z_cm)
        if self.up_axis == "y":
            return x, h, y
        return x, y, h

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
            up_axis=getattr(project, "transform_up_axis", "y"),
            stage_map_origin_x_m=project.stage_map_origin_x_m,
            stage_map_origin_z_m=project.stage_map_origin_z_m,
            stage_map_rotation_deg=project.stage_map_rotation_deg,
        )
