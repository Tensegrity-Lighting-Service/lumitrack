//! Modèle de données — port de `core/project.py` (Project/Point/Cue/
//! Activation). La sérialisation serde reproduit le format fil camelCase
//! déjà utilisé entre le sidecar Python et le frontend (types.ts) : les
//! bundles .bundle/versions/NNNN.json existants restent lisibles tels quels.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub number: Option<i64>,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub psn_tracker_id: Option<u16>,
    #[serde(default)]
    pub default_height_cm: f64,
    /// Zone backstage d'attache (mission backstage) — None = première zone.
    #[serde(default)]
    pub home_zone_id: Option<String>,
    /// Point de focus (mission "modes d'orientation", 2026-08-04) : simple
    /// repère de visée, jamais placé en coulisse (backstage_slot) — DOIT
    /// être mirroré, contrairement à roster_group_id/default_orientation_mode
    /// ci-dessus (conventions d'édition pures que la résolution ne lit
    /// jamais, absentes de ce struct exprès).
    #[serde(default)]
    pub is_focus_point: bool,
}

fn default_color() -> String { "#4F6DF5".to_string() }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    #[serde(default)]
    pub target_x_cm: Option<f64>,
    #[serde(default)]
    pub target_y_cm: Option<f64>,
    #[serde(default)]
    pub target_z_cm: Option<f64>,
    #[serde(default = "default_fade_ms")]
    pub fade_ms: f64,
    #[serde(default = "default_easing")]
    pub easing: String,
    /// Courbes du graph editor, par axe ("x"/"y"/"z"/"yaw") — absentes,
    /// l'easing nommé s'applique (bundles existants inchangés).
    #[serde(default)]
    pub curves: Option<std::collections::HashMap<String, Vec<crate::curve::CurveNode>>>,
    /// Tracé spatial (motion path) — voir core/project.py. Tout à None =
    /// ligne droite.
    #[serde(default)]
    pub path_points: Option<Vec<crate::path::PathPoint>>,
    #[serde(default)]
    pub start_handle: Option<crate::path::Handle>,
    #[serde(default)]
    pub target_handle: Option<crate::path::Handle>,
    /// Mission "modes d'orientation" (2026-08-04, remplace la v1 du 08-01) :
    /// le lacet se règle en DEUX phases indépendantes — "en trajet" pendant
    /// le fondu, "à l'arrivée" pendant le maintien. Plus de mode "manual"
    /// animé en douceur : tout devient discret. Voir core/project.py
    /// (Activation) pour la doc complète de chaque champ.
    #[serde(default = "default_travel_orientation_mode")]
    pub travel_orientation_mode: String,
    #[serde(default)]
    pub travel_fixed_yaw_deg: f64,
    #[serde(default)]
    pub travel_focus_point_id: Option<String>,
    #[serde(default = "default_arrival_orientation_mode")]
    pub arrival_orientation_mode: String,
    #[serde(default)]
    pub arrival_fixed_yaw_deg: f64,
    #[serde(default)]
    pub arrival_focus_point_id: Option<String>,
    /// Temps de rotation (2026-08-05) : fondu du lacet aux transitions
    /// (entrée de fenêtre + bascule trajet→arrivée), plus court chemin
    /// angulaire, smoothstep. 0 = cut. Lu par la résolution → mirroré.
    #[serde(default)]
    pub yaw_turn_ms: f64,
    /// Mission "global vs sélectif" étendue à l'orientation (2026-08-04) :
    /// contrairement à fade_overridden (repère d'édition pur), CE champ EST
    /// lu au moment de la résolution (touches_orientation, cas de rotation
    /// pure sans x/y) — miroir nécessaire, exception documentée.
    #[serde(default)]
    pub orientation_overridden: bool,
    /// Mission "global vs sélectif", décalage de départ (2026-08-03) :
    /// cette activation démarre (et gouverne LTP) start_offset_ms après le
    /// début nominal du bloc — entrées en escalier/vague. 0 = comportement
    /// historique (démarre pile avec le bloc). Affecte la résolution de
    /// lecture (contrairement à fade_overridden, purement un repère
    /// d'édition côté sidecar — pas besoin de miroir ici).
    #[serde(default)]
    pub start_offset_ms: f64,
}

