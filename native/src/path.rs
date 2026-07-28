//! Tracé spatial (motion path) — port de `core/timeline.py` (section tracé
//! spatial). Même algorithme, mêmes constantes : segments de Bézier
//! cubiques 2D (poignée absente -> tiers de corde), paramétrage par
//! longueur d'arc via table cumulative à PATH_LUT_STEPS pas par segment.

use serde::{Deserialize, Serialize};

pub const PATH_LUT_STEPS: usize = 24; // même valeur que PATH_LUT_STEPS Python

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PathPoint {
    pub x_cm: f64,
    pub y_cm: f64,
    #[serde(default)]
    pub in_dx_cm: Option<f64>,
    #[serde(default)]
    pub in_dy_cm: Option<f64>,
    #[serde(default)]
    pub out_dx_cm: Option<f64>,
    #[serde(default)]
    pub out_dy_cm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Handle {
    pub dx_cm: f64,
    pub dy_cm: f64,
}

pub struct SpatialPath<'a> {
    pub points: &'a [PathPoint],
    pub start_handle: Option<&'a Handle>,
    pub target_handle: Option<&'a Handle>,
}

type P2 = (f64, f64);

fn bezier2(p0: P2, p1: P2, p2: P2, p3: P2, s: f64) -> P2 {
    let m = 1.0 - s;
    let a = m * m * m;
    let b = 3.0 * m * m * s;
    let c = 3.0 * m * s * s;
    let d = s * s * s;
    (a * p0.0 + b * p1.0 + c * p2.0 + d * p3.0,
     a * p0.1 + b * p1.1 + c * p2.1 + d * p3.1)
}

fn segments(start: P2, path: &SpatialPath, target: P2) -> Vec<(P2, P2, P2, P2)> {
    let mut anchors: Vec<P2> = Vec::with_capacity(path.points.len() + 2);
    anchors.push(start);
    for wp in path.points {
        anchors.push((wp.x_cm, wp.y_cm));
    }
    anchors.push(target);

    let out_handle = |i: usize| -> P2 {
        let a = anchors[i];
        let b = anchors[i + 1];
        if i == 0 {
            if let Some(h) = path.start_handle {
                return (a.0 + h.dx_cm, a.1 + h.dy_cm);
            }
        } else {
            let wp = &path.points[i - 1];
            if let Some(dx) = wp.out_dx_cm {
                return (a.0 + dx, a.1 + wp.out_dy_cm.unwrap_or(0.0));
            }
        }
        (a.0 + (b.0 - a.0) / 3.0, a.1 + (b.1 - a.1) / 3.0)
    };
    let in_handle = |i: usize| -> P2 {
        let a = anchors[i];
        let b = anchors[i + 1];
        if i + 1 == anchors.len() - 1 {
            if let Some(h) = path.target_handle {
                return (b.0 + h.dx_cm, b.1 + h.dy_cm);
            }
        } else {
            let wp = &path.points[i];
            if let Some(dx) = wp.in_dx_cm {
                return (b.0 + dx, b.1 + wp.in_dy_cm.unwrap_or(0.0));
            }
        }
        (b.0 - (b.0 - a.0) / 3.0, b.1 - (b.1 - a.1) / 3.0)
    };

    (0..anchors.len() - 1)
        .map(|i| (anchors[i], out_handle(i), in_handle(i), anchors[i + 1]))
        .collect()
}

/// Port de `path_position` : position à la fraction de parcours p (0..1,
/// déjà passée par l'easing), à vitesse constante (longueur d'arc).
pub fn path_position(start: P2, path: &SpatialPath, target: P2, p: f64) -> P2 {
    let p = p.clamp(0.0, 1.0);
    let segs = segments(start, path, target);
    let mut pts: Vec<P2> = Vec::with_capacity(segs.len() * PATH_LUT_STEPS + 1);
    for seg in &segs {
        for i in 0..PATH_LUT_STEPS {
            pts.push(bezier2(seg.0, seg.1, seg.2, seg.3, i as f64 / PATH_LUT_STEPS as f64));
        }
    }
    pts.push(target);
    let mut lengths = Vec::with_capacity(pts.len());
    lengths.push(0.0f64);
    for w in pts.windows(2) {
        let d = (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1);
        lengths.push(lengths[lengths.len() - 1] + d);
    }
    let total = *lengths.last().unwrap();
    if total <= 0.0 {
        return target;
    }
    let goal = p * total;
    for i in 1..lengths.len() {
        if lengths[i] >= goal {
            let span = lengths[i] - lengths[i - 1];
            let f = if span > 0.0 { (goal - lengths[i - 1]) / span } else { 0.0 };
            let (a, b) = (pts[i - 1], pts[i]);
            return (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f);
        }
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Oracle : test_core.py::test_spatial_path_bends_through_waypoint.
    #[test]
    fn bends_through_waypoint_and_hits_endpoints() {
        let wp = vec![PathPoint { x_cm: 500.0, y_cm: 400.0, ..Default::default() }];
        let path = SpatialPath { points: &wp, start_handle: None, target_handle: None };
        let s = (0.0, 0.0);
        let t = (1000.0, 0.0);
        assert_eq!(path_position(s, &path, t, 0.0), (0.0, 0.0));
        assert_eq!(path_position(s, &path, t, 1.0), (1000.0, 0.0));
        let mid = path_position(s, &path, t, 0.5);
        assert!(mid.1 > 250.0, "mi-parcours courbé : {mid:?}");
    }

    /// Oracle : test_core.py::test_spatial_path_arc_length_uniform_speed.
    #[test]
    fn arc_length_gives_uniform_speed() {
        let wp = vec![PathPoint { x_cm: 500.0, y_cm: 400.0, ..Default::default() }];
        let path = SpatialPath { points: &wp, start_handle: None, target_handle: None };
        let s = (0.0, 0.0);
        let t = (1000.0, 0.0);
        let poses: Vec<_> = (0..=10).map(|i| path_position(s, &path, t, i as f64 / 10.0)).collect();
        let dists: Vec<f64> = poses.windows(2)
            .map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)).collect();
        let max = dists.iter().cloned().fold(f64::MIN, f64::max);
        let min = dists.iter().cloned().fold(f64::MAX, f64::min);
        assert!(max / min < 1.20, "ratio {}", max / min);
    }

    #[test]
    fn no_waypoints_is_straight_line() {
        let path = SpatialPath { points: &[], start_handle: None, target_handle: None };
        let mid = path_position((0.0, 0.0), &path, (100.0, 200.0), 0.5);
        assert!((mid.0 - 50.0).abs() < 1e-9 && (mid.1 - 100.0).abs() < 1e-9);
    }
}
