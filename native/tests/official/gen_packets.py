"""Écrit psn_packets.txt (entrée du harnais psn_validate) depuis la fixture
de parité PSN du repo."""
import json, os
fixture = os.path.join(os.path.dirname(__file__), "..", "fixtures", "psn_parity.json")
doc = json.load(open(fixture))
out = os.path.join(os.path.dirname(__file__), "psn_packets.txt")
with open(out, "w") as f:
    for case in doc["cases"]:
        if case["n"] not in (3, 92):
            continue
        for h in case["split_data_hex"]:
            f.write(f"DATA {h}\n")
        for h in case["split_info_hex"]:
            f.write(f"INFO {h}\n")
    for case in doc["cases"]:
        if case["n"] == 92:
            for t in case["trackers"]:
                f.write(f"EXPECT {t['id']} {t['x']} {t['y']} {t['z']} {t['yaw']} {t['name']}\n")
print("écrit :", out)
