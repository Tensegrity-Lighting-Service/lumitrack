"""Timecode: parsing/formatting, plus incoming timecode sources.

Two receivers are provided:

* :class:`ArtNetTimecodeReceiver` - listens for Art-Net ``OpTimeCode``
  (opcode 0x9700) on UDP 6454. No extra dependency.
* :class:`MidiTimecodeReceiver`   - decodes MTC quarter-frame and full-frame
  messages. Requires the optional ``mido`` + ``python-rtmidi`` packages.

Both push a callback ``(milliseconds: float, fps: float)`` on every update and
run on their own daemon thread, so the UI stays responsive.

LTC (audio timecode) is deliberately NOT implemented: it needs an audio input
and a decoder, and is best added once the rest is proven on a real show.
"""
from __future__ import annotations

import re
import socket
import struct
import threading
from typing import Callable, Optional

ARTNET_PORT = 6454
ARTNET_ID = b"Art-Net\x00"
OP_TIMECODE = 0x9700

#: Art-Net timecode type field -> frames per second
ARTNET_TC_RATES = {0: 24.0, 1: 25.0, 2: 29.97, 3: 30.0}


# ----------------------------------------------------------- formatting ----

_TC_RE = re.compile(r"^(?:(\d+):)?(?:(\d+):)?(\d+(?:[.,]\d+)?)$")


def parse_timecode(text: str) -> float:
    """Accept ``SS``, ``SS.mmm``, ``MM:SS``, ``HH:MM:SS`` (and comma decimals).
    Returns milliseconds. Raises ValueError on anything else."""
    text = (text or "").strip()
    m = _TC_RE.match(text)
    if not m:
        raise ValueError(f"Unrecognised timecode: {text!r}")
    groups = [g for g in m.groups() if g is not None]
    seconds = float(groups[-1].replace(",", "."))
    minutes = float(groups[-2]) if len(groups) >= 2 else 0.0
    hours = float(groups[-3]) if len(groups) >= 3 else 0.0
    return (hours * 3600 + minutes * 60 + seconds) * 1000.0