fn default_fade_ms() -> f64 { 1000.0 }
fn default_easing() -> String { "linear".to_string() }
fn default_travel_orientation_mode() -> String { "fixed".to_string() }
fn default_arrival_orientation_mode() -> String { "hold".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackstageZone {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub x_cm: f64,
    #[serde(default)]
    pub y_cm: f64,
    #[serde(default)]
    pub width_cm: f64,
    #[serde(default)]
    pub height_cm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub id: String,
    pub name: String,
    #[serde(default = "default_color")]
    pub color: String,
    pub start_ms: f64,
    pub duration_ms: f64,
    /// BTreeMap et non HashMap : ordre d'itération déterministe, comme le
    /// dict Python (ordre d'insertion) l'était de fait pour la résolution.
    #[serde(default)]
    pub activations: BTreeMap<String, Activation>,
    /// Piste de la timeline (placement libre des blocs) — sans effet sur la
    /// résolution, mais fait partie du format de projet.
    #[serde(default)]
    pub lane: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    #[serde(default = "default_stage_w")]
    pub stage_width_cm: f64,
    #[serde(default = "default_stage_h")]
    pub stage_height_cm: f64,
    #[serde(default)]
    pub audio_duration_s: Option<f64>,
    #[serde(default)]
    pub points: Vec<Point>,
    #[serde(default)]
    pub cues: Vec<Cue>,
    /// Zones backstage : points d'entrée/sortie des acteurs.
    #[serde(default)]
    pub backstage_zones: Vec<BackstageZone>,
}

fn default_stage_w() -> f64 { 5000.0 }
fn default_stage_h() -> f64 { 3000.0 }

impl Project {
    pub fn cue_by_id(&self, id: &str) -> Option<&Cue> {
        self.cues.iter().find(|c| c.id == id)
    }

    pub fn sort_cues(&mut self) {
        // Tri stable par start_ms — même sémantique LTP de fait que le tri
        // Python (deux cues au même instant gardent leur ordre d'insertion,
        // comportement accepté au verdict Mission 1 point d).
        self.cues.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap());
    }

    pub fn total_cue_ms(&self) -> f64 {
        self.cues
            .iter()
            .map(|c| c.start_ms + c.duration_ms)
            .fold(0.0, f64::max)
    }

    pub fn duration_ms(&self) -> f64 {
        match self.audio_duration_s {
            Some(s) if s > 0.0 => (s * 1000.0).max(self.total_cue_ms()),
            _ => self.total_cue_ms(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_format_is_camel_case_and_roundtrips() {
        let json = r#"{
            "name": "t", "stageWidthCm": 6000.0, "stageHeightCm": 4000.0,
            "points": [{"id": "p1", "name": "P1", "defaultHeightCm": 120.0}],
            "cues": [{
                "id": "A", "name": "A", "startMs": 0.0, "durationMs": 4000.0,
                "activations": {"p1": {"targetXCm": 1000.0, "fadeMs": 4000.0}}
            }]
        }"#;
        let p: Project = serde_json::from_str(json).unwrap();
        assert_eq!(p.points[0].default_height_cm, 120.0);
        let act = &p.cues[0].activations["p1"];
        assert_eq!(act.target_x_cm, Some(1000.0));
        assert_eq!(act.target_y_cm, None);
        assert_eq!(act.easing, "linear"); // défaut
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["cues"][0]["activations"]["p1"]["targetXCm"], 1000.0);
        assert_eq!(back["stageWidthCm"], 6000.0);
    }

    #[test]
    fn duration_is_max_of_audio_and_cues() {
        let mut p = Project {
            name: "t".into(), stage_width_cm: 0.0, stage_height_cm: 0.0,
            audio_duration_s: None, points: vec![], cues: vec![],
            backstage_zones: vec![],
        };
        p.cues.push(Cue {
            id: "A".into(), name: "A".into(), color: default_color(),
            start_ms: 1000.0, duration_ms: 4000.0, activations: BTreeMap::new(),
            lane: 0,
        });
        assert_eq!(p.duration_ms(), 5000.0);
        p.audio_duration_s = Some(120.0);
        assert_eq!(p.duration_ms(), 120_000.0);
        p.audio_duration_s = None;
        assert_eq!(p.duration_ms(), 5000.0);
    }
}
