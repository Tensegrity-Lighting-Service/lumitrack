"""
Minimal PSN (PosiStageNet) v2 encoder + sender.

Byte layout reverse-engineered to match the `pypsn` parser exactly
(pypsn is battle-tested: used by BlenderDMX, PSN messages confirmed
recognized by grandMA3 2.1). Every chunk is:

    u16 chunk_id (LE)
    u16 length_field (LE)   -- bit15 = "has sub-chunks", bits0-14 = data length
    <data, `length` bytes>

PSN_DATA_PACKET (root chunk_id 0x6755):
    PSN_DATA_PACKET_HEADER (0x0000): u64 timestamp_us, u8 ver_hi, u8 ver_lo, u8 frame_id, u8 packet_count
    PSN_DATA_TRACKER_LIST  (0x0001): container of per-tracker chunks
        tracker chunk, chunk_id = tracker_id (0..0xFFFF):
            PSN_DATA_TRACKER_POS (0x0000): 3x f32 (x, y, z) in METERS

PSN_INFO_PACKET (root chunk_id 0x6756), sent at ~1Hz:
    PSN_INFO_PACKET_HEADER (0x0000): same 12-byte header
    PSN_INFO_SYSTEM_NAME   (0x0001): raw name bytes (no null terminator needed)
    PSN_INFO_TRACKER_LIST  (0x0002): container of per-tracker chunks
        tracker chunk, chunk_id = tracker_id:
            PSN_INFO_TRACKER_NAME (0x0000): raw name bytes
"""
from __future__ import annotations

import socket
import struct
import time
from dataclasses import dataclass
from typing import Iterable

PSN_DEFAULT_MCAST_IP = "236.10.10.10"
PSN_DEFAULT_PORT = 56565
PSN_MAX_PACKET_SIZE = 1500 - 28  # conservative UDP/IP overhead margin

CHUNK_ID_INFO_PACKET = 0x6756
CHUNK_ID_DATA_PACKET = 0x6755

INFO_PACKET_HEADER = 0x0000
INFO_SYSTEM_NAME = 0x0001
INFO_TRACKER_LIST = 0x0002
INFO_TRACKER_NAME = 0x0000

DATA_PACKET_HEADER = 0x0000
DATA_TRACKER_LIST = 0x0001
DATA_TRACKER_POS = 0x0000
DATA_TRACKER_ORI = 0x0002

HAS_SUBCHUNKS_FLAG = 0x8000


def _chunk(chunk_id: int, data: bytes, has_subchunks: bool) -> bytes:
    length_field = len(data) & 0x7FFF
    if has_subchunks:
        length_field |= HAS_SUBCHUNKS_FLAG
    return struct.pack("<HH", chunk_id, length_field) + data


def _header_bytes(frame_id: int, packet_count: int, version_high: int = 2, version_low: int = 0) -> bytes:
    timestamp_us = int(time.monotonic() * 1_000_000) & 0xFFFFFFFFFFFFFFFF
    return struct.pack("<QBBBB", timestamp_us, version_high, version_low, frame_id & 0xFF, packet_count & 0xFF)


@dataclass
class Tracker:
    id: int
    name: str
    x_m: float = 0.0
    y_m: float = 0.0
    z_m: float = 0.0
    # PSN_DATA_TRACKER_ORI est un VECTEUR AXE-ANGLE (spec 2.03 p.9 : axe de
    # rotation, longueur = angle en radians). Une rotation autour de la
    # verticale doit donc porter sur le composant de l'axe vertical de la
    # convention choisie : ori_y en convention officielle (Y-up), ori_z en
    # héritage Z-up. Le moteur (engine.build_trackers) choisit le composant.
    ori_x: float = 0.0
    ori_y: float = 0.0
    ori_z: float = 0.0


def build_data_packet(trackers: Iterable[Tracker], frame_id: int = 0,
                      packet_count: int = 1) -> bytes:
    header = _chunk(DATA_PACKET_HEADER, _header_bytes(frame_id, packet_count), has_subchunks=False)

    tracker_chunks = b""
    for t in trackers:
        pos_chunk = _chunk(DATA_TRACKER_POS, struct.pack("<fff", t.x_m, t.y_m, t.z_m), has_subchunks=False)
        ori_chunk = _chunk(DATA_TRACKER_ORI, struct.pack("<fff", t.ori_x, t.ori_y, t.ori_z), has_subchunks=False)
        tracker_chunks += _chunk(t.id, pos_chunk + ori_chunk, has_subchunks=True)

    tracker_list = _chunk(DATA_TRACKER_LIST, tracker_chunks, has_subchunks=True)
    body = header + tracker_list
    return _chunk(CHUNK_ID_DATA_PACKET, body, has_subchunks=True)


