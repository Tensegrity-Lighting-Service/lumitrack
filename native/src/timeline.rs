//! Résolution temporelle — port de `core/timeline.py` : quatre pistes
//! indépendantes (x, y, z, lacet) par point, LTP (§12.2), snap à la
//! première apparition (§7.7), et le contexte d'édition de bloc (§12.6).
//! Sémantique STRICTEMENT identique au Python — la suite pytest fait foi.

use crate::easing::apply_easing;
use crate::model::{Activation, Project};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Axis { X, Y, Z, Yaw }

pub const AXES: [Axis; 4] = [Axis::X, Axis::Y, Axis::Z, Axis::Yaw];

impl Axis {
    pub fn key(self) -> &'static str {
        match self { Axis::X => "x", Axis::Y => "y", Axis::Z => "z", Axis::Yaw => "yaw" }
    }
    fn value(self, act: &Activation) -> Option<f64> {
        match self {
            Axis::X => act.target_x_cm,
            Axis::Y => act.target_y_cm,
            Axis::Z => act.target_z_cm,
            Axis::Yaw => act.target_yaw_deg,
        }
    }
}

#[derive(Debug, Clone)]
struct Keyframe<'a> {
    start_ms: f64,
    fade_end_ms: f64,
    value: f64,
    easing: String,
    curve: Option<Vec<crate::curve::CurveNode>>,
    act: &'a Activation,
    cue_id: String,
}

fn has_spatial_path(act: &Activation) -> bool {
    act.path_points.as_ref().is_some_and(|p| !p.is_empty())
        || act.start_handle.is_some()
        || act.target_handle.is_some()
}

/// Port de `axis_progress` : courbe de l'axe si présente, sinon easing.
fn act_axis_progress(act: &Activation, axis: Axis, progress: f64) -> f64 {
    if let Some(curves) = &act.curves {
        if let Some(nodes) = curves.get(axis.key()) {
            if !nodes.is_empty() {
                return crate::curve::eval_curve(nodes, progress.clamp(0.0, 1.0));
            }
        }
    }
    apply_easing(&act.easing, progress)
}

/// Port de `_axis_keyframes` : un keyframe par cue dont l'activation de ce
/// point touche cet axe, trié par start_ms (tri stable).
fn axis_keyframes<'a>(project: &'a Project, point_id: &str, axis: Axis) -> Vec<Keyframe<'a>> {
    let mut kfs: Vec<Keyframe<'a>> = project
        .cues
        .iter()
        .filter_map(|cue| {
            let act = cue.activations.get(point_id)?;
            let value = axis.value(act)?;
            Some(Keyframe {
                start_ms: cue.start_ms,
                fade_end_ms: cue.start_ms + act.fade_ms,
                value,
                easing: act.easing.clone(),
                curve: act.curves.as_ref()
                    .and_then(|c| c.get(axis.key()))
                    .filter(|nodes| !nodes.is_empty())
                    .cloned(),
                act,
                cue_id: cue.id.clone(),
            })
        })
        .collect();
    kfs.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap());
    kfs
}

/// Port de `_resolve_axis` : le keyframe gouvernant est le dernier démarré
/// à-ou-avant `t` (LTP) ; l'origine est la CIBLE du keyframe précédent —
/// y compris en plein chevauchement (fidèle au moteur de lecture).
/// Port de `_governing_index` : dernier keyframe démarré à-ou-avant t.
fn governing_index(kfs: &[Keyframe], t_ms: f64) -> Option<usize> {
    let mut idx = None;
    for (i, kf) in kfs.iter().enumerate() {
        if kf.start_ms <= t_ms {
            idx = Some(i);
        } else {
            break;
        }
    }
    idx
}

