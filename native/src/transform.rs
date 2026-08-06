//! Transformation de sortie (cm scène -> mètres PSN) — port de
//! `core/timeline.py::OutputTransform`. Ordre des opérations identique :
//! placement terrain (stage-map), origine/100, inversions, puis swap.

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
    /// Placement de la zone de jeu dans le terrain glTF (gizmo "Éditer la
    /// zone de jeu") — voir le commentaire étendu côté Python
    /// (`core/timeline.py::OutputTransform`) : fixé le 2026-07-31, une
    /// prévisu partageant le même terrain doit recevoir les positions dans
    /// ce même repère monde, pas dans le repère local de la zone. Défaut
    /// (0, 0, 0°) = identité, donc aucun changement pour un projet qui
    /// n'utilise pas cette poignée.
    pub stage_map_origin_x_m: f64,
    pub stage_map_origin_z_m: f64,
    pub stage_map_rotation_deg: f64,
    /// Logique de CENTRE (2026-08-06) : le repère stage-local est centré
    /// sur la zone de jeu — (0,0) = centre du plateau, stage_map_origin
    /// place ce centre, la rotation pivote autour. Dimensions à 0 =
    /// ancien comportement coin (tests unitaires purs).
    pub stage_width_cm: f64,
    pub stage_height_cm: f64,
}

impl Default for OutputTransform {
    fn default() -> Self {
        Self {
            origin_x_cm: 0.0, origin_y_cm: 0.0,
            invert_x: false, invert_y: false, swap_xy: false,
            up_axis: "y".to_string(),
            stage_map_origin_x_m: 0.0, stage_map_origin_z_m: 0.0,
            stage_map_rotation_deg: 0.0,
            stage_width_cm: 0.0, stage_height_cm: 0.0,
        }
    }
}

impl OutputTransform {
    pub fn to_metres(&self, x_cm: f64, y_cm: f64, z_cm: f64) -> (f64, f64, f64) {
        // Métres locales à la zone (repère du réglage fin origin_*_cm).
        let lx = (x_cm - self.stage_width_cm / 2.0 - self.origin_x_cm) / 100.0;
        let ly = (y_cm - self.stage_height_cm / 2.0 - self.origin_y_cm) / 100.0;
        let z = z_cm / 100.0;

        // Placement dans le repère monde du terrain : même transform
        // rotation+translation que `StageGroup`/`fit` côté Scene.tsx.
        let angle = self.stage_map_rotation_deg.to_radians();
        let (sin_a, cos_a) = angle.sin_cos();
        let mut x = self.stage_map_origin_x_m + lx * cos_a + ly * sin_a;
        let mut y = self.stage_map_origin_z_m + (-lx * sin_a + ly * cos_a);

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

#[cfg(test)]
mod tests_stage_map {
    use super::*;

    /// Oracle : test_core.py::test_stage_map_defaults_are_a_no_op — un
    /// projet qui ne touche jamais la poignée terrain (défauts 0,0,0°) doit
    /// voir la même sortie qu'avant ce fix.
    #[test]
    fn stage_map_defaults_are_a_no_op() {
        let t = OutputTransform { origin_x_cm: 2500.0, origin_y_cm: 1500.0, invert_y: true, ..Default::default() };
        let (x, y, z) = t.to_metres(3050.0, 3505.0, 180.0);
        assert!((x - 5.5).abs() < 1e-9);
        assert!((y - -20.05).abs() < 1e-9);
        assert!((z - 1.8).abs() < 1e-9);
    }

    /// Oracle : test_core.py::test_stage_centred_on_terrain_lands_at_terrain_origin
    /// — une zone de 9140x5500cm centrée sur le terrain doit voir son propre
    /// centre atterrir à l'origine du terrain, pas décalé d'une demi-largeur.
    #[test]
    fn stage_centred_on_terrain_lands_at_terrain_origin() {
        let t = OutputTransform { stage_map_origin_x_m: -45.7, stage_map_origin_z_m: -27.5, ..Default::default() };
        let (x, y, _z) = t.to_metres(4570.0, 2750.0, 0.0);
        assert!(x.abs() < 1e-6);
        assert!(y.abs() < 1e-6);
    }

    /// Oracle : test_core.py::test_stage_map_translation_matches_reported_point
    /// — le point réel qui a révélé le bug du 2026-07-31.
    #[test]
    fn stage_map_translation_matches_reported_point() {
        let t = OutputTransform { stage_map_origin_x_m: -45.7, stage_map_origin_z_m: -27.5, ..Default::default() };
        let (x, y, _z) = t.to_metres(8541.882904242537, 3640.696565453493, 0.0);
        assert!((x - 39.71882904242537).abs() < 1e-9);
        assert!((y - 8.90696565453493).abs() < 1e-9);
    }

    /// Oracle : test_core.py::test_stage_map_rotation_matches_frontend_convention
    /// — même convention de rotation que `toWorldX`/`toWorldZ` dans Scene.tsx.
    #[test]
    fn stage_map_rotation_matches_frontend_convention() {
        let t = OutputTransform { stage_map_rotation_deg: 90.0, ..Default::default() };
        let (x, y, _z) = t.to_metres(100.0, 0.0, 0.0); // 1m le long de +X local
        assert!(x.abs() < 1e-9);
        assert!((y - -1.0).abs() < 1e-9);
    }

    /// Oracle : test_core.py::test_centre_frame_puts_stage_centre_at_origin
    /// — logique de centre (2026-08-06) : avec les dimensions de la zone
    /// renseignées et tout le reste aux défauts, le CENTRE du plateau sort
    /// à (0,0) et un coin à (-w/2, -h/2).
    #[test]
    fn centre_frame_puts_stage_centre_at_origin() {
        let t = OutputTransform { stage_width_cm: 5000.0, stage_height_cm: 3000.0, ..Default::default() };
        let (x, y, _z) = t.to_metres(2500.0, 1500.0, 0.0);
        assert!(x.abs() < 1e-9 && y.abs() < 1e-9);
        let (x, y, _z) = t.to_metres(0.0, 0.0, 0.0);
        assert!((x - -25.0).abs() < 1e-9);
        assert!((y - -15.0).abs() < 1e-9);
    }

    /// Oracle : test_core.py::test_stage_map_folds_before_origin_invert_swap
    /// — origin/invert/swap restent un réglage fin par-dessus, pas un repère
    /// concurrent du placement terrain.
    #[test]
    fn stage_map_folds_before_origin_invert_swap() {
        let t = OutputTransform {
            stage_map_origin_x_m: 10.0, stage_map_origin_z_m: 5.0,
            invert_x: true, ..Default::default()
        };
        let (x, y, _z) = t.to_metres(100.0, 200.0, 0.0);
        assert!((x - -11.0).abs() < 1e-9);
        assert!((y - 7.0).abs() < 1e-9);
    }
}
