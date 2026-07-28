//! Courbes d'easing — port de `core/timeline.py` (section easing).
//! Les alias français viennent de l'UI Stancz (hypothèse documentée §9.1).

pub fn linear(t: f64) -> f64 { t }

pub fn smooth(t: f64) -> f64 { t * t * (3.0 - 2.0 * t) }

pub fn ease_in(t: f64) -> f64 { t * t * t }

pub fn ease_out(t: f64) -> f64 { 1.0 - (1.0 - t).powi(3) }

pub fn bounce(t: f64) -> f64 {
    let (n1, d1) = (7.5625, 2.75);
    let mut t = t;
    if t < 1.0 / d1 {
        n1 * t * t
    } else if t < 2.0 / d1 {
        t -= 1.5 / d1;
        n1 * t * t + 0.75
    } else if t < 2.5 / d1 {
        t -= 2.25 / d1;
        n1 * t * t + 0.9375
    } else {
        t -= 2.625 / d1;
        n1 * t * t + 0.984375
    }
}

pub fn spring(t: f64) -> f64 {
    let c4 = (2.0 * std::f64::consts::PI) / 3.0;
    if t <= 0.0 { return 0.0; }
    if t >= 1.0 { return 1.0; }
    2f64.powf(-10.0 * t) * ((t * 10.0 - 0.75) * c4).sin() + 1.0
}

pub fn exponential(t: f64) -> f64 {
    if t <= 0.0 { return 0.0; }
    if t >= 1.0 { return 1.0; }
    2f64.powf(10.0 * t - 10.0)
}

/// Port de `apply_easing` : clamp [0,1], nom insensible à la casse, alias
/// français, repli linéaire pour tout nom inconnu.
pub fn apply_easing(name: &str, t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    let key = name.trim().to_lowercase();
    let key = match key.as_str() {
        "lineaire" | "linéaire" => "linear",
        "doux" | "ease" | "ease-in-out" => "smooth",
        "rebond" => "bounce",
        "ressort" => "spring",
        "exponentiel" => "exponential",
        other => other,
    }
    .to_string();
    match key.as_str() {
        "linear" => linear(t),
        "smooth" => smooth(t),
        "ease-in" => ease_in(t),
        "ease-out" => ease_out(t),
        "bounce" => bounce(t),
        "spring" => spring(t),
        "exponential" => exponential(t),
        _ => linear(t),
    }
}

pub const EASING_NAMES: [&str; 7] = [
    "linear", "smooth", "ease-in", "ease-out", "bounce", "spring", "exponential",
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Oracle : test_core.py::test_easing_bounds — chaque courbe vaut 0 en 0
    /// et 1 en 1, et reste bornée.
    #[test]
    fn easing_bounds() {
        for name in EASING_NAMES {
            assert!((apply_easing(name, 0.0) - 0.0).abs() < 1e-9, "{name}(0)");
            assert!((apply_easing(name, 1.0) - 1.0).abs() < 1e-9, "{name}(1)");
        }
    }

    #[test]
    fn clamps_outside_unit_interval() {
        assert_eq!(apply_easing("linear", -0.5), 0.0);
        assert_eq!(apply_easing("linear", 1.5), 1.0);
    }

    #[test]
    fn french_aliases_and_unknown_fallback() {
        assert_eq!(apply_easing("linéaire", 0.25), 0.25);
        assert_eq!(apply_easing("Rebond", 1.0), 1.0);
        // Nom inconnu → linéaire, jamais de panique.
        assert_eq!(apply_easing("wobble", 0.3), 0.3);
    }
}
