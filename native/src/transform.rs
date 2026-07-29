//! Transformation de sortie (cm scène -> mètres PSN) — port de
//! `core/timeline.py::OutputTransform`. Ordre des opérations identique :
//! origine, /100, inversions, puis swap.

#[derive(Debug, Clone)]
pub struct OutputTransform {
    pub origin_x_cm: f64,
    pub origin_y_cm: f64,
    pub invert_x: bool,
    pub invert_y: bool,
    pub swap_xy: bool,
    /// Convention d'axe vertical PSN : "y" = spec 2.03 officielle
    /// (hauteur en pos_y), "z" = héritage.
    pub up_axis: String,
}

impl Default for OutputTransform {
    fn default() -> Self {
        Self {
            origin_x_cm: 0.0, origin_y_cm: 0.0,
            invert_x: false, invert_y: false, swap_xy: false,
            up_axis: "y".to_string(),
        }
    }
}

impl OutputTransform {
    pub fn to_metres(&self, x_cm: f64, y_cm: f64, z_cm: f64) -> (f64, f64, f64) {
        let mut x = (x_cm - self.origin_x_cm) / 100.0;
        let mut y = (y_cm - self.origin_y_cm) / 100.0;
        let z = z_cm / 100.0;
        if self.invert_x { x = -x; }
        if self.invert_y { y = -y; }
        if self.swap_xy { std::mem::swap(&mut x, &mut y); }
        (x, y, z)
    }

    /// Port de `to_psn` : (pos_x, pos_y, pos_z) au sens de la spec 2.03 —
    /// « positive x is right, positive y is up, positive z is depth ».
    pub fn to_psn(&self, x_cm: f64, y_cm: f64, z_cm: f64) -> (f64, f64, f64) {
        let (x, y, h) = self.to_metres(x_cm, y_cm, z_cm);
        if self.up_axis == "y" { (x, h, y) } else { (x, y, h) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Oracle : test_core — centrage, inversion, swap (ordre des opérations).
    #[test]
    fn transform_order_matches_python() {
        let t = OutputTransform {
            origin_x_cm: 2500.0, origin_y_cm: 1500.0,
            invert_x: false, invert_y: true, swap_xy: true,
            ..Default::default()
        };
        // Python : x=(3000-2500)/100=5 ; y=(1000-1500)/100=-5 → invert_y → 5
        // puis swap → (5, 5). z inchangé /100.
        let (x, y, z) = t.to_metres(3000.0, 1000.0, 120.0);
        assert_eq!((x, y, z), (5.0, 5.0, 1.2));
    }
}

#[cfg(test)]
mod tests_psn_axis {
    use super::*;

    /// Oracle : spec PSN 2.03 p.8 — Y est l'axe vertical. La hauteur (z_cm)
    /// doit sortir en pos_y en convention officielle, en pos_z en héritage.
    #[test]
    fn up_axis_convention() {
        let y_up = OutputTransform::default();
        assert_eq!(y_up.to_psn(100.0, 200.0, 150.0), (1.0, 1.5, 2.0));
        let z_up = OutputTransform { up_axis: "z".into(), ..Default::default() };
        assert_eq!(z_up.to_psn(100.0, 200.0, 150.0), (1.0, 2.0, 1.5));
    }
}