fn resolve_axis(kfs: &[Keyframe], t_ms: f64) -> Option<f64> {
    let mut governing: Option<(usize, &Keyframe)> = None;
    for (i, kf) in kfs.iter().enumerate() {
        if kf.start_ms <= t_ms {
            governing = Some((i, kf));
        } else {
            break;
        }
    }
    let (index, kf) = governing?;
    // Port du fix « téléportation » : l'origine est la position résolue à
    // l'instant du départ (chaîne des prédécesseurs), pas la cible brute du
    // keyframe précédent.
    let origin = if index == 0 {
        kf.value
    } else {
        resolve_axis(&kfs[..index], kf.start_ms).unwrap_or(kf.value)
    };
    if kf.fade_end_ms <= kf.start_ms || t_ms >= kf.fade_end_ms {
        return Some(kf.value);
    }
    let progress = (t_ms - kf.start_ms) / (kf.fade_end_ms - kf.start_ms);
    // Port de `axis_progress` : courbe personnalisée si présente, sinon
    // easing nommé.
    let eased = match &kf.curve {
        Some(nodes) => crate::curve::eval_curve(nodes, progress.clamp(0.0, 1.0)),
        None => apply_easing(&kf.easing, progress),
    };
    Some(origin + (kf.value - origin) * eased)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pose {
    pub x_cm: f64,
    pub y_cm: f64,
    pub z_cm: f64,
    pub yaw_deg: f64,
}

/// Port de `resolve_positions` : un point absent du résultat n'a pas de
/// position connue et ne doit JAMAIS être envoyé en PSN ni dessiné (§13.1.7,
/// pas de repli (0,0)). z/yaw absents → défauts du point.
pub fn resolve_positions(project: &Project, t_ms: f64) -> BTreeMap<String, Pose> {
    let mut result = BTreeMap::new();
    for point in &project.points {
        let kfs_x = axis_keyframes(project, &point.id, Axis::X);
        let kfs_y = axis_keyframes(project, &point.id, Axis::Y);
        let x = resolve_axis(&kfs_x, t_ms);
        let y = resolve_axis(&kfs_y, t_ms);
        let (Some(mut x), Some(mut y)) = (x, y) else { continue };
        // Tracé spatial : même sémantique que le Python (même cue gouverne
        // x ET y, tracé présent, en plein fade, pas une première
        // apparition) — sinon résolution par axe inchangée.
        if let (Some(ix), Some(iy)) = (governing_index(&kfs_x, t_ms), governing_index(&kfs_y, t_ms)) {
            if ix > 0 && iy > 0 && kfs_x[ix].cue_id == kfs_y[iy].cue_id {
                let kf = &kfs_x[ix];
                if has_spatial_path(kf.act) && kf.fade_end_ms > kf.start_ms && t_ms < kf.fade_end_ms {
                    let ox = resolve_axis(&kfs_x[..ix], kf.start_ms).unwrap_or(kfs_x[ix].value);
                    let oy = resolve_axis(&kfs_y[..iy], kf.start_ms).unwrap_or(kfs_y[iy].value);
                    let origin = (ox, oy);
                    let target = (kfs_x[ix].value, kfs_y[iy].value);
                    let progress = (t_ms - kf.start_ms) / (kf.fade_end_ms - kf.start_ms);
                    let eased = act_axis_progress(kf.act, Axis::X, progress);
                    let sp = crate::path::SpatialPath {
                        points: kf.act.path_points.as_deref().unwrap_or(&[]),
                        start_handle: kf.act.start_handle.as_ref(),
                        target_handle: kf.act.target_handle.as_ref(),
                    };
                    let (px, py) = crate::path::path_position(origin, &sp, target, eased);
                    x = px;
                    y = py;
                }
            }
        }
        let z = resolve_axis(&axis_keyframes(project, &point.id, Axis::Z), t_ms);
        let yaw = resolve_axis(&axis_keyframes(project, &point.id, Axis::Yaw), t_ms);
        result.insert(point.id.clone(), Pose {
            x_cm: x,
            y_cm: y,
            z_cm: z.unwrap_or(point.default_height_cm),
            yaw_deg: yaw.unwrap_or(0.0),
        });
    }
    result
}

// ---------------------------------------------------- block edit context ---

pub const TRAJECTORY_SAMPLES: usize = 24;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockEntry {
    pub start_pose: Option<[f64; 4]>,
    pub target_pose: Option<[f64; 4]>,
    pub path: Vec<[f64; 3]>,
    pub timing: Timing,
    /// Par axe ("x"/"y"/"z"/"yaw") : id du cue d'où la valeur de départ
    /// tracke, ou None (première apparition / axe non touché).
    pub sources: BTreeMap<&'static str, Option<String>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub start_ms: f64,
    pub fade_ms: f64,
    pub easing: String,
}

/// Port de `resolve_block_context` — même sémantique, mêmes cas limites.
pub fn resolve_block_context(
    project: &Project,
    cue_id: &str,
    samples: usize,
) -> Result<BTreeMap<String, BlockEntry>, String> {
    let cue = project
        .cue_by_id(cue_id)
        .ok_or_else(|| format!("Unknown cue id {cue_id:?}"))?;

    let mut entries = BTreeMap::new();
    for point in &project.points {
        let Some(act) = cue.activations.get(&point.id) else { continue };

        let mut axis_start: BTreeMap<Axis, Option<f64>> = BTreeMap::new();
        let mut axis_target: BTreeMap<Axis, Option<f64>> = BTreeMap::new();
        let mut sources: BTreeMap<&'static str, Option<String>> = BTreeMap::new();

        for axis in AXES {
            let kfs = axis_keyframes(project, &point.id, axis);
            match axis.value(act) {
                None => {
                    // Axe non touché par ce bloc : il continue de suivre ce
                    // qui le gouverne au départ du bloc.
                    let resolved = resolve_axis(&kfs, cue.start_ms);
                    axis_start.insert(axis, resolved);
                    axis_target.insert(axis, resolved);
                    sources.insert(axis.key(), None);
                }
                Some(value) => {
                    let index = kfs.iter().position(|kf| kf.cue_id == cue_id)
                        .expect("le cue touche cet axe donc il a un keyframe");
                    if index == 0 {
                        axis_start.insert(axis, Some(value)); // 1re apparition : snap
                        sources.insert(axis.key(), None);
                    } else {
                        // Fix téléportation : départ = position résolue au
                        // démarrage du bloc, pas la cible brute du précédent.
                        let resolved = resolve_axis(&kfs[..index], cue.start_ms)
                            .unwrap_or(kfs[index - 1].value);
                        axis_start.insert(axis, Some(resolved));
                        sources.insert(axis.key(), Some(kfs[index - 1].cue_id.clone()));
                    }
                    axis_target.insert(axis, Some(value));
                }
            }
        }

        let pose_or_none = |values: &BTreeMap<Axis, Option<f64>>| -> Option<[f64; 4]> {
            let x = values[&Axis::X]?;
            let y = values[&Axis::Y]?;
            let z = values[&Axis::Z].unwrap_or(point.default_height_cm);
            let yaw = values[&Axis::Yaw].unwrap_or(0.0);
            Some([x, y, z, yaw])
        };

        let start_pose = pose_or_none(&axis_start);
        let target_pose = pose_or_none(&axis_target);

        let mut path = Vec::new();
        if let (Some(s), Some(t)) = (start_pose, target_pose) {
            let curved = has_spatial_path(act);
            if s[..3] != t[..3] || curved {
                let sp = crate::path::SpatialPath {
                    points: act.path_points.as_deref().unwrap_or(&[]),
                    start_handle: act.start_handle.as_ref(),
                    target_handle: act.target_handle.as_ref(),
                };
                for i in 0..=samples {
                    let f = i as f64 / samples as f64;
                    let (px, py) = if curved {
                        crate::path::path_position((s[0], s[1]), &sp, (t[0], t[1]), f)
                    } else {
                        (s[0] + (t[0] - s[0]) * f, s[1] + (t[1] - s[1]) * f)
                    };
                    path.push([px, py, s[2] + (t[2] - s[2]) * f]);
                }
            }
        }

        entries.insert(point.id.clone(), BlockEntry {
            start_pose,
            target_pose,
            path,
            timing: Timing {
                start_ms: cue.start_ms,
                fade_ms: act.fade_ms,
                easing: act.easing.clone(),
            },
            sources,
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cue, Point};

    fn point(id: &str) -> Point {
        Point {
            id: id.into(), name: id.to_uppercase(), number: None,
            color: "#fff".into(), psn_tracker_id: None, default_height_cm: 0.0,
        }
    }

    fn act(x: Option<f64>, y: Option<f64>, fade_ms: f64) -> Activation {
        Activation { target_x_cm: x, target_y_cm: y, fade_ms, ..Default::default() }
    }

    fn cue(id: &str, start_ms: f64, acts: Vec<(&str, Activation)>) -> Cue {
        let mut activations = BTreeMap::new();
        for (pid, a) in acts { activations.insert(pid.to_string(), a); }
        Cue {
            id: id.into(), name: id.into(), color: "#fff".into(),
            start_ms, duration_ms: 1000.0, activations, lane: 0,
        }
    }

    fn project(points: Vec<Point>, mut cues_v: Vec<Cue>) -> Project {
        cues_v.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap());
        Project {
            name: "t".into(), stage_width_cm: 5000.0, stage_height_cm: 3000.0,
            audio_duration_s: None, points, cues: cues_v,
        }
    }

    /// Oracle : test_core — interpolation linéaire au milieu du fade,
    /// origine = cible du keyframe précédent.
    #[test]
    fn interpolates_from_previous_target() {
        let p = project(vec![point("p1")], vec![
            cue("A", 0.0, vec![("p1", act(Some(0.0), Some(0.0), 1000.0))]),
            cue("B", 5000.0, vec![("p1", act(Some(100.0), Some(200.0), 1000.0))]),
        ]);
        let poses = resolve_positions(&p, 5500.0);
        let pose = &poses["p1"];
        assert!((pose.x_cm - 50.0).abs() < 1e-9);
        assert!((pose.y_cm - 100.0).abs() < 1e-9);
    }

    /// Oracle : première apparition = snap direct sur la cible (§7.7).
    #[test]
    fn first_appearance_snaps() {
        let p = project(vec![point("p1")], vec![
            cue("A", 1000.0, vec![("p1", act(Some(300.0), Some(400.0), 2000.0))]),
        ]);
        let poses = resolve_positions(&p, 1100.0);
        assert_eq!(poses["p1"].x_cm, 300.0);
        // Avant le premier keyframe : aucune position connue.
        assert!(resolve_positions(&p, 500.0).is_empty());
    }

    /// Oracle : test_block_context — LTP, le dernier cue démarré gagne.
    #[test]
    fn ltp_latest_started_governs() {
        let p = project(vec![point("p1")], vec![
            cue("A", 0.0, vec![("p1", act(Some(100.0), Some(100.0), 1000.0))]),
            cue("B", 1000.0, vec![("p1", act(Some(300.0), Some(300.0), 1000.0))]),
            cue("C", 5000.0, vec![("p1", act(Some(900.0), Some(900.0), 1000.0))]),
        ]);
        let ctx = resolve_block_context(&p, "C", TRAJECTORY_SAMPLES).unwrap();
        let entry = &ctx["p1"];
        assert_eq!(entry.start_pose.unwrap()[0], 300.0);
        assert_eq!(entry.sources["x"], Some("B".to_string()));
    }

    /// Oracle : un bloc intermédiaire qui ne touche pas le point est sauté.
    #[test]
    fn skipped_by_unrelated_block() {
        let p = project(vec![point("p1"), point("p2")], vec![
            cue("A", 0.0, vec![("p1", act(Some(100.0), Some(200.0), 1000.0))]),
            cue("B", 5000.0, vec![("p2", act(Some(999.0), Some(999.0), 1000.0))]),
            cue("C", 10_000.0, vec![("p1", act(Some(700.0), Some(800.0), 1000.0))]),
        ]);
        let ctx = resolve_block_context(&p, "C", 4).unwrap();
        let entry = &ctx["p1"];
        assert_eq!(entry.start_pose.unwrap()[..2], [100.0, 200.0]);
        assert_eq!(entry.sources["x"], Some("A".to_string()));
        assert_eq!(entry.sources["y"], Some("A".to_string()));
    }

    /// Oracle : axes indépendants — un cue peut ne toucher que le lacet.
    #[test]
    fn axes_resolve_independently() {
        let yaw_only = Activation { target_yaw_deg: Some(225.0), fade_ms: 0.0, ..Default::default() };
        let p = project(vec![point("p1")], vec![
            cue("A", 0.0, vec![("p1", act(Some(100.0), Some(100.0), 0.0))]),
            cue("B", 1000.0, vec![("p1", yaw_only)]),
        ]);
        let poses = resolve_positions(&p, 2000.0);
        let pose = &poses["p1"];
        assert_eq!(pose.x_cm, 100.0); // position trackée, intouchée par B
        assert_eq!(pose.yaw_deg, 225.0);
        // Contexte de bloc : ghost sans trajectoire (pas de mouvement spatial).
        let ctx = resolve_block_context(&p, "B", 4).unwrap();
        assert!(ctx["p1"].path.is_empty());
        assert_eq!(ctx["p1"].target_pose.unwrap()[3], 225.0);
    }

    /// Oracle : chevauchement mi-fade — le départ est la cible du cue
    /// chevauché (fidèle à ce que le moteur jouera), pas sa valeur mi-fade.
    #[test]
    fn overlap_tracks_from_overlapped_target() {
        let p = project(vec![point("p1")], vec![
            cue("A", 0.0, vec![("p1", act(Some(0.0), Some(0.0), 1000.0))]),
            cue("B", 1000.0, vec![("p1", act(Some(1000.0), Some(0.0), 4000.0))]),
            cue("C", 2000.0, vec![("p1", act(Some(500.0), Some(500.0), 1000.0))]),
        ]);
        // Fix « téléportation » (2026-07-29) : C démarre à 2000 pendant le
        // fade de B (B : 0 -> 1000 sur 4000 ms, résolu à 2000 = 250). Le
        // départ affiché ET la lecture reprennent l'acteur là où il est.
        let ctx = resolve_block_context(&p, "C", 4).unwrap();
        assert!((ctx["p1"].start_pose.unwrap()[0] - 250.0).abs() < 1e-9);
        // Lecture : à t=2500 (mi-fade de C), 250 -> 500 => 375.
        let poses = resolve_positions(&p, 2500.0);
        assert!((poses["p1"].x_cm - 375.0).abs() < 1e-9);
    }

    /// Oracle : la polyline est purement spatiale, sans easing incorporé —
    /// le milieu géométrique reste le milieu arithmétique même en
    /// exponential.
    #[test]
    fn path_is_spatial_only() {
        let mut a = act(Some(0.0), Some(0.0), 1000.0);
        a.easing = "exponential".into();
        let mut b = act(Some(100.0), Some(0.0), 1000.0);
        b.easing = "exponential".into();
        let p = project(vec![point("p1")], vec![
            cue("A", 0.0, vec![("p1", a)]),
            cue("B", 5000.0, vec![("p1", b)]),
        ]);
        let ctx = resolve_block_context(&p, "B", 4).unwrap();
        let path = &ctx["p1"].path;
        assert_eq!(path.len(), 5);
        assert_eq!(path[2][0], 50.0);
    }

    #[test]
    fn unknown_cue_errors() {
        let p = project(vec![point("p1")], vec![]);
        assert!(resolve_block_context(&p, "nope", 4).is_err());
    }
}
