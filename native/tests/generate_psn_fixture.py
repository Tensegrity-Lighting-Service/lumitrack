"""Régénère tests/fixtures/psn_parity.json depuis l'encodeur Python (validé
pypsn). Timestamp figé par monkeypatch pour des octets déterministes.
Usage :  PYTHONPATH=src python3 native/tests/generate_psn_fixture.py"""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))
from lumitrack.core import psn
from unittest import mock

FIXED_MONOTONIC = 123.456789  # -> timestamp_us = 123456789

def trackers(n, unicode_names=False):
    out = []
    for i in range(n):
        name = f"Pointé {i} ✦" if unicode_names else f"Point {i}"
        out.append(psn.Tracker(id=i * 7 % 65536, name=name,
                               x_m=1.5 * i - 3.0, y_m=2.5 + 0.1 * i, z_m=0.01 * i,
                               ori_y=0.1 * i, ori_z=0.02 * i))
    return out

cases = []
with mock.patch("time.monotonic", return_value=FIXED_MONOTONIC):
    for n, uni in [(0, False), (1, False), (3, True), (92, False)]:
        ts = trackers(n, uni)
        cases.append({
            "n": n, "unicode": uni,
            "trackers": [{"id": t.id, "name": t.name, "x": t.x_m, "y": t.y_m,
                          "z": t.z_m, "oriX": t.ori_x, "oriY": t.ori_y,
                          "oriZ": t.ori_z} for t in ts],
            "data_hex": psn.build_data_packet(ts, frame_id=7, packet_count=2).hex(),
            "info_hex": psn.build_info_packet(ts, system_name="Lumitrack ✓", frame_id=7, packet_count=2).hex(),
            "split_data_hex": [p.hex() for p in psn.split_data_packets(ts, frame_id=9)],
            "split_info_hex": [p.hex() for p in psn.split_info_packets(ts, system_name="Lumitrack", frame_id=9)],
            "tiny_split_info_hex": [p.hex() for p in psn.split_info_packets(ts, system_name="s", frame_id=1, max_size=120)],
        })

out = os.path.join(os.path.dirname(__file__), "fixtures", "psn_parity.json")
with open(out, "w") as f:
    json.dump({"timestampUs": 123456789, "cases": cases}, f)
print("fixture écrite :", out)
