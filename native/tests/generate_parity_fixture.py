"""Régénère tests/fixtures/parity.json depuis le moteur Python (l'oracle).

À relancer depuis la racine du repo quand la sémantique du moteur Python
évolue :  PYTHONPATH=src python3 native/tests/generate_parity_fixture.py
Tant que `cargo test` passe sur la fixture fraîche, le port Rust est fidèle.
"""
import json, random, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))
from lumitrack.core.project import Project, Point, Cue, Activation
from lumitrack.core.timeline import resolve_positions, resolve_block_context

random.seed(20260728)

def rand_project(n_points, n_cues):
    p = Project(name="parity")
    p.points = [Point(id=f"p{i}", name=f"P{i}", default_height_cm=random.choice([0.0, 120.0]))
                for i in range(n_points)]
    easings = ["linear", "smooth", "ease-in", "ease-out", "bounce", "spring", "exponential"]
    for c in range(n_cues):
        cue = Cue(id=f"c{c}", name=f"C{c}",
                  start_ms=round(random.uniform(0, 20000), 1),
                  duration_ms=round(random.uniform(500, 6000), 1))
        for pt in p.points:
            if random.random() < 0.6:
                def maybe(lo, hi, prob=0.8):
                    return round(random.uniform(lo, hi), 1) if random.random() < prob else None
                cue.activations[pt.id] = Activation(
                    target_x_cm=maybe(-500, 5500),
                    target_y_cm=maybe(-500, 3500),
                    target_z_cm=maybe(0, 300, 0.3),
                    target_yaw_deg=maybe(-360, 720, 0.4),
                    fade_ms=round(random.uniform(0, 5000), 1),
                    easing=random.choice(easings),
                )
        p.cues.append(cue)
    p.sort_cues()
    return p

cases = []
for (np_, nc) in [(3, 4), (6, 8), (10, 12)]:
    proj = rand_project(np_, nc)
    times = sorted(round(random.uniform(0, 30000), 1) for _ in range(40))
    expected_positions = {}
    for t in times:
        poses = resolve_positions(proj, t)
        expected_positions[str(t)] = {
            pid: [pose.x_cm, pose.y_cm, pose.z_cm, pose.yaw_deg]
            for pid, pose in poses.items()
        }
    contexts = {cue.id: resolve_block_context(proj, cue.id)["entries"] for cue in proj.cues}
    cases.append({
        "project": proj.to_dict(),
        "times": times,
        "expectedPositions": expected_positions,
        "expectedBlockContexts": contexts,
    })

out = os.path.join(os.path.dirname(__file__), "fixtures", "parity.json")
with open(out, "w") as f:
    json.dump({"cases": cases}, f)
print("fixture écrite :", out)
