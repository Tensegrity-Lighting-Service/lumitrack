//! Parité moteur Rust ↔ moteur Python : la fixture est générée par le
//! moteur Python (tests/fixtures/parity.json, script dans le repo) — chaque
//! position résolue et chaque contexte de bloc doivent coïncider à 1e-6
//! près. Tant que ce test passe, le port n'a pas dévié de l'oracle.

use lumitrack_engine::model::Project;
use lumitrack_engine::timeline::{resolve_block_context, resolve_positions, TRAJECTORY_SAMPLES};
use serde_json::Value;

const EPS: f64 = 1e-6;

fn close(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() < EPS, "{what}: rust={a} python={b}");
}

#[test]
fn positions_and_block_contexts_match_python_oracle() {
    let raw = include_str!("fixtures/parity.json");
    let doc: Value = serde_json::from_str(raw).unwrap();
    let mut checked_positions = 0usize;
    let mut checked_entries = 0usize;

    for (ci, case) in doc["cases"].as_array().unwrap().iter().enumerate() {
        let project: Project = serde_json::from_value(case["project"].clone()).unwrap();

        // Les clés viennent de str(float) Python ("12000.0") : on les
        // parse plutôt que de reformater côté Rust (formats divergents).
        for (key, expected) in case["expectedPositions"].as_object().unwrap() {
            let t_ms: f64 = key.parse().unwrap();
            let got = resolve_positions(&project, t_ms);
            let exp_map = expected.as_object().unwrap();
            assert_eq!(
                got.len(), exp_map.len(),
                "case {ci} t={t_ms}: nombre de points positionnés"
            );
            for (pid, exp) in exp_map {
                let pose = got.get(pid).unwrap_or_else(|| panic!("case {ci} t={t_ms}: {pid} manquant"));
                let e = exp.as_array().unwrap();
                close(pose.x_cm, e[0].as_f64().unwrap(), &format!("case {ci} t={t_ms} {pid}.x"));
                close(pose.y_cm, e[1].as_f64().unwrap(), &format!("case {ci} t={t_ms} {pid}.y"));
                close(pose.z_cm, e[2].as_f64().unwrap(), &format!("case {ci} t={t_ms} {pid}.z"));
                close(pose.yaw_deg, e[3].as_f64().unwrap(), &format!("case {ci} t={t_ms} {pid}.yaw"));
                checked_positions += 1;
            }
        }

        for (cue_id, exp_entries) in case["expectedBlockContexts"].as_object().unwrap() {
            let got = resolve_block_context(&project, cue_id, TRAJECTORY_SAMPLES).unwrap();
            let exp_map = exp_entries.as_object().unwrap();
            assert_eq!(got.len(), exp_map.len(), "case {ci} cue {cue_id}: nb d'entrées");
            for (pid, exp) in exp_map {
                let entry = &got[pid];
                for (name, got_pose, exp_pose) in [
                    ("startPose", entry.start_pose, &exp["startPose"]),
                    ("targetPose", entry.target_pose, &exp["targetPose"]),
                ] {
                    match (got_pose, exp_pose.as_array()) {
                        (None, None) => {}
                        (Some(g), Some(e)) => {
                            for k in 0..4 {
                                close(g[k], e[k].as_f64().unwrap(),
                                      &format!("case {ci} {cue_id} {pid}.{name}[{k}]"));
                            }
                        }
                        (g, e) => panic!("case {ci} {cue_id} {pid}.{name}: rust={g:?} python={e:?}"),
                    }
                }
                let exp_path = exp["path"].as_array().unwrap();
                assert_eq!(entry.path.len(), exp_path.len(),
                           "case {ci} {cue_id} {pid}: longueur de path");
                for (k, (g, e)) in entry.path.iter().zip(exp_path).enumerate() {
                    let e = e.as_array().unwrap();
                    for a in 0..3 {
                        close(g[a], e[a].as_f64().unwrap(),
                              &format!("case {ci} {cue_id} {pid}.path[{k}][{a}]"));
                    }
                }
                for axis in ["x", "y", "z", "yaw"] {
                    let exp_src = exp["sources"][axis].as_str().map(|s| s.to_string());
                    assert_eq!(entry.sources[axis], exp_src,
                               "case {ci} {cue_id} {pid}.sources.{axis}");
                }
                checked_entries += 1;
            }
        }
    }
    println!("parité : {checked_positions} positions + {checked_entries} entrées de contexte identiques");
    assert!(checked_positions > 300, "fixture trop pauvre");
}
