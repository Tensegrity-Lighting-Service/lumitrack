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
    # Zones backstage : 2 zones, attaches réparties, certains points sans
    # AUCUNE activation (couvre le repli slot + les entrées en fondu).
    p.backstage_zones = [
        {"id": "bsA", "name": "Jardin", "xCm": -500.0, "yCm": 0.0,
         "widthCm": 300.0, "heightCm": 900.0},
        {"id": "bsB", "name": "Cour", "xCm": 5600.0, "yCm": 500.0,
         "widthCm": 240.0, "heightCm": 600.0},
    ]
    for pt in p.points:
        pt.home_zone_id = random.choice(["bsA", "bsB", None])
        # ~15% de points de focus (mission "modes d'orientation", 2026-08-04)
        # — exerce la garde backstage_slot (jamais de place en coulisse, et
        # ne creuse jamais d'écart pour les vrais acteurs de la même zone).
        pt.is_focus_point = random.random() < 0.15
    easings = ["linear", "smooth", "ease-in", "ease-out", "bounce", "spring", "exponential"]

    def rand_curve():
        """Courbe du graph editor à 2-4 nœuds, poignées aléatoires (parfois
        absentes), overshoot possible — couvre le chemin eval_curve."""
        n = random.choice([2, 2, 3, 4])
        ts = sorted({0.0, 1.0, *(round(random.uniform(0.1, 0.9), 2) for _ in range(n - 2))})
        nodes = []
        for i, t in enumerate(ts):
            v = 0.0 if i == 0 else (1.0 if i == len(ts) - 1 else round(random.uniform(-0.2, 1.3), 2))
            def handle(direction):
                if random.random() < 0.3:
                    return None, None
                span = (ts[min(i + 1, len(ts) - 1)] - ts[max(i - 1, 0)]) or 0.3
                return (round(t + direction * random.uniform(0.0, span / 2), 3),
                        round(v + random.uniform(-0.4, 0.4), 3))
            in_t, in_v = handle(-1)
            out_t, out_v = handle(+1)
            nodes.append({"t": t, "v": v, "inT": in_t, "inV": in_v,
                          "outT": out_t, "outV": out_v,
                          "mode": random.choice(["smooth", "symmetric", "corner"])})
        return nodes

    def rand_path():
        """Tracé spatial : 1-3 waypoints, poignées parfois absentes."""
        wps = []
        for _ in range(random.randint(1, 3)):
            wps.append({
                "xCm": round(random.uniform(-500, 5500), 1),
                "yCm": round(random.uniform(-500, 3500), 1),
                "inDxCm": round(random.uniform(-300, 300), 1) if random.random() < 0.6 else None,
                "inDyCm": round(random.uniform(-300, 300), 1) if random.random() < 0.6 else None,
                "outDxCm": round(random.uniform(-300, 300), 1) if random.random() < 0.6 else None,
                "outDyCm": round(random.uniform(-300, 300), 1) if random.random() < 0.6 else None,
            })
        return wps

    def rand_handle():
        if random.random() < 0.5:
            return None
        return {"dxCm": round(random.uniform(-400, 400), 1),
                "dyCm": round(random.uniform(-400, 400), 1)}

    def rand_focus_ref():
        """~15% de références PENDANTES (id inexistant) — exerce le repli
        sur l'angle fixe de secours quand un point de focus a été
        supprimé. Sinon, un id de point du projet au hasard (focus ou
        acteur normal, voire le point lui-même — cas dégénéré fx==x/fy==y
        couvert aussi)."""
        if random.random() < 0.15:
            return "missing-focus-ref"
        return random.choice([pt.id for pt in p.points])

    for c in range(n_cues):
        cue = Cue(id=f"c{c}", name=f"C{c}",
                  start_ms=round(random.uniform(0, 20000), 1),
                  duration_ms=round(random.uniform(500, 6000), 1))
        for pt in p.points:
            if random.random() < 0.6:
                def maybe(lo, hi, prob=0.8):
                    return round(random.uniform(lo, hi), 1) if random.random() < prob else None
                # Mission "modes d'orientation" (2026-08-04, remplace la v1
                # du 08-01) : trajet et arrivée sont réglés indépendamment
                # — la fixture doit couvrir toutes les combinaisons, y
                # compris des références de focus par phase différentes.
                travel_mode = random.choices(["fixed", "path", "focus"], weights=[0.5, 0.25, 0.25])[0]
                arrival_mode = random.choices(["hold", "fixed", "focus"], weights=[0.5, 0.25, 0.25])[0]
                cue.activations[pt.id] = Activation(
                    target_x_cm=maybe(-500, 5500),
                    target_y_cm=maybe(-500, 3500),
                    target_z_cm=maybe(0, 300, 0.3),
                    fade_ms=round(random.uniform(0, 5000), 1),
                    easing=random.choice(easings),
                    # Décalage de départ (2026-08-03) : ~40 % des activations
                    # démarrent après le début nominal du bloc (entrées en
                    # escalier/vague), le reste garde le comportement
                    # historique (0).
                    start_offset_ms=round(random.uniform(0, 800), 1) if random.random() < 0.4 else 0.0,
                    # ~50% : couvre à la fois une activation de pure
                    # rotation qui gouverne quand même le lacet (overridden)
                    # et une qui reste "non touchée" (aucun x/y, non
                    # overridden — doit être invisible pour l'orientation).
                    orientation_overridden=random.random() < 0.5,
                    travel_orientation_mode=travel_mode,
                    travel_fixed_yaw_deg=round(random.uniform(-360, 720), 1),
                    travel_focus_point_id=rand_focus_ref() if travel_mode == "focus" else None,
                    arrival_orientation_mode=arrival_mode,
                    arrival_fixed_yaw_deg=round(random.uniform(-360, 720), 1),
                    arrival_focus_point_id=rand_focus_ref() if arrival_mode == "focus" else None,
                    # ~40 % des activations portent des courbes sur un
                    # sous-ensemble d'axes (le reste teste le repli easing).
                    # Plus d'axe "yaw" (mission "modes d'orientation") : le
                    # lacet n'est plus jamais résolu via une courbe/easing.
                    curves=({axis: rand_curve()
                             for axis in random.sample(["x", "y", "z"],
                                                       random.randint(1, 3))}
                            if random.random() < 0.4 else None),
                    # ~30 % de tracés spatiaux (waypoints/poignées) — le
                    # reste vérifie que la ligne droite reste identique.
                    path_points=rand_path() if random.random() < 0.3 else None,
                    start_handle=rand_handle() if random.random() < 0.25 else None,
                    target_handle=rand_handle() if random.random() < 0.25 else None,
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