def build_info_packet(trackers: Iterable[Tracker], system_name: str = "lumitrack",
                      frame_id: int = 0, packet_count: int = 1) -> bytes:
    header = _chunk(INFO_PACKET_HEADER, _header_bytes(frame_id, packet_count), has_subchunks=False)
    name_chunk = _chunk(INFO_SYSTEM_NAME, system_name.encode("utf-8"), has_subchunks=False)

    tracker_chunks = b""
    for t in trackers:
        name = _chunk(INFO_TRACKER_NAME, t.name.encode("utf-8"), has_subchunks=False)
        tracker_chunks += _chunk(t.id, name, has_subchunks=True)

    tracker_list = _chunk(INFO_TRACKER_LIST, tracker_chunks, has_subchunks=True)
    body = header + name_chunk + tracker_list
    return _chunk(CHUNK_ID_INFO_PACKET, body, has_subchunks=True)


def _split_trackers(trackers: list, builder, frame_id: int, max_size: int):
    """Greedily pack trackers into as few packets as possible without exceeding
    max_size. A single tracker that is too big on its own still gets its own
    packet rather than being dropped."""
    groups = []
    chunk = []
    for t in trackers:
        chunk.append(t)
        if len(builder(chunk, frame_id)) > max_size:
            chunk.pop()
            if chunk:
                groups.append(chunk)
            chunk = [t]
    if chunk:
        groups.append(chunk)
    return groups


def split_data_packets(trackers: list, frame_id: int = 0, max_size: int = PSN_MAX_PACKET_SIZE):
    """PSN_DATA packets may need splitting across multiple UDP datagrams if the
    tracker list is large. packet_count tells receivers how many packets make
    up this frame."""
    groups = _split_trackers(trackers, build_data_packet, frame_id, max_size)
    count = max(1, len(groups))
    return [build_data_packet(g, frame_id, packet_count=count) for g in groups]


def split_info_packets(trackers: list, system_name: str = "lumitrack",
                       frame_id: int = 0, max_size: int = PSN_MAX_PACKET_SIZE):
    """Same splitting for PSN_INFO. With ~100 named trackers the info packet
    comfortably exceeds a 1500-byte MTU, so this is not optional."""
    def builder(chunk, fid):
        return build_info_packet(chunk, system_name, fid)

    groups = _split_trackers(trackers, builder, frame_id, max_size)
    count = max(1, len(groups))
    return [build_info_packet(g, system_name, frame_id, packet_count=count) for g in groups]


class PsnSender:
    def __init__(self, mcast_ip: str = PSN_DEFAULT_MCAST_IP, port: int = PSN_DEFAULT_PORT,
                 iface_ip: str = "0.0.0.0", ttl: int = 8):
        self.mcast_ip = mcast_ip
        self.port = port
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl)
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface_ip))
        self._frame_id = 0

    def send_data(self, trackers: list):
        for packet in split_data_packets(trackers, self._frame_id):
            self.sock.sendto(packet, (self.mcast_ip, self.port))
        self._frame_id = (self._frame_id + 1) & 0xFF

    def send_info(self, trackers: list, system_name: str = "lumitrack"):
        for packet in split_info_packets(trackers, system_name, self._frame_id):
            self.sock.sendto(packet, (self.mcast_ip, self.port))

    def close(self):
        self.sock.close()


if __name__ == "__main__":
    # Round-trip validation against the pypsn parser (proof of protocol compliance).
    import pypsn

    trackers = [Tracker(id=i, name=f"Point {i}", x_m=1.0 * i, y_m=2.5, z_m=0.0) for i in range(3)]

    data_bytes = build_data_packet(trackers, frame_id=7)
    decoded = pypsn.parse_psn_packet(data_bytes)
    print("Decoded DATA packet:")
    for tr in decoded.trackers:
        print(f"  id={tr.id} pos=({tr.pos.x}, {tr.pos.y}, {tr.pos.z})")
    assert len(decoded.trackers) == 3
    assert decoded.trackers[1].pos.x == 1.0 and decoded.trackers[1].pos.y == 2.5
    print("DATA packet round-trip OK")

    info_bytes = build_info_packet(trackers, system_name="test-system", frame_id=7)
    decoded_info = pypsn.parse_psn_packet(info_bytes)
    print("Decoded INFO packet:")
    print(f"  system name: {decoded_info.name}")
    for tr in decoded_info.trackers:
        print(f"  id={tr.tracker_id} name={tr.tracker_name}")
    assert decoded_info.name == b"test-system" or decoded_info.name == "test-system"
    assert len(decoded_info.trackers) == 3
    print("INFO packet round-trip OK")