def format_timecode(ms: float, fps: Optional[float] = None) -> str:
    """``HH:MM:SS.mmm``, or ``HH:MM:SS:FF`` when fps is given."""
    ms = max(0.0, ms)
    total_s = ms / 1000.0
    h = int(total_s // 3600)
    m = int((total_s % 3600) // 60)
    if fps:
        s = int(total_s % 60)
        frames = int((total_s - int(total_s)) * fps)
        return f"{h:02d}:{m:02d}:{s:02d}:{frames:02d}"
    return f"{h:02d}:{m:02d}:{total_s % 60:06.3f}"


def hmsf_to_ms(h: int, m: int, s: int, f: int, fps: float) -> float:
    return ((h * 3600 + m * 60 + s) + (f / fps if fps else 0.0)) * 1000.0


# -------------------------------------------------------------- Art-Net ----

class ArtNetTimecodeReceiver:
    """Listens for Art-Net timecode packets and reports the position."""

    def __init__(self, callback: Callable[[float, float], None],
                 bind_ip: str = "0.0.0.0", port: int = ARTNET_PORT):
        self.callback = callback
        self.bind_ip = bind_ip
        self.port = port
        self._sock: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self.last_error: Optional[str] = None

    def start(self) -> bool:
        if self._running:
            return True
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._sock.settimeout(0.5)
            self._sock.bind((self.bind_ip, self.port))
        except OSError as exc:
            self.last_error = str(exc)
            self._sock = None
            return False
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return True

    def stop(self):
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    @property
    def running(self) -> bool:
        return self._running

    def _loop(self):
        while self._running and self._sock:
            try:
                data, _addr = self._sock.recvfrom(1024)
            except (socket.timeout, OSError):
                continue
            parsed = parse_artnet_timecode(data)
            if parsed is not None:
                ms, fps = parsed
                try:
                    self.callback(ms, fps)
                except Exception:  # never let a UI error kill the thread
                    pass


def parse_artnet_timecode(data: bytes):
    """Return ``(milliseconds, fps)`` for an Art-Net OpTimeCode packet, else None.

    Layout: ID[8] | OpCode u16 LE | ProtVer u16 BE | Filler[2] |
            Frames u8 | Seconds u8 | Minutes u8 | Hours u8 | Type u8
    """
    if len(data) < 19 or not data.startswith(ARTNET_ID):
        return None
    opcode = struct.unpack_from("<H", data, 8)[0]
    if opcode != OP_TIMECODE:
        return None
    frames, seconds, minutes, hours, tc_type = struct.unpack_from("<BBBBB", data, 14)
    fps = ARTNET_TC_RATES.get(tc_type, 25.0)
    return hmsf_to_ms(hours, minutes, seconds, frames, fps), fps


# ------------------------------------------------------------------ MTC ----

class MidiTimecodeReceiver:
    """Decodes MIDI Timecode. Optional: needs ``mido`` and ``python-rtmidi``.

    Quarter-frame messages arrive 4 per frame and encode the time in 8 nibbles;
    a full position is only complete every 2 frames, which is why the reported
    time is updated when the last nibble (piece 7) arrives.
    """

    MTC_RATES = {0: 24.0, 1: 25.0, 2: 29.97, 3: 30.0}

    def __init__(self, callback: Callable[[float, float], None], port_name: Optional[str] = None):
        self.callback = callback
        self.port_name = port_name
        self._port = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._nibbles = [0] * 8
        self.last_error: Optional[str] = None

    @staticmethod
    def available_ports():
        try:
            import mido  # noqa: PLC0415
            return mido.get_input_names()
        except Exception:
            return []

    @staticmethod
    def is_available() -> bool:
        try:
            import mido  # noqa: F401,PLC0415
            return True
        except Exception:
            return False

    def start(self) -> bool:
        if self._running:
            return True
        try:
            import mido  # noqa: PLC0415
            names = mido.get_input_names()
            name = self.port_name or (names[0] if names else None)
            if not name:
                self.last_error = "No MIDI input port available"
                return False
            self._port = mido.open_input(name)
            self.port_name = name
        except Exception as exc:
            self.last_error = str(exc)
            return False
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return True

    def stop(self):
        self._running = False
        if self._port:
            try:
                self._port.close()
            except Exception:
                pass
            self._port = None

    @property
    def running(self) -> bool:
        return self._running

    def _loop(self):
        while self._running and self._port:
            for msg in self._port.iter_pending():
                self._handle(msg)
            threading.Event().wait(0.002)

    def _handle(self, msg):
        if msg.type == "quarter_frame":
            self._nibbles[msg.frame_type] = msg.frame_value
            if msg.frame_type == 7:
                self._emit_from_nibbles()
        elif msg.type == "sysex":
            self._handle_full_frame(msg)

    def _emit_from_nibbles(self):
        n = self._nibbles
        frames = n[0] | (n[1] << 4)
        seconds = n[2] | (n[3] << 4)
        minutes = n[4] | (n[5] << 4)
        hours_raw = n[6] | (n[7] << 4)
        hours = hours_raw & 0x1F
        fps = self.MTC_RATES.get((hours_raw >> 5) & 0x03, 25.0)
        self._safe_callback(hmsf_to_ms(hours, minutes, seconds, frames, fps), fps)

    def _handle_full_frame(self, msg):
        d = list(msg.data)
        # F0 7F <dev> 01 01 hh mm ss ff F7  -> data excludes F0/F7
        if len(d) >= 8 and d[0] == 0x7F and d[2] == 0x01 and d[3] == 0x01:
            hours_raw, minutes, seconds, frames = d[4], d[5], d[6], d[7]
            hours = hours_raw & 0x1F
            fps = self.MTC_RATES.get((hours_raw >> 5) & 0x03, 25.0)
            self._safe_callback(hmsf_to_ms(hours, minutes, seconds, frames, fps), fps)

    def _safe_callback(self, ms: float, fps: float):
        try:
            self.callback(ms, fps)
        except Exception:
            pass
