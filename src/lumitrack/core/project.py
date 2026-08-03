"""Data model for a choreography project, plus .stancz import.

Internal units are **centimetres** with the origin at the top-left of the
stage, matching Stancz's own convention. Conversion to metres for PSN happens
only at the output stage (see core.psn / core.timeline.OutputTransform).

V2 data model (see CONCEPTION.md §12.1/§13.1): the sequential cumulative
"Formation" of v0.1 is replaced by **Cue** blocks that can overlap in time.
A Cue is empty until points are explicitly **activated** in it; each
Activation carries its own fade time/easing and may set any subset of
(x, y, z, yaw) — a field left as None is simply not touched by that
activation and keeps tracking its last known value (see core.timeline for
the resolution algorithm). Relative group moves (translate/rotate around a
pivot) are an authoring-time helper (`apply_group_transform`) that bakes
straight into per-point absolute Activations: the model itself never stores
a "relative" state.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

PROJECT_FORMAT = "Lumitrack"
PROJECT_VERSION = 2

# Marqueur de l'ancien format de bundle (dossier = paquet, manifest.json +
# media/ + versions/) — conservé uniquement pour la lecture rétrocompatible,
# voir `_load_legacy_directory_bundle`. Le nouveau format (fichier .lumitrack
# + media/ + archive/, 2026-07-31) n'a pas de manifest séparé : le fichier
# JSON lui-même porte déjà format/version via Project.to_dict().
BUNDLE_FORMAT = "lumitrack-bundle"
BUNDLE_VERSION = 1

DEFAULT_HEIGHT_CM = 150.0  # plausible carried-fixture height; per-actor & animatable


@dataclass
class Point:
    """One controllable point. In this app a point is a lighting fixture
    carried by an operator, not a dancer."""
    id: str
    name: str
    number: Optional[int] = None
    color: str = "#4F6DF5"
    psn_tracker_id: Optional[int] = None  # falls back to `number` when None
    default_height_cm: float = DEFAULT_HEIGHT_CM
    # Zone backstage d'attache (mission backstage 2026-07-29) : là où
    # l'acteur EXISTE tant qu'aucune activation ne l'a saisi — visible en
    # scène et émis en PSN. None -> première zone du projet.
    home_zone_id: Optional[str] = None
    # Sous-groupe du ROSTER (mission "hiérarchie du roster", 2026-07-31) :
    # purement organisationnel — ordonner la vue, faciliter la sélection et
    # le glisser-déposer d'un ensemble d'acteurs. Sans rapport avec les
    # groupes animables du §12.2 (reportés en v1.1, LTP inter-groupes,
    # appartenance multiple) : un acteur appartient à AU PLUS UN sous-groupe,
    # comme un dossier de fichiers. None = pas de sous-groupe.
    roster_group_id: Optional[str] = None

    def resolved_tracker_id(self, fallback_index: int) -> int:
        if self.psn_tracker_id is not None:
            return int(self.psn_tracker_id) & 0xFFFF
        if self.number is not None:
            return int(self.number) & 0xFFFF
        return fallback_index & 0xFFFF

    # camelCase on the wire (JSON files + WebSocket protocol), to match both
    # the outer Project fields and the sidecar's live-edit commands.
    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "number": self.number,
            "color": self.color, "psnTrackerId": self.psn_tracker_id,
            "defaultHeightCm": self.default_height_cm,
            "homeZoneId": self.home_zone_id,
            "rosterGroupId": self.roster_group_id,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Point":
        return cls(
            id=d["id"], name=d.get("name", ""), number=d.get("number"),
            color=d.get("color", "#4F6DF5"), psn_tracker_id=d.get("psnTrackerId"),
            default_height_cm=float(d.get("defaultHeightCm", DEFAULT_HEIGHT_CM)),
            home_zone_id=d.get("homeZoneId"),
            roster_group_id=d.get("rosterGroupId"),
        )


@dataclass
class Activation:
    """One point's movement within a Cue block. Any of the target_* fields
    may be None, meaning this activation does not touch that axis for this
    point (it keeps tracking whatever value it last had)."""
    target_x_cm: Optional[float] = None
    target_y_cm: Optional[float] = None
    target_z_cm: Optional[float] = None
    target_yaw_deg: Optional[float] = None
    fade_ms: float = 1000.0
    easing: str = "linear"
    # Mission "global vs sélectif" (2026-08-03) : marque un fade_ms modifié
    # à la main par l'utilisateur (pas par la "durée automatique" du bloc).
    # Une activation personnalisée sort du recalcul automatique tant
    # qu'elle reste personnalisée (voir sidecar._apply_auto_duration) — et
    # peut revenir dans le rang via "revenir au réglage du bloc"
    # (set_activation avec fadeOverridden=false, qui la recalcule une
    # dernière fois puis la remet sous contrôle de la durée automatique).
    fade_overridden: bool = False
    # Mission "global vs sélectif", décalage de départ (2026-08-03,
    # DIRECTIVES.md point 6) : cette activation démarre (et gouverne LTP)
    # `start_offset_ms` après le début nominal du bloc (cue.start_ms), pas
    # exactement dessus — permet des entrées en escalier/vague quand
    # plusieurs acteurs partagent un bloc. 0 = comportement historique
    # (démarre pile avec le bloc). Jamais négatif (un acteur ne peut pas
    # démarrer AVANT le bloc qui le contient — sortirait de la cohérence
    # des tracks LTP, qui suppose un bloc = une fenêtre bien à lui).
    start_offset_ms: float = 0.0
    # Mission "refonte AE/Reaper" (2026-08-01) : le lacet gouverné par cette
    # activation peut suivre trois régimes — "manual" (valeur animée comme
    # n'importe quel axe, comportement historique), "path" (tangente de la
    # trajectoire spatiale résolue de CE point à cet instant — un acteur se
    # tourne dans le sens où il marche), "focus" (vise en continu le point
    # fixe focus_x_cm/focus_y_cm). Résolu dans timeline.py::resolve_positions
    # (miroir Rust : native/src/timeline.rs) — jamais dans le frontend
    # (§13.1.7). "path"/"focus" n'ont pas besoin de target_yaw_deg : l'axe
    # est "touché" par le MODE, pas par la présence d'une valeur explicite
    # (voir _axis_keyframes).
    orientation_mode: str = "manual"
    focus_x_cm: Optional[float] = None
    focus_y_cm: Optional[float] = None
    # Graph editor (mission 2026-07-29, spec = KeysView de Friction) :
    # courbes d'easing personnalisées PAR AXE. {"x"|"y"|"z"|"yaw": [node]}.
    # node = {"t": 0..1, "v": progrès, "inT"/"inV"/"outT"/"outV": poignées
    # Bézier ABSOLUES (ou None), "mode": "smooth"|"symmetric"|"corner"}.
    # Un axe absent du dict retombe sur l'easing nommé — les bundles
    # existants restent valides sans migration.
    curves: Optional[dict] = None
    # Tracé spatial courbe (mission "motion path", spec AE) : points de
    # passage ENTRE le départ (dynamique, résolu par le tracking) et la
    # cible. Chaque waypoint = {"xCm","yCm"} absolus + poignées RELATIVES
    # {"inDxCm","inDyCm","outDxCm","outDyCm"} (None = tiers de corde =
    # quasi-droit). start_handle/target_handle : poignée sortante du départ /
    # entrante de la cible, en offsets relatifs {"dxCm","dyCm"}. Tout à None
    # -> ligne droite (comportement historique, bundles inchangés).
    path_points: Optional[list] = None
    start_handle: Optional[dict] = None
    target_handle: Optional[dict] = None

    def has_spatial_path(self) -> bool:
        return bool(self.path_points) or self.start_handle is not None \
            or self.target_handle is not None

    def touches(self) -> bool:
        return any(v is not None for v in
                   (self.target_x_cm, self.target_y_cm, self.target_z_cm, self.target_yaw_deg))

    def to_dict(self) -> dict:
        return {
            "targetXCm": self.target_x_cm, "targetYCm": self.target_y_cm,
            "targetZCm": self.target_z_cm, "targetYawDeg": self.target_yaw_deg,
            "fadeMs": self.fade_ms, "easing": self.easing,
            "fadeOverridden": self.fade_overridden,
            "startOffsetMs": self.start_offset_ms,
            "orientationMode": self.orientation_mode,
            "focusXCm": self.focus_x_cm, "focusYCm": self.focus_y_cm,
            "curves": self.curves,
            "pathPoints": self.path_points,
            "startHandle": self.start_handle,
            "targetHandle": self.target_handle,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Activation":
        return cls(
            target_x_cm=d.get("targetXCm"), target_y_cm=d.get("targetYCm"),
            target_z_cm=d.get("targetZCm"), target_yaw_deg=d.get("targetYawDeg"),
            fade_ms=float(d.get("fadeMs", 1000.0)), easing=d.get("easing", "linear"),
            fade_overridden=bool(d.get("fadeOverridden", False)),
            start_offset_ms=max(0.0, float(d.get("startOffsetMs", 0.0))),
            orientation_mode=d.get("orientationMode", "manual"),
            focus_x_cm=d.get("focusXCm"), focus_y_cm=d.get("focusYCm"),
            curves=d.get("curves"),
            path_points=d.get("pathPoints"),
            start_handle=d.get("startHandle"),
            target_handle=d.get("targetHandle"),
        )


@dataclass
class Cue:
    """A block on the timeline with a real displayed duration. Empty at
    creation; activations are added per point. Cues are free to overlap in
    time and in the set of points they touch."""
    id: str
    name: str
    start_ms: float
    duration_ms: float
    activations: dict = field(default_factory=dict)  # point_id -> Activation
    color: str = "#4F6DF5"
    # Mission "refonte AE/Reaper" (2026-08-01) : quand actif, duration_ms
    # suit automatiquement la distance/vitesse de référence du projet (voir
    # timeline.required_duration_ms) au lieu d'être réglé à la main — recalculé
    # par le sidecar à chaque activation touchée ou changement de la vitesse
    # de référence. Défaut False : n'affecte aucun projet existant tant que
    # personne n'a coché la case.
    auto_duration: bool = False
    # Piste de la timeline (mission multi-pistes 2026-07-29) : les blocs se
    # placent LIBREMENT sur une piste choisie, ils ne sont plus empilés
    # automatiquement. Migration : projets sans "lane" -> empaquetage
    # glouton une seule fois au chargement (from_dict).
    lane: int = 0

    def activation_end_ms(self) -> float:
        """Latest moment any activation in this cue is still fading."""
        ends = [self.start_ms + a.fade_ms for a in self.activations.values()]
        return max(ends, default=self.start_ms)


@dataclass
class Project:
    name: str = "Untitled"
    stage_width_cm: float = 5000.0
    stage_height_cm: float = 3000.0
    grid_size_cm: float = 50.0
    points: list = field(default_factory=list)  # list[Point]
    cues: list = field(default_factory=list)     # list[Cue]
    # Zones backstage : rectangles nommés en coordonnées scène (souvent HORS
    # de la zone de jeu) — points d'entrée/sortie des acteurs. Un acteur
    # sans activation vit dans sa zone (grille auto, voir
    # timeline.backstage_slot) et le PSN l'émet.
    backstage_zones: list = field(default_factory=list)  # [{id,name,xCm,yCm,widthCm,heightCm}]
    # Sous-groupes du roster (voir Point.roster_group_id) : [{id, name}].
    # Purement organisationnel, l'ordre du roster reste porté par `points`
    # lui-même (l'ordre de la liste = l'ordre affiché).
    roster_groups: list = field(default_factory=list)
    floor_image_path: Optional[str] = None
    terrain_gltf_path: Optional[str] = None
    audio_path: Optional[str] = None
    audio_duration_s: Optional[float] = None
    bpm: Optional[float] = None
    # Offset between incoming timecode and project time zero.
    timecode_offset_ms: float = 0.0
    # PSN output settings that travel with the project (§13.1.9).
    psn_system_name: str = "Lumitrack"
    psn_mcast_ip: str = "236.10.10.10"
    psn_port: int = 56565
    # Interface réseau de sortie (0.0.0.0 = choix de l'OS) et fréquence
    # d'émission (mission panneau PSN 2026-07-29).
    psn_iface_ip: str = "0.0.0.0"
    psn_rate_hz: int = 30
    transform_origin_x_cm: float = 0.0
    transform_origin_y_cm: float = 0.0
    transform_invert_x: bool = False
    transform_invert_y: bool = False
    transform_swap_xy: bool = False
    # Convention d'axe vertical de la sortie PSN. La spec officielle 2.03
    # (p.8) est explicite : « positive x is right, positive y is up and
    # positive z is depth » — Y VERTICAL (Capture suit la spec ; MA Lighting
    # est co-auteur). "y" (défaut, conforme) envoie (x, hauteur, profondeur)
    # et le lacet en ori_y ; "z" (héritage) envoie la hauteur en Z et le
    # lacet en ori_z, pour les outils qui dévient de la spec.
    transform_up_axis: str = "y"
    # Where the stage rectangle (stage_width_cm x stage_height_cm, local
    # origin at its own top-left corner) sits inside the terrain glTF's own
    # world space — purely a 3D-view/editing placement, unrelated to
    # transform_origin_*/invert_*/swap_xy above (those shape the PSN output,
    # not the on-screen mapping). A terrain survey has no reason to share an
    # origin or orientation with the stage rectangle (observed 2026-07-28:
    # defaults leave them stacked at the world origin, which is wrong for
    # any real venue). Defaults (0,0,0) keep prior behaviour unchanged.
    stage_map_origin_x_m: float = 0.0
    stage_map_origin_z_m: float = 0.0
    stage_map_rotation_deg: float = 0.0
    # Rotation du MODÈLE 3D (terrain glTF) autour de son origine, en degrés
    # — indépendante de la rotation de la zone de jeu (mission 2026-07-29).
    terrain_rotation_deg: float = 0.0
    # Mission "refonte AE/Reaper" (2026-08-01) : vitesse (cm/s) utilisée pour
    # calculer la durée des blocs en "durée automatique" (Cue.auto_duration)
    # à partir de la distance parcourue. Réglage PROJET, pas une constante
    # (demandé explicitement) — 220 cm/s = 2,2 m/s par défaut (jogging léger,
    # cf. recherche vitesses humaines : marche ~1,3 m/s, jogging ~2,2 m/s).
    reference_speed_cms: float = 220.0

    # ---------- helpers ----------

    def ensure_backstage(self):
        """Zone backstage par défaut (au bord jardin de la zone de jeu) si
        le projet n'en a aucune, et attache chaque acteur orphelin à la
        première zone. Idempotent — appelé au chargement et à la création."""
        if not self.backstage_zones:
            self.backstage_zones.append({
                "id": "backstage-1", "name": "Backstage",
                "xCm": -500.0, "yCm": 0.0,
                "widthCm": 400.0,
                "heightCm": min(1200.0, float(self.stage_height_cm)),
            })
        zone_ids = {z["id"] for z in self.backstage_zones}
        first = self.backstage_zones[0]["id"]
        for pt in self.points:
            if pt.home_zone_id not in zone_ids:
                pt.home_zone_id = first

    def sort_cues(self):
        self.cues.sort(key=lambda c: c.start_ms)

    def point_by_id(self, pid: str) -> Optional[Point]:
        for p in self.points:
            if p.id == pid:
                return p
        return None

    def delete_point(self, point_id: str):
        """Retire un acteur — jamais fait avant cette mission (le roster ne
        savait qu'ajouter). Ses activations dans TOUS les cues partent
        aussi, sinon des activations fantômes traînent indéfiniment."""
        self.points = [p for p in self.points if p.id != point_id]
        for cue in self.cues:
            cue.activations.pop(point_id, None)

    def reorder_points(self, point_ids: list):
        """Réordonne `points` selon `point_ids` (glisser-déposer/réassignation
        de sous-groupe dans le roster). Les ids inconnus sont ignorés ; les
        points absents de la liste gardent leur ordre relatif, à la fin."""
        by_id = {p.id: p for p in self.points}
        ordered = [by_id[pid] for pid in point_ids if pid in by_id]
        seen = {p.id for p in ordered}
        remaining = [p for p in self.points if p.id not in seen]
        self.points = ordered + remaining

    def prune_roster_groups(self):
        """Après un set_roster_groups qui supprime un groupe : les acteurs
        qui y étaient rattachés redeviennent simplement "sans groupe"
        (jamais orphelins d'un id de groupe qui n'existe plus)."""
        valid_ids = {g["id"] for g in self.roster_groups}
        for pt in self.points:
            if pt.roster_group_id not in valid_ids:
                pt.roster_group_id = None

    def cue_by_id(self, cid: str) -> Optional[Cue]:
        for c in self.cues:
            if c.id == cid:
                return c
        return None

    @property
    def total_cue_ms(self) -> float:
        ends = [c.start_ms + c.duration_ms for c in self.cues]
        ends += [c.activation_end_ms() for c in self.cues]
        return max(ends, default=0.0)

    @property
    def duration_ms(self) -> float:
        if self.audio_duration_s:
            return max(self.audio_duration_s * 1000.0, self.total_cue_ms)
        return max(self.total_cue_ms, 1000.0)

    def next_start_ms(self, gap_ms: float = 0.0) -> float:
        return self.total_cue_ms + gap_ms

    # ---------- group / relative editing helper (§12.1, §13.1.1) ----------

    def apply_group_transform(self, cue: Cue, point_ids, *,
                               pivot=(0.0, 0.0), translate=(0.0, 0.0),
                               rotate_deg: float = 0.0,
                               fade_ms: float = 1000.0, easing: str = "linear",
                               resolve_origin_ms: Optional[float] = None):
        """Bake a relative translation/rotation applied to `point_ids` around
        `pivot` (cm) into absolute per-point Activations on `cue`. Each point
        gets its own arc (different radius from the pivot) rather than a
        rigid shared displacement — the model only ever stores the result.
        """
        from .timeline import resolve_positions  # local import: avoid cycle

        if resolve_origin_ms is None:
            resolve_origin_ms = cue.start_ms
        origins = resolve_positions(self, resolve_origin_ms)

        px, py = pivot
        angle = math.radians(rotate_deg)
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        dx, dy = translate

        for pid in point_ids:
            origin = origins.get(pid)
            if origin is None:
                continue
            ox, oy = origin.x_cm - px, origin.y_cm - py
            rx = ox * cos_a - oy * sin_a
            ry = ox * sin_a + oy * cos_a
            target_x = px + rx + dx
            target_y = py + ry + dy

            act = cue.activations.get(pid) or Activation(fade_ms=fade_ms, easing=easing)
            act.target_x_cm = target_x
            act.target_y_cm = target_y
            act.fade_ms = fade_ms
            act.easing = easing
            cue.activations[pid] = act

    # ---------- native format ----------

    def to_dict(self) -> dict:
        return {
            "format": PROJECT_FORMAT,
            "version": PROJECT_VERSION,
            "name": self.name,
            "stageWidthCm": self.stage_width_cm,
            "stageHeightCm": self.stage_height_cm,
            "gridSizeCm": self.grid_size_cm,
            "floorImagePath": self.floor_image_path,
            "terrainGltfPath": self.terrain_gltf_path,
            "audioPath": self.audio_path,
            "audioDurationS": self.audio_duration_s,
            "bpm": self.bpm,
            "timecodeOffsetMs": self.timecode_offset_ms,
            "psnSystemName": self.psn_system_name,
            "psnMcastIp": self.psn_mcast_ip,
            "psnPort": self.psn_port,
            "transformOriginXCm": self.transform_origin_x_cm,
            "transformOriginYCm": self.transform_origin_y_cm,
            "transformInvertX": self.transform_invert_x,
            "transformInvertY": self.transform_invert_y,
            "transformSwapXy": self.transform_swap_xy,
            "transformUpAxis": self.transform_up_axis,
            "psnIfaceIp": self.psn_iface_ip,
            "psnRateHz": self.psn_rate_hz,
            "stageMapOriginXM": self.stage_map_origin_x_m,
            "stageMapOriginZM": self.stage_map_origin_z_m,
            "stageMapRotationDeg": self.stage_map_rotation_deg,
            "terrainRotationDeg": self.terrain_rotation_deg,
            "referenceSpeedCms": self.reference_speed_cms,
            "backstageZones": self.backstage_zones,
            "rosterGroups": self.roster_groups,
            "points": [p.to_dict() for p in self.points],
            "cues": [
                {
                    "id": c.id, "name": c.name, "color": c.color,
                    "startMs": c.start_ms, "durationMs": c.duration_ms,
                    "lane": c.lane, "autoDuration": c.auto_duration,
                    "activations": {
                        pid: a.to_dict() for pid, a in c.activations.items()
                    },
                }
                for c in self.cues
            ],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Project":
        if d.get("format") != PROJECT_FORMAT:
            raise ValueError(f"Not a {PROJECT_FORMAT} project file")
        if int(d.get("version", 1)) < 2:
            raise ValueError(
                "This project uses the v1 Formation model and can't be "
                "loaded by this version of Lumitrack (no migration path).")
        proj = cls(
            name=d.get("name", "Untitled"),
            stage_width_cm=float(d.get("stageWidthCm", 5000)),
            stage_height_cm=float(d.get("stageHeightCm", 3000)),
            grid_size_cm=float(d.get("gridSizeCm", 50)),
            floor_image_path=d.get("floorImagePath"),
            terrain_gltf_path=d.get("terrainGltfPath"),
            audio_path=d.get("audioPath"),
            audio_duration_s=d.get("audioDurationS"),
            bpm=d.get("bpm"),
            timecode_offset_ms=float(d.get("timecodeOffsetMs", 0.0)),
            psn_system_name=d.get("psnSystemName", "Lumitrack"),
            psn_mcast_ip=d.get("psnMcastIp", "236.10.10.10"),
            psn_port=int(d.get("psnPort", 56565)),
            transform_origin_x_cm=float(d.get("transformOriginXCm", 0.0)),
            transform_origin_y_cm=float(d.get("transformOriginYCm", 0.0)),
            transform_invert_x=bool(d.get("transformInvertX", False)),
            transform_invert_y=bool(d.get("transformInvertY", False)),
            transform_swap_xy=bool(d.get("transformSwapXy", False)),
            transform_up_axis=d.get("transformUpAxis", "y"),
            psn_iface_ip=d.get("psnIfaceIp", "0.0.0.0"),
            psn_rate_hz=int(d.get("psnRateHz", 30)),
            stage_map_origin_x_m=float(d.get("stageMapOriginXM", 0.0)),
            stage_map_origin_z_m=float(d.get("stageMapOriginZM", 0.0)),
            stage_map_rotation_deg=float(d.get("stageMapRotationDeg", 0.0)),
            terrain_rotation_deg=float(d.get("terrainRotationDeg", 0.0)),
            reference_speed_cms=float(d.get("referenceSpeedCms", 220.0)),
        )
        proj.backstage_zones = list(d.get("backstageZones") or [])
        proj.roster_groups = list(d.get("rosterGroups") or [])
        proj.points = [Point.from_dict(p) for p in d.get("points", [])]
        for c in d.get("cues", []):
            activations = {
                pid: Activation.from_dict(a) for pid, a in c.get("activations", {}).items()
            }
            proj.cues.append(Cue(
                id=c["id"], name=c.get("name", ""),
                start_ms=float(c.get("startMs", 0)),
                duration_ms=float(c.get("durationMs", 0)),
                activations=activations,
                color=c.get("color", "#4F6DF5"),
                lane=int(c["lane"]) if c.get("lane") is not None else -1,
                auto_duration=bool(c.get("autoDuration", False)),
            ))
        proj.ensure_backstage()
        proj.sort_cues()
        # Migration multi-pistes : les projets d'avant "lane" empilaient les
        # blocs automatiquement (glouton) — on rejoue cet empaquetage UNE
        # fois pour que rien ne se chevauche visuellement au chargement.
        if any(c.lane < 0 for c in proj.cues):
            lane_ends: list = []
            for c in proj.cues:  # déjà triés par start_ms
                if c.lane >= 0:
                    continue
                for i, end in enumerate(lane_ends):
                    if end <= c.start_ms:
                        c.lane = i
                        lane_ends[i] = c.start_ms + c.duration_ms
                        break
                else:
                    c.lane = len(lane_ends)
                    lane_ends.append(c.start_ms + c.duration_ms)
        return proj

    def save(self, path: str):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, indent=2, ensure_ascii=False)

    @classmethod
    def load(cls, path: str) -> "Project":
        with open(path, encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))


# ---------------------------------------------------------------- .stancz --

def import_stancz(path: str, media_dir: Optional[str] = None) -> Project:
    """Import a Stancz bundle (.stancz = zip with manifest.json + project.json
    + audio/) as an option initial import (CONCEPTION.md §1, no longer the
    design reference, see §12/§13). Positions are cm, origin top-left.

    Stancz's sequential/cumulative formations map 1:1 onto non-overlapping
    Cues: formation N's `duration` becomes both the Cue's displayed width and
    every one of its Activations' fade time, with the same start offset as
    the old cumulative segment boundary — so imported playback is identical
    to the v0.1 behaviour, just expressed in the new model.
    """
    if media_dir is None:
        media_dir = tempfile.mkdtemp(prefix="lumitrack_")
    os.makedirs(media_dir, exist_ok=True)

    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if "project.json" not in names:
            raise ValueError("No project.json inside the .stancz archive")
        raw = json.loads(zf.read("project.json"))

        proj = Project(
            name=raw.get("name", "Imported"),
            stage_width_cm=float(raw.get("stageWidth", 5000)),
            stage_height_cm=float(raw.get("stageHeight", 3000)),
            grid_size_cm=float(raw.get("gridSize", 50)),
        )

        for d in raw.get("dancers", []):
            proj.points.append(Point(
                id=d["id"],
                name=d.get("name", ""),
                number=d.get("number"),
                color=d.get("color", "#4F6DF5"),
            ))

        formations = sorted(raw.get("formations", []), key=lambda f: f.get("order", 0))
        cursor = 0.0
        for f in formations:
            duration_ms = float(f.get("duration", 0.0))
            easing = f.get("easing", "linear")
            activations = {}
            for p in f.get("positions", []):
                activations[p["dancerId"]] = Activation(
                    target_x_cm=float(p["x"]), target_y_cm=float(p["y"]),
                    fade_ms=duration_ms, easing=easing,
                )
            proj.cues.append(Cue(
                id=f["id"], name=f.get("name", ""),
                start_ms=cursor, duration_ms=duration_ms,
                activations=activations,
            ))
            cursor += duration_ms
        proj.sort_cues()

        audio = raw.get("audioTrack") or {}
        proj.bpm = audio.get("bpm")
        proj.audio_duration_s = audio.get("duration")
        file_url = audio.get("fileUrl")
        if file_url:
            for name in names:
                if name == file_url or name.endswith(file_url):
                    out = os.path.join(media_dir, os.path.basename(name))
                    with open(out, "wb") as fh:
                        fh.write(zf.read(name))
                    proj.audio_path = out
                    break

    return proj


# ------------------------------------------------------------ .bundle -----
#
# Format revu le 2026-07-31 (arbitrage Florian) : le fichier PORTE
# l'extension, pas le dossier — plus proche d'un logiciel classique
# (Premiere, Reaper) qu'un paquet à la macOS. Un projet est un dossier
# ordinaire (n'importe quel nom) contenant :
#
#   MonShow/
#   |-- MonShow.lumitrack        état courant (JSON — Project.to_dict(),
#   |                            format/version déjà auto-descriptifs,
#   |                            pas besoin d'un manifest.json séparé)
#   |-- media/<sha256>.<ext>     dépendances (audio/3D/image) dédupliquées
#   |                            par hash de contenu — inchangé
#   `-- archive/NAME_YYYY-MM-DD_HH-MM-SS.lumitrack
#                                copie de l'état PRÉCÉDENT à chaque
#                                sauvegarde explicite, purgée au-delà de
#                                ARCHIVE_MAX_VERSIONS (les plus anciennes
#                                d'abord)
#
# Le fichier n'est jamais écrasé sans que l'ancien contenu soit d'abord
# archivé : aucune sauvegarde n'est jamais perdue.
#
# Ancien format (avant cette date, encore lisible pour ne rien perdre des
# projets déjà sauvegardés) : le DOSSIER lui-même était le paquet
# (manifest.json + media/ + versions/NNNN.json + versions/latest.json).
# Lecture seule — voir `_load_legacy_directory_bundle` : un projet ouvert
# ainsi n'a pas de chemin .lumitrack connu, "Enregistrer" redevient
# "Enregistrer sous" pour repartir sur le nouveau format sans mélanger les
# deux dans le même dossier.

BUNDLE_FILE_EXT = ".lumitrack"
ARCHIVE_MAX_VERSIONS = 50

_MEDIA_FIELDS = ("floor_image_path", "terrain_gltf_path", "audio_path")
_MEDIA_JSON_KEYS = {
    "floor_image_path": "floorImagePath",
    "terrain_gltf_path": "terrainGltfPath",
    "audio_path": "audioPath",
}


def _sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _media_dir(bundle_dir: str) -> str:
    return os.path.join(bundle_dir, "media")


def _archive_dir(bundle_dir: str) -> str:
    return os.path.join(bundle_dir, "archive")


def _prune_archive(archive_dir: str):
    """Garde les ARCHIVE_MAX_VERSIONS entrées les plus récentes, supprime le
    reste. Tri par NOM (l'horodatage y est encodé, zéro-préfixé et donc
    trie correctement en texte) plutôt que par mtime du système de
    fichiers : plusieurs sauvegardes rapprochées peuvent partager la même
    résolution de mtime selon le disque, jamais la même chaîne de nom."""
    names = sorted(n for n in os.listdir(archive_dir) if n.endswith(BUNDLE_FILE_EXT))
    excess = len(names) - ARCHIVE_MAX_VERSIONS
    for name in names[:max(0, excess)]:
        os.remove(os.path.join(archive_dir, name))


def list_archive(file_path: str) -> list:
    """-> [{"name", "mtime" (iso8601)}, ...] le plus récent d'abord, pour le
    panneau "Historique des versions" du frontend."""
    archive_dir = _archive_dir(os.path.dirname(file_path) or ".")
    if not os.path.isdir(archive_dir):
        return []
    entries = []
    for name in os.listdir(archive_dir):
        if not name.endswith(BUNDLE_FILE_EXT):
            continue
        full = os.path.join(archive_dir, name)
        mtime = datetime.fromtimestamp(os.path.getmtime(full), tz=timezone.utc)
        entries.append({"name": name, "mtime": mtime.isoformat()})
    # Tri par NOM (même raison que _prune_archive) ; mtime n'est reporté que
    # pour l'affichage humain dans le panneau historique.
    entries.sort(key=lambda e: e["name"], reverse=True)
    return entries


def _write_media_and_snapshot(project: Project, bundle_dir: str) -> dict:
    media_dir = _media_dir(bundle_dir)
    os.makedirs(media_dir, exist_ok=True)
    snapshot = project.to_dict()
    for field_name in _MEDIA_FIELDS:
        source_path = getattr(project, field_name)
        json_key = _MEDIA_JSON_KEYS[field_name]
        if not source_path:
            snapshot[json_key] = None
            continue
        if source_path.startswith("media" + os.sep) or source_path.startswith("media/"):
            snapshot[json_key] = source_path.replace(os.sep, "/")
            continue
        digest = _sha256_of(source_path)
        ext = os.path.splitext(source_path)[1]
        dest_name = f"{digest}{ext}"
        dest_path = os.path.join(media_dir, dest_name)
        if not os.path.exists(dest_path):
            shutil.copyfile(source_path, dest_path)
        snapshot[json_key] = f"media/{dest_name}"
    return snapshot


def _find_app_icon() -> Optional[str]:
    """Chemin de l'icône de l'app (frontend/src-tauri/icons/icon.ico),
    relatif au dépôt — comme `_demo_project` le fait déjà pour le terrain
    de démo. Suppose un lancement depuis le dépôt (dev, `python -m
    lumitrack`) : à revoir une fois l'app empaquetée (§12.13, jamais fait),
    où les ressources devront être adressées différemment."""
    # project.py est un niveau plus profond que sidecar.py (src/lumitrack/
    # core/project.py contre src/lumitrack/sidecar.py) : un dirname() de plus.
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    icon_path = os.path.join(repo_root, "frontend", "src-tauri", "icons", "icon.ico")
    return icon_path if os.path.isfile(icon_path) else None


def _ensure_folder_icon(bundle_dir: str):
    """Icône de dossier distinctive pour un projet Lumitrack (desktop.ini +
    IconResource, convention Windows Explorer) — purement cosmétique,
    jamais bloquant : ignore silencieusement hors Windows, si l'icône
    source est introuvable, ou en cas d'erreur (droits, disque en lecture
    seule...). N'agit qu'une fois (si desktop.ini existe déjà, no-op)."""
    if sys.platform != "win32":
        return
    ini_path = os.path.join(bundle_dir, "desktop.ini")
    if os.path.isfile(ini_path):
        return
    icon_source = _find_app_icon()
    if icon_source is None:
        return
    try:
        icon_dest = os.path.join(bundle_dir, ".lumitrack.ico")
        shutil.copyfile(icon_source, icon_dest)
        with open(ini_path, "w", encoding="utf-8") as fh:
            fh.write("[.ShellClassInfo]\nIconResource=.lumitrack.ico,0\n")
        import ctypes
        FILE_ATTRIBUTE_READONLY = 0x1
        FILE_ATTRIBUTE_HIDDEN = 0x2
        FILE_ATTRIBUTE_SYSTEM = 0x4
        ctypes.windll.kernel32.SetFileAttributesW(icon_dest, FILE_ATTRIBUTE_HIDDEN)
        ctypes.windll.kernel32.SetFileAttributesW(ini_path, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)
        # Marqueur Windows conventionnel pour "ce dossier a des réglages
        # d'affichage personnalisés" — pas une vraie protection en écriture.
        ctypes.windll.kernel32.SetFileAttributesW(bundle_dir, FILE_ATTRIBUTE_READONLY)
    except OSError:
        pass


def _ensure_own_folder(file_path: str) -> str:
    """-> chemin de fichier éventuellement corrigé pour vivre dans SON
    PROPRE dossier (dossier/dossier.lumitrack), jamais mélangé avec
    d'autres projets. Le dialogue "Enregistrer sous" ne fait que choisir un
    chemin de fichier : si l'utilisateur navigue dans un dossier existant
    ("Sauvegarde/") et tape juste un nom ("Demo.lumitrack"), le dossier
    parent immédiat ne porte pas déjà ce nom — media/archive/icône y
    seraient alors posés directement dans "Sauvegarde/", partagés (et donc
    mélangés) avec n'importe quel AUTRE projet qui s'y sauvegarderait aussi
    (constaté 2026-07-31 : "il n'a pas créé de dossier, il a juste tout mis
    là où j'étais"). Idempotent : si le dossier parent porte déjà le nom du
    fichier (un re-save normal), rien ne change."""
    stem = os.path.splitext(os.path.basename(file_path))[0]
    parent_dir = os.path.dirname(file_path) or "."
    if os.path.basename(os.path.normpath(parent_dir)) == stem:
        return file_path
    own_dir = os.path.join(parent_dir, stem)
    return os.path.join(own_dir, os.path.basename(file_path))


def save_bundle(project: Project, file_path: str) -> str:
    """Write `project` to `file_path` (a .lumitrack file) — or to a
    dedicated subfolder next to it sharing the file's own name, if
    `file_path` doesn't already live in one (see `_ensure_own_folder`).
    If a file already exists at the resolved path, it is archived first
    (timestamped copy in archive/, pruned to ARCHIVE_MAX_VERSIONS) — never
    overwritten without a copy. Media is deduped by content hash into
    media/, alongside the resolved directory. Returns the resolved
    `file_path` actually written (may differ from the argument)."""
    file_path = _ensure_own_folder(file_path)
    bundle_dir = os.path.dirname(file_path) or "."
    os.makedirs(bundle_dir, exist_ok=True)
    _ensure_folder_icon(bundle_dir)

    if os.path.isfile(file_path):
        archive_dir = _archive_dir(bundle_dir)
        os.makedirs(archive_dir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(file_path))[0]
        # Microsecondes + suffixe anti-collision : deux sauvegardes rapides
        # (ou une horloge à faible résolution) ne doivent jamais écraser
        # silencieusement une entrée d'archive précédente.
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S-%f")
        archived_name = f"{stem}_{timestamp}{BUNDLE_FILE_EXT}"
        n = 1
        while os.path.exists(os.path.join(archive_dir, archived_name)):
            n += 1
            archived_name = f"{stem}_{timestamp}-{n}{BUNDLE_FILE_EXT}"
        shutil.copyfile(file_path, os.path.join(archive_dir, archived_name))
        _prune_archive(archive_dir)

    snapshot = _write_media_and_snapshot(project, bundle_dir)
    with open(file_path, "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh, indent=2, ensure_ascii=False)
    return file_path


def _rehydrate_media_paths(snapshot: dict, bundle_dir: str):
    for json_key in _MEDIA_JSON_KEYS.values():
        rel = snapshot.get(json_key)
        if rel:
            snapshot[json_key] = os.path.join(bundle_dir, rel.replace("/", os.sep))


def _load_legacy_directory_bundle(bundle_dir: str) -> Project:
    """Ancien format (avant le 2026-07-31) : le dossier lui-même est le
    paquet. Lecture seule, toujours la dernière version connue de ce
    format — voir le commentaire d'en-tête de cette section."""
    manifest_path = os.path.join(bundle_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise ValueError(f"Not a Lumitrack bundle: {bundle_dir!r} has no manifest.json")
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("format") != BUNDLE_FORMAT:
        raise ValueError(f"Not a Lumitrack bundle: {bundle_dir!r}")
    version_path = os.path.join(bundle_dir, "versions", "latest.json")
    with open(version_path, encoding="utf-8") as fh:
        snapshot = json.load(fh)
    _rehydrate_media_paths(snapshot, bundle_dir)
    return Project.from_dict(snapshot)


def load_bundle(file_path: str, archived_name: Optional[str] = None) -> Project:
    """Load a project from a .lumitrack file. Pass `archived_name` (a name
    returned by `list_archive`) to load a specific archived version instead
    of the current one. Falls back to reading the legacy directory-bundle
    format when `file_path` points at such a directory (read-only —
    saving always writes the current file+archive format)."""
    if os.path.isdir(file_path):
        return _load_legacy_directory_bundle(file_path)

    bundle_dir = os.path.dirname(file_path) or "."
    real_path = (os.path.join(_archive_dir(bundle_dir), archived_name)
                 if archived_name is not None else file_path)
    with open(real_path, encoding="utf-8") as fh:
        snapshot = json.load(fh)
    _rehydrate_media_paths(snapshot, bundle_dir)
    return Project.from_dict(snapshot)
