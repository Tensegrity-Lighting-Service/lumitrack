//! Transformation de sortie (cm scène -> mètres PSN) — port de
//! `core/timeline.py::OutputTransform`. Ordre des opérations identique :
//! origine, /100, inversions, puis swap.

#[derive(Debug, Clone, Default)]
pub struct OutputTransform {
    pub origin_x_cm: f64,
    pub origin_y_cm: f64,
    pub invert_x: bool,
    pub invert_y: bool,
    pub swap_xy: bool,
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
        };
        // Python : x=(3000-2500)/100=5 ; y=(1000-1500)/100=-5 → invert_y → 5
        // puis swap → (5, 5). z inchangé /100.
        let (x, y, z) = t.to_metres(3000.0, 1000.0, 120.0);
        assert_eq!((x, y, z), (5.0, 5.0, 1.2));
    }
}
