//! Courbes du graph editor — port de `core/timeline.py::eval_curve` /
//! `axis_progress`. Une courbe = nœuds {t, v, poignées Bézier absolues,
//! mode} triés par t ; chaque segment est une Bézier cubique dont l'abscisse
//! (temps) est résolue par bissection, poignées serrées dans [t0, t3] comme
//! CSS cubic-bezier. Identité au moteur Python vérifiée par la fixture de
//! parité (projets à courbes).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CurveNode {
    #[serde(default)]
    pub t: f64,
    #[serde(default)]
    pub v: f64,
    #[serde(default)]
    pub in_t: Option<f64>,
    #[serde(default)]
    pub in_v: Option<f64>,
    #[serde(default)]
    pub out_t: Option<f64>,
    #[serde(default)]
    pub out_v: Option<f64>,
    #[serde(default)]
    pub mode: Option<String>,
}

fn bezier_component(p0: f64, p1: f64, p2: f64, p3: f64, s: f64) -> f64 {
    let m = 1.0 - s;
    m * m * m * p0 + 3.0 * m * m * s * p1 + 3.0 * m * s * s * p2 + s * s * s * p3
}

/// Port de `eval_curve` : progrès (v) à la fraction de temps u. Défensif :
/// moins de 2 nœuds -> identité (clampée [0,1]).
pub fn eval_curve(nodes: &[CurveNode], u: f64) -> f64 {
    if nodes.len() < 2 {
        return u.clamp(0.0, 1.0);
    }
    let mut pts: Vec<&CurveNode> = nodes.iter().collect();
    pts.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    let u = u.clamp(pts[0].t, pts[pts.len() - 1].t);
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (t0, t3) = (a.t, b.t);
        if !(t0 <= u && u <= t3) {
            continue;
        }
        let (v0, v3) = (a.v, b.v);
        if t3 <= t0 {
            return v3;
        }
        let t1 = a.out_t.map_or(t0 + (t3 - t0) / 3.0, |t| t.clamp(t0, t3));
        let v1 = a.out_v.unwrap_or(v0 + (v3 - v0) / 3.0);
        let t2 = b.in_t.map_or(t3 - (t3 - t0) / 3.0, |t| t.clamp(t0, t3));
        let v2 = b.in_v.unwrap_or(v3 - (v3 - v0) / 3.0);
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        for _ in 0..48 {
            let mid = (lo + hi) / 2.0;
            if bezier_component(t0, t1, t2, t3, mid) < u {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let s = (lo + hi) / 2.0;
        return bezier_component(v0, v1, v2, v3, s);
    }
    pts[pts.len() - 1].v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(t: f64, v: f64, out_t: Option<f64>, out_v: Option<f64>,
            in_t: Option<f64>, in_v: Option<f64>) -> CurveNode {
        CurveNode { t, v, in_t, in_v, out_t, out_v, mode: None }
    }

    /// Oracle : test_core.py::test_eval_curve_linear_is_identity.
    #[test]
    fn linear_curve_is_identity() {
        let c = vec![node(0.0, 0.0, None, None, None, None),
                     node(1.0, 1.0, None, None, None, None)];
        for u in [0.0, 0.25, 0.5, 0.99, 1.0] {
            assert!((eval_curve(&c, u) - u).abs() < 1e-6, "u={u}");
        }
    }

    /// Oracle : test_core.py::test_eval_curve_endpoints_and_monotonic_ease.
    #[test]
    fn ease_in_out_shape() {
        let c = vec![node(0.0, 0.0, Some(0.42), Some(0.0), None, None),
                     node(1.0, 1.0, None, None, Some(0.58), Some(1.0))];
        assert!(eval_curve(&c, 0.0).abs() < 1e-6);
        assert!((eval_curve(&c, 1.0) - 1.0).abs() < 1e-6);
        assert!(eval_curve(&c, 0.1) < 0.1);
        assert!(eval_curve(&c, 0.9) > 0.9);
        assert!((eval_curve(&c, 0.5) - 0.5).abs() < 1e-3);
    }

    /// Oracle : test_core.py::test_eval_curve_multi_node_with_overshoot.
    #[test]
    fn multi_node_overshoot() {
        let c = vec![node(0.0, 0.0, Some(0.1), Some(0.6), None, None),
                     node(0.5, 1.2, Some(0.65), Some(1.2), Some(0.35), Some(1.2)),
                     node(1.0, 1.0, None, None, Some(0.9), Some(1.0))];
        assert!((eval_curve(&c, 0.5) - 1.2).abs() < 1e-6);
        assert!(eval_curve(&c, 0.45) > 1.0);
        assert!((eval_curve(&c, 1.0) - 1.0).abs() < 1e-6);
    }

    /// Oracle : test_core.py::test_eval_curve_defensive.
    #[test]
    fn defensive_on_short_curves() {
        assert_eq!(eval_curve(&[], 0.4), 0.4);
        assert_eq!(eval_curve(&[CurveNode { t: 0.0, v: 5.0, ..Default::default() }], 0.4), 0.4);
    }
}
