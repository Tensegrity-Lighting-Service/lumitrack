"""Data model for a choreography project, plus .stancz import.

Internal units are **centimetres** with the origin at the top-left of the
stage, matching Stancz's own convention. Conversion to metres for PSN happens
only at the output stage (see core.psn / core.transform).
"""
from __future__ import annotations

import json
import os
import tempfile
import zipfile
from dataclasses import dataclass, field, asdict
from typing import Optional

PROJECT_FORMAT = "Lumitrack"
PROJECT_VERSION = 1


@dataclass
class Point:
    """One controllable point. In this app a point is a lighting fixture
    carried by an operator, not a dancer."""
    id: str
    name: str
    number: Optional[int] = None
    color: str = "#4F6DF5"
    psn_tracker_id: Optional[int] = None  # falls back to `number` when None

    def resolved_tracker_id(self, fallback_index: int) -> int:
        if self.psn_tracker_id is not None:
            return int(self.psn_tracker_id) & 0xFFFF
        if self.number is not None:
            return int(self.number) & 0xFFFF
        return fallback_index & 0xFFFF


@dataclass
class Formation:
    """A cue: target positions reached after `duration_ms`, following `easing`."""
    id: str
    name: str
    order: int
    duration_ms: float
    easing: str = "linear"
    positions: dict = field(default_factory=dict)  # point_id -> (x_cm, y_cm)


@dataclass
class Project:
    name: str = "Untitled"
    stage_width_cm: float = 5000.0
    stage_height_cm: float = 3000.0
    grid_size_cm: float = 50.0
    points: list = field(default_factory=list)      # list[Point]
    formations: list = field(default_factory=list)  # list[Formation], keep sorted by order
    floor_image_path: Optional[str] = None
    audio_path: Optional[str] = None
    audio_duration_s: Optional[float] = None
    bpm: Optional[float] = None
    # Offset between incoming timecode and project time zero.
    timecode_offset_ms: float = 0.0

    # ---------- helpers ----------

    def sort_formations(self):
        self.formations.sort(key=lambda f: f.order)

    def point_by_id(self, pid: str) -> Optional[Point]:
        for p in self.points:
            if p.id == pid:
                return p
        return None

    @property
    def total_formation_ms(self) -> float:
        return sum(f.duration_ms for f in self.formations)

    @property
    def duration_ms(self) -> float:
        if self.audio_duration_s:
            return max(self.audio_duration_s * 1000.0, self.total_formation_ms)
        return max(self.total_formation_ms, 1000.0)

    def next_order(self) -> int:
        return (max((f.order for f in self.formations), default=0)) + 10

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
            "audioPath": self.audio_path,
            "audioDurationS": self.audio_duration_s,
            "bpm": self.bpm,
            "timecodeOffsetMs": self.timecode_offset_ms,
            "points": [asdict(p) for p in self.points],
            "formations": [
                {
                    "id": f.id, "name": f.name, "order": f.order,
                    "durationMs": f.duration_ms, "easing": f.easing,
                    "positions": {k: list(v) for k, v in f.positions.items()},
                }
                for f in self.formations
            ],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Project":
        if d.get("format") != PROJECT_FORMAT:
            raise ValueError(f"Not a {PROJECT_FORMAT} project file")
        proj = cls(
            name=d.get("name", "Untitled"),
            stage_width_cm=float(d.get("stageWidthCm", 5000)),
            stage_height_cm=float(d.get("stageHeightCm", 3000)),
            grid_size_cm=float(d.get("gridSizeCm", 50)),
            floor_image_path=d.get("floorImagePath"),
            audio_path=d.get("audioPath"),
            audio_duration_s=d.get("audioDurationS"),
            bpm=d.get("bpm"),
            timecode_offset_ms=float(d.get("timecodeOffsetMs", 0.0)),
        )
        proj.points = [Point(**p) for p in d.get("points", [])]
        for f in d.get("formations", []):
            proj.formations.append(Formation(
                id=f["id"], name=f.get("name", ""), order=int(f.get("order", 0)),
                duration_ms=float(f.get("durationMs", 0)),
                easing=f.get("easing", "linear"),
                positions={k: (float(v[0]), float(v[1])) for k, v in f.get("positions", {}).items()},
            ))
        proj.sort_formations()
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
    + audio/). Positions are in cm, origin top-left; formation `duration` is
    the length of the segment leading INTO that formation.
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

        for f in raw.get("formations", []):
            positions = {
                p["dancerId"]: (float(p["x"]), float(p["y"]))
                for p in f.get("positions", [])
            }
            proj.formations.append(Formation(
                id=f["id"],
                name=f.get("name", ""),
                order=int(f.get("order", 0)),
                duration_ms=float(f.get("duration", 0.0)),
                easing=f.get("easing", "linear"),
                positions=positions,
            ))
        proj.sort_formations()

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
