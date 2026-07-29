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
import tempfile
import zipfile
from dataclasses import dataclass, field
from typing import Optional

PROJECT_FORMAT = "Lumitrack"
PROJECT_VERSION = 2

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
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Point":
        return cls(
            id=d["id"], name=d.get("name", ""), number=d.get("number"),
            color=d.get("color", "#4F6DF5"), psn_tracker_id=d.get("psnTrackerId"),
            default_height_cm=float(d.get("defaultHeightCm", DEFAULT_HEIGHT_CM)),
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
    # "manual" (fixed heading) or "path" (tangent of the spatial trajectory).
    # Only "manual" is exercised by the v1 UI (Vue Dessus only, §13.1.3);
    # "path" is accepted here so the engine doesn't need another migration
    # once trajectory-tangent orientation ships.
    orientation_mode: str = "manual"
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
            "orientationMode": self.orientation_mode,
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
            orientation_mode=d.get("orientationMode", "manual"),
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

    # ---------- helpers ----------

    def sort_cues(self):
        self.cues.sort(key=lambda c: c.start_ms)

    def point_by_id(self, pid: str) -> Optional[Point]:
        for p in self.points:
            if p.id == pid:
                return p
        return None

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
            "points": [p.to_dict() for p in self.points],
            "cues": [
                {
                    "id": c.id, "name": c.name, "color": c.color,
                    "startMs": c.start_ms, "durationMs": c.duration_ms,
                    "lane": c.lane,
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
        )
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
            ))
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
# See CONCEPTION.md §12.14/§13.1.8: a bundle is a directory (or, once zipped
# for sharing, a single file on the same principle as .stancz) holding a
# lightweight versioned project state plus content-addressed media, so audio
# and glTF terrain are never duplicated across saves.
#
#   MonShow.bundle/
#   |-- manifest.json
#   |-- media/<sha256>.<ext>
#   `-- versions/0001.json, 0002.json, latest -> NNNN.json (a copy, not a
#       symlink: Windows doesn't need admin rights to write a plain file)

_MEDIA_FIELDS = ("floor_image_path", "terrain_gltf_path", "audio_path")


def _sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _bundle_versions_dir(bundle_dir: str) -> str:
    return os.path.join(bundle_dir, "versions")


def _next_version_number(bundle_dir: str) -> int:
    versions_dir = _bundle_versions_dir(bundle_dir)
    if not os.path.isdir(versions_dir):
        return 1
    nums = []
    for name in os.listdir(versions_dir):
        stem, ext = os.path.splitext(name)
        if ext == ".json" and stem.isdigit():
            nums.append(int(stem))
    return (max(nums) + 1) if nums else 1


def save_bundle(project: Project, bundle_dir: str) -> str:
    """Write `project` as a new version inside `bundle_dir`, creating the
    bundle layout if needed. Returns the version file path written."""
    media_dir = os.path.join(bundle_dir, "media")
    os.makedirs(media_dir, exist_ok=True)
    versions_dir = _bundle_versions_dir(bundle_dir)
    os.makedirs(versions_dir, exist_ok=True)

    snapshot = project.to_dict()
    for field_name in _MEDIA_FIELDS:
        source_path = getattr(project, field_name)
        json_key = {
            "floor_image_path": "floorImagePath",
            "terrain_gltf_path": "terrainGltfPath",
            "audio_path": "audioPath",
        }[field_name]
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

    version_num = _next_version_number(bundle_dir)
    version_name = f"{version_num:04d}.json"
    version_path = os.path.join(versions_dir, version_name)
    with open(version_path, "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh, indent=2, ensure_ascii=False)

    latest_path = os.path.join(versions_dir, "latest.json")
    shutil.copyfile(version_path, latest_path)

    manifest_path = os.path.join(bundle_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump({
            "format": BUNDLE_FORMAT,
            "version": BUNDLE_VERSION,
            "projectName": project.name,
            "latestVersion": version_num,
        }, fh, indent=2, ensure_ascii=False)

    return version_path


def load_bundle(bundle_dir: str, version: Optional[int] = None) -> Project:
    """Load a project from a bundle directory. Defaults to the latest
    version; pass `version` to load an older snapshot explicitly."""
    manifest_path = os.path.join(bundle_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise ValueError(f"Not a Lumitrack bundle: {bundle_dir!r} has no manifest.json")
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("format") != BUNDLE_FORMAT:
        raise ValueError(f"Not a Lumitrack bundle: {bundle_dir!r}")

    versions_dir = _bundle_versions_dir(bundle_dir)
    version_name = f"{version:04d}.json" if version else "latest.json"
    version_path = os.path.join(versions_dir, version_name)
    with open(version_path, encoding="utf-8") as fh:
        snapshot = json.load(fh)

    for json_key in ("floorImagePath", "terrainGltfPath", "audioPath"):
        rel = snapshot.get(json_key)
        if rel:
            snapshot[json_key] = os.path.join(bundle_dir, rel.replace("/", os.sep))

    return Project.from_dict(snapshot)
