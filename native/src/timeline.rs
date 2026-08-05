//! Résolution temporelle — port de `core/timeline.py` : quatre pistes
//! indépendantes (x, y, z, lacet) par point, LTP (§12.2), snap à la
//! première apparition (§7.7), et le contexte d'édition de bloc (§12.6).
//! Sémantique STRICTEMENT identique au Python — la suite pytest fait foi.

use crate::easing::apply_easing;
use crate::model::{Activation, Project};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Axis { X, Y, Z }

pub const AXES: [Axis; 3] = [Axis::X, Axis::Y, Axis::Z];

impl Axis {
    pub fn key(self) -> &'static str {
        match self { Axis::X => "x", Axis::Y => "y", Axis::Z => "z" }
    }
    fn value(self, act: &Activation) -> Option<f64> {
        match self {
            Axis::X => act.target_x_cm,
            Axis::Y => act.target_y_cm,
            Axis::Z => act.target_z_cm,
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

pub const BACKSTAGE_SPACING_CM: f64 = 60.0;

/// Port de `backstage_slot` : place de l'acteur dans sa zone (grille auto,
/// ordre du roster parmi les occupants de la même zone), None sans zone.
fn backstage_slot(project: &Project, point_id: &str) -> Option<(f64, f64)> {
    if project.backstage_zones.is_empty() {
        return None;
    }
    let default_id = project.backstage_zones[0].id.clone();
    let zone_of = |pt: &crate::model::Point| -> String {
        match &pt.home_zone_id {
            Some(id) if project.backstage_zones.iter().any(|z| &z.id == id) => id.clone(),
            _ => default_id.clone(),
        }
    };
    let me = project.points.iter().find(|p| p.id == point_id)?;
    // Un point de focus n'est qu'un repère de visée, pas un acteur réel : il
    // n'attend jamais en coulisse (mission "modes d'orientation", 2026-08-04).
    if me.is_focus_point {
        return None;
    }
    let my_zone_id = zone_of(me);
    let zone = project.backstage_zones.iter().find(|z| z.id == my_zone_id)?;
    // Exclut aussi les points de focus des occupants — sinon un point de
    // focus partageant la zone d'un acteur lui volerait une case dans la
    // grille sans jamais l'occuper lui-même (garde ci-dessus).
    let occupants: Vec<&str> = project.points.iter()
        .filter(|p| zone_of(p) == my_zone_id && !p.is_focus_point)
        .map(|p| p.id.as_str())
        .collect();
    let idx = occupants.iter().position(|id| *id == point_id)? as f64;
    let cols = ((zone.width_cm / BACKSTAGE_SPACING_CM).floor() as i64).max(1) as f64;
    let row = (idx / cols).floor();
    let col = idx - row * cols;
    Some((
        zone.x_cm + BACKSTAGE_SPACING_CM / 2.0 + col * BACKSTAGE_SPACING_CM,
        zone.y_cm + BACKSTAGE_SPACING_CM / 2.0 + row * BACKSTAGE_SPACING_CM,
    ))
}

/// Port de `_axis_keyframes` : un keyframe par cue dont l'activation de ce
/// point touche cet axe, trié par start_ms (tri stable). N'est plus jamais
/// appelé pour le lacet (mission "modes d'orientation", 2026-08-04) — voir
/// `orientation_keyframes`/`resolve_yaw`.
fn axis_keyframes<'a>(project: &'a Project, point_id: &str, axis: Axis) -> Vec<Keyframe<'a>> {
    let mut kfs: Vec<Keyframe<'a>> = project
        .cues
        .iter()
        .filter_map(|cue| {
            let act = cue.activations.get(point_id)?;
            let value = axis.value(act)?;
            // Décalage de départ (2026-08-03) : cette activation démarre
            // (et gouverne LTP) start_offset_ms après le début nominal du
            // bloc, pas exactement dessus — entrées en escalier/vague.
            let effective_start = cue.start_ms + act.start_offset_ms;
            Some(Keyframe {
                start_ms: effective_start,
                fade_end_ms: effective_start + act.fade_ms,
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
    resolve_axis_with_origin(kfs, t_ms, None)
}

fn resolve_axis_with_origin(kfs: &[Keyframe], t_ms: f64, first_origin: Option<f64>) -> Option<f64> {
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
    // Première apparition : depuis la zone backstage si fournie (entrée en
    // fondu, mission backstage) — sinon snap historique.
    let origin = if index == 0 {
        first_origin.unwrap_or(kf.value)
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

/// Port de `PATH_YAW_SAMPLE_MS` : demi-fenêtre (ms) utilisée pour échantillonner
/// x/y avant/après l'instant courant afin d'estimer la tangente du
/// déplacement en mode "path".
pub const PATH_YAW_SAMPLE_MS: f64 = 50.0;

/// Port de `touches_orientation` (project.py::Activation) : un déplacement
/// réel x/y gouverne l'orientation ; une activation de pure rotation (sans
/// x/y) ne la gouverne que si explicitement personnalisée. target_z_cm
/// exclu exprès (un changement de hauteur seul ne doit pas reprendre la
/// main sur le lacet).
fn touches_orientation(act: &Activation) -> bool {
    act.target_x_cm.is_some() || act.target_y_cm.is_some() || act.orientation_overridden
}

struct OrientationKeyframe<'a> {
    start_ms: f64,
    fade_end_ms: f64,
    act: &'a Activation,
    cue_id: String,
}

/// Port de `_orientation_keyframes` : un keyframe par cue dont l'activation
/// de ce point touche l'orientation, trié par start_ms. Plus de plafond
/// YAW_TURN_MS (mission "modes d'orientation", 2026-08-04) — le mode
/// "fixed" en trajet est déjà instantané par construction.
fn orientation_keyframes<'a>(project: &'a Project, point_id: &str) -> Vec<OrientationKeyframe<'a>> {
    let mut kfs: Vec<OrientationKeyframe<'a>> = project
        .cues
        .iter()
        .filter_map(|cue| {
            let act = cue.activations.get(point_id)?;
            if !touches_orientation(act) {
                return None;
            }
            let effective_start = cue.start_ms + act.start_offset_ms;
            Some(OrientationKeyframe {
                start_ms: effective_start,
                fade_end_ms: effective_start + act.fade_ms,
                act,
                cue_id: cue.id.clone(),
            })
        })
        .collect();
    kfs.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap());
    kfs
}

fn orientation_governing_index(kfs: &[OrientationKeyframe], t_ms: f64) -> Option<usize> {
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

/// Port de `_resolve_yaw` : lacet en DEUX phases indépendantes (mission
/// "modes d'orientation", 2026-08-04, remplace le régime unique "manual"/
/// "path"/"focus" du 2026-08-01) — "en trajet" pendant le fondu de
/// l'activation gouvernante, "à l'arrivée" une fois le fondu terminé.
/// `resolved_xy` est la position x/y déjà résolue de TOUS les points à cet
/// instant (calculée par `resolve_positions` en une première passe) —
/// nécessaire pour que le mode "focus" puisse viser un autre point sans
/// dépendre de son propre lacet. `kfs`, si fourni (par
/// `resolve_block_context`, pour évaluer la valeur qui gouvernait AVANT
/// qu'une activation "fixed" ne prenne le relais — LTP, comme x/y/z),
/// remplace le parcours complet des keyframes d'orientation du point.
fn resolve_yaw(
    project: &Project, point_id: &str, t_ms: f64, x: f64, y: f64,
    resolved_xy: &BTreeMap<String, (f64, f64)>,
    kfs: Option<&[OrientationKeyframe]>,
) -> f64 {
    let owned;
    let kfs: &[OrientationKeyframe] = match kfs {
        Some(k) => k,
        None => { owned = orientation_keyframes(project, point_id); &owned }
    };
    let Some(idx) = orientation_governing_index(kfs, t_ms) else { return 0.0 };
    let kf = &kfs[idx];
    let act = kf.act;

    let focus_angle = |focus_point_id: &Option<String>, fallback_deg: f64| -> f64 {
        let target = focus_point_id.as_ref().and_then(|id| resolved_xy.get(id));
        let Some(&(fx, fy)) = target else { return fallback_deg };
        if (fx - x).abs() < 1e-6 && (fy - y).abs() < 1e-6 {
            return fallback_deg;
        }
        (fy - y).atan2(fx - x).to_degrees()
    };

    let travel_value = |t_for_path: f64| -> f64 {
        match act.travel_orientation_mode.as_str() {
            "focus" => focus_angle(&act.travel_focus_point_id, act.travel_fixed_yaw_deg),
            "path" => {
                let kfs_x = axis_keyframes(project, point_id, Axis::X);
                let kfs_y = axis_keyframes(project, point_id, Axis::Y);
                // Origine backstage passée à la résolution (fix 2026-08-04,
                // "suivre la trajectoire ne marche pas") : sans elle, une
                // PREMIÈRE apparition snape sur sa cible — delta nul et le
                // lacet retombait sur l'angle fixe pendant toute l'entrée.
                let slot = backstage_slot(project, point_id);
                let sample_t = if kf.fade_end_ms > kf.start_ms {
                    t_for_path.min(kf.fade_end_ms - PATH_YAW_SAMPLE_MS)
                } else {
                    t_for_path
                }
                .max(kf.start_ms);
                let t0 = (sample_t - PATH_YAW_SAMPLE_MS).max(0.0);
                let t1 = sample_t + PATH_YAW_SAMPLE_MS;
                let (Some(x0), Some(y0), Some(x1), Some(y1)) =
                    (resolve_axis_with_origin(&kfs_x, t0, slot.map(|s| s.0)),
                     resolve_axis_with_origin(&kfs_y, t0, slot.map(|s| s.1)),
                     resolve_axis_with_origin(&kfs_x, t1, slot.map(|s| s.0)),
                     resolve_axis_with_origin(&kfs_y, t1, slot.map(|s| s.1)))
                else {
                    return act.travel_fixed_yaw_deg;
                };
                let (dx, dy) = (x1 - x0, y1 - y0);
                if dx.abs() < 1e-6 && dy.abs() < 1e-6 {
                    return act.travel_fixed_yaw_deg;
                }
                dy.atan2(dx).to_degrees()
            }
            // "fixed" (défaut — et repli sûr pour une valeur non reconnue).
            _ => act.travel_fixed_yaw_deg,
        }
    };

    if t_ms < kf.fade_end_ms {
        return travel_value(t_ms);
    }
    match act.arrival_orientation_mode.as_str() {
        "fixed" => act.arrival_fixed_yaw_deg,
        "focus" => focus_angle(&act.arrival_focus_point_id, act.arrival_fixed_yaw_deg),
        // "hold" (défaut — et repli sûr) : fige ce que le trajet avait
        // résolu PILE à l'instant où le fondu s'est terminé.
        _ => travel_value(kf.fade_end_ms),
    }
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
///
/// Deux passes (mission "modes d'orientation", 2026-08-04) : x/y/z pour
/// TOUS les points d'abord, puis le lacet de tous — requis car le mode
/// "focus" doit lire la position déjà résolue d'un AUTRE point au même
/// instant. Aucun risque de cycle : la position ne dépend jamais du lacet
/// d'un autre point.
pub fn resolve_positions(project: &Project, t_ms: f64) -> BTreeMap<String, Pose> {
    let mut result = BTreeMap::new();
    let mut resolved_xy: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    let mut needs_yaw: Vec<(String, f64, f64, f64)> = Vec::new();
    for point in &project.points {
        let kfs_x = axis_keyframes(project, &point.id, Axis::X);
        let kfs_y = axis_keyframes(project, &point.id, Axis::Y);
        let slot = backstage_slot(project, &point.id);
        let x = resolve_axis_with_origin(&kfs_x, t_ms, slot.map(|s| s.0));
        let y = resolve_axis_with_origin(&kfs_y, t_ms, slot.map(|s| s.1));
        let (Some(mut x), Some(mut y)) = (x, y) else {
            // Aucune activation démarrée : l'acteur vit dans sa zone.
            if let Some((sx, sy)) = slot {
                result.insert(point.id.clone(), Pose {
                    x_cm: sx, y_cm: sy,
                    z_cm: point.default_height_cm, yaw_deg: 0.0,
                });
                resolved_xy.insert(point.id.clone(), (sx, sy));
            }
            continue;
        };
        // Tracé spatial : même sémantique que le Python (même cue gouverne
        // x ET y, tracé présent, en plein fade, pas une première
        // apparition) — sinon résolution par axe inchangée.
        if let (Some(ix), Some(iy)) = (governing_index(&kfs_x, t_ms), governing_index(&kfs_y, t_ms)) {
            if kfs_x[ix].cue_id == kfs_y[iy].cue_id {
                let kf = &kfs_x[ix];
                if has_spatial_path(kf.act) && kf.fade_end_ms > kf.start_ms && t_ms < kf.fade_end_ms {
                    let ox = if ix > 0 {
                        resolve_axis(&kfs_x[..ix], kf.start_ms).unwrap_or(kfs_x[ix].value)
                    } else {
                        slot.map(|s| s.0).unwrap_or(kfs_x[ix].value)
                    };
                    let oy = if iy > 0 {
                        resolve_axis(&kfs_y[..iy], kf.start_ms).unwrap_or(kfs_y[iy].value)
                    } else {
                        slot.map(|s| s.1).unwrap_or(kfs_y[iy].value)
                    };
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
        let z = z.unwrap_or(point.default_height_cm);
        resolved_xy.insert(point.id.clone(), (x, y));
        needs_yaw.push((point.id.clone(), x, y, z));
    }
    for (point_id, x, y, z) in needs_yaw {
        let yaw_deg = resolve_yaw(project, &point_id, t_ms, x, y, &resolved_xy, None);
        result.insert(point_id, Pose { x_cm: x, y_cm: y, z_cm: z, yaw_deg });
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
        // Décalage de départ (2026-08-03) : l'instant où CETTE activation
        // démarre vraiment — tout ce qui suit interroge les autres tracks
        // à CET instant, pas au début nominal brut du bloc.
        let effective_start = cue.start_ms + act.start_offset_ms;

        let mut axis_start: BTreeMap<Axis, Option<f64>> = BTreeMap::new();
        let mut axis_target: BTreeMap<Axis, Option<f64>> = BTreeMap::new();
        let mut sources: BTreeMap<&'static str, Option<String>> = BTreeMap::new();

        for axis in AXES {
            let kfs = axis_keyframes(project, &point.id, axis);
            match axis.value(act) {
                None => {
                    // Axe non touché par ce bloc : il continue de suivre ce
                    // qui le gouverne au départ du bloc.
                    let resolved = resolve_axis(&kfs, effective_start);
                    axis_start.insert(axis, resolved);
                    axis_target.insert(axis, resolved);
                    sources.insert(axis.key(), None);
                }
                Some(value) => {
                    let index = kfs.iter().position(|kf| kf.cue_id == cue_id)
                        .expect("le cue touche cet axe donc il a un keyframe");
                    if index == 0 {
                        // 1re apparition : la trajectoire d'ENTRÉE part de
                        // la zone backstage quand l'acteur en a une.
                        let slot = backstage_slot(project, &point.id);
                        let start_v = match (slot, axis) {
                            (Some((sx, _)), Axis::X) => sx,
                            (Some((_, sy)), Axis::Y) => sy,
                            _ => value,
                        };
                        axis_start.insert(axis, Some(start_v));
                        sources.insert(axis.key(), None);
                    } else {
                        // Fix téléportation : départ = position résolue au
                        // démarrage du bloc, pas la cible brute du précédent.
                        let resolved = resolve_axis(&kfs[..index], effective_start)
                            .unwrap_or(kfs[index - 1].value);
                        axis_start.insert(axis, Some(resolved));
                        sources.insert(axis.key(), Some(kfs[index - 1].cue_id.clone()));
                    }
                    axis_target.insert(axis, Some(value));
                }
            }
        }

        // Le lacet est toujours dérivé (mission "modes d'orientation",
        // 2026-08-04 : plus de mode "manual" stocké) — jamais traité par la
        // boucle par axe ci-dessus (Axis n'a plus de variante Yaw). Un
        // éventuel point de focus référencé est cherché dans la résolution
        // GLOBALE du projet à cet instant (`resolved_xy_at`) — sa propre
        // position ne dépend jamais de ce bloc.
        let resolved_xy_at = |t: f64| -> BTreeMap<String, (f64, f64)> {
            resolve_positions(project, t).into_iter()
                .map(|(pid, pose)| (pid, (pose.x_cm, pose.y_cm)))
                .collect()
        };
        let kfs_orient = orientation_keyframes(project, &point.id);
        let orient_idx = kfs_orient.iter().position(|kf| kf.cue_id == cue_id);
        let sx = axis_start.get(&Axis::X).copied().flatten();
        let sy = axis_start.get(&Axis::Y).copied().flatten();
        let mut yaw_start: Option<f64> = None;
        let mut yaw_target: Option<f64> = None;
        if let (Some(idx), Some(sx), Some(sy)) = (orient_idx, sx, sy) {
            if idx == 0 || act.travel_orientation_mode != "fixed" {
                // Mode dérivé (path/focus) ou première apparition : pas de
                // notion de "valeur précédente" — la valeur EST celle de
                // cette activation elle-même à cet instant.
                yaw_start = Some(resolve_yaw(
                    project, &point.id, effective_start, sx, sy, &resolved_xy_at(effective_start), None));
            } else {
                // "fixed" : LTP comme x/y/z — la valeur qui gouvernait JUSTE
                // AVANT que cette activation ne prenne le relais.
                yaw_start = Some(resolve_yaw(
                    project, &point.id, effective_start, sx, sy, &resolved_xy_at(effective_start),
                    Some(&kfs_orient[..idx])));
            }
        }
        let tx = axis_target.get(&Axis::X).copied().flatten();
        let ty = axis_target.get(&Axis::Y).copied().flatten();
        if let (Some(_), Some(tx), Some(ty)) = (orient_idx, tx, ty) {
            let t_target = effective_start + act.fade_ms;
            yaw_target = Some(resolve_yaw(
                project, &point.id, t_target, tx, ty, &resolved_xy_at(t_target), None));
        }
        sources.insert("yaw", None);

        let pose_or_none = |values: &BTreeMap<Axis, Option<f64>>, yaw: Option<f64>| -> Option<[f64; 4]> {
            let x = values[&Axis::X]?;
            let y = values[&Axis::Y]?;
            let z = values[&Axis::Z].unwrap_or(point.default_height_cm);
            Some([x, y, z, yaw.unwrap_or(0.0)])
        };

        let start_pose = pose_or_none(&axis_start, yaw_start);
        let target_pose = pose_or_none(&axis_target, yaw_target);

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
                start_ms: effective_start,
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
            home_zone_id: None, is_focus_point: false,
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
            backstage_zones: Vec::new(),
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
        let yaw_only = Activation {
            orientation_overridden: true, travel_orientation_mode: "fixed".into(),
            travel_fixed_yaw_deg: 225.0, fade_ms: 0.0, ..Default::default()
        };
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

    /// Oracle : test_core.py::test_travel_fixed_yaw_is_instantaneous_not_animated
    /// — mission "modes d'orientation" (2026-08-04) : "fixed" en trajet
    /// bascule dès le premier instant de la fenêtre, aucune animation.
    #[test]
    fn travel_fixed_yaw_is_instantaneous_not_animated() {
        let snap = Activation {
            target_x_cm: Some(0.0), target_y_cm: Some(0.0),
            travel_orientation_mode: "fixed".into(), travel_fixed_yaw_deg: 0.0,
            fade_ms: 0.0, ..Default::default()
        };
        let mv = Activation {
            target_x_cm: Some(1000.0), target_y_cm: Some(0.0),
            travel_orientation_mode: "fixed".into(), travel_fixed_yaw_deg: 90.0,
            fade_ms: 4000.0, ..Default::default()
        };
        let p = project(vec![point("a")], vec![
            cue("c0", 0.0, vec![("a", snap)]),
            cue("c1", 1000.0, vec![("a", mv)]),
        ]);
        let just_after_start = resolve_positions(&p, 1001.0);
        assert!((just_after_start["a"].yaw_deg - 90.0).abs() < 1e-9);
        assert!((just_after_start["a"].x_cm - 0.25).abs() < 1e-9);
    }

    /// Oracle : test_core.py::test_arrival_hold_freezes_the_travel_value_at_fade_end
    #[test]
    fn arrival_hold_freezes_the_travel_value_at_fade_end() {
        let snap = Activation {
            target_x_cm: Some(0.0), target_y_cm: Some(0.0),
            travel_orientation_mode: "fixed".into(), travel_fixed_yaw_deg: 0.0,
            fade_ms: 0.0, ..Default::default()
        };
        let mv = Activation {
            target_x_cm: Some(100.0), target_y_cm: Some(0.0),
            travel_orientation_mode: "fixed".into(), travel_fixed_yaw_deg: 90.0,
            arrival_orientation_mode: "hold".into(),
            fade_ms: 1000.0, ..Default::default()
        };
        let p = project(vec![point("a")], vec![
            cue("c0", 0.0, vec![("a", snap)]),
            cue("c1", 1000.0, vec![("a", mv)]),
        ]);
        let long_after = resolve_positions(&p, 10_000.0);
        assert!((long_after["a"].yaw_deg - 90.0).abs() < 1e-9);
    }

    /// Oracle : test_core.py::test_arrival_fixed_is_independent_of_travel_fixed
    #[test]
    fn arrival_fixed_is_independent_of_travel_fixed() {
        let snap = Activation {
            target_x_cm: Some(0.0), target_y_cm: Some(0.0),
            travel_orientation_mode: "fixed".into(), travel_fixed_yaw_deg: 0.0,
            fade_ms: 0.0, ..Default::default()
        };
        let mv = Activation {
            target_x_cm: Some(100.0), target_y_cm: Some(0.0),
            travel_orientation_mode: "fixed".into(), travel_fixed_yaw_deg: 90.0,
            arrival_orientation_mode: "fixed".into(), arrival_fixed_yaw_deg: 200.0,
            fade_ms: 1000.0, ..Default::default()
        };
        let p = project(vec![point("a")], vec![
            cue("c0", 0.0, vec![("a", snap)]),
            cue("c1", 1000.0, vec![("a", mv)]),
        ]);
        let during_travel = resolve_positions(&p, 1500.0);
        let after_arrival = resolve_positions(&p, 3000.0);
        assert!((during_travel["a"].yaw_deg - 90.0).abs() < 1e-9);
        assert!((after_arrival["a"].yaw_deg - 200.0).abs() < 1e-9);
    }

    /// Oracle : test_core.py::test_orientation_mode_focus_points_at_fixed_target
    #[test]
    fn focus_points_at_a_synthesized_focus_point() {
        let mut focus_pt = point("f");
        focus_pt.is_focus_point = true;
        let a = Activation {
            target_x_cm: Some(0.0), target_y_cm: Some(0.0),
            travel_orientation_mode: "focus".into(), travel_focus_point_id: Some("f".into()),
            fade_ms: 0.0, ..Default::default()
        };
        let f = act(Some(0.0), Some(1000.0), 0.0);
        let p = project(vec![point("a"), focus_pt], vec![
            cue("c0", 0.0, vec![("a", a), ("f", f)]),
        ]);
        let pose = resolve_positions(&p, 500.0);
        assert!((pose["a"].yaw_deg - 90.0).abs() < 1e-6);
    }

    /// Oracle : test_core.py::test_focus_resolution_is_order_independent_across_points
    /// — B (la cible du focus) est déclaré APRÈS A qui le vise : la
    /// restructuration en 2 passes ne doit pas dépendre de l'ordre.
    #[test]
    fn focus_resolution_is_order_independent_across_points() {
        let a = Activation {
            target_x_cm: Some(0.0), target_y_cm: Some(0.0),
            travel_orientation_mode: "focus".into(), travel_focus_point_id: Some("b".into()),
            fade_ms: 0.0, ..Default::default()
        };
        let mut focus_pt = point("b");
        focus_pt.is_focus_point = true;
        let b = act(Some(1000.0), Some(0.0), 0.0);
        let p = project(vec![point("a"), focus_pt], vec![
            cue("c0", 0.0, vec![("a", a), ("b", b)]),
        ]);
        let pose = resolve_positions(&p, 0.0);
        assert!((pose["a"].yaw_deg - 0.0).abs() < 1e-6);
    }
}
