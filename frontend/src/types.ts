// Mirrors the JSON produced by src/lumitrack/sidecar.py and
// core/project.py Project.to_dict()/Point.to_dict()/Activation.to_dict().
// Keep in sync by hand — there is no shared schema yet (CONCEPTION.md
// §12.13 leaves packaging/protocol details unresolved).

export interface Point {
  id: string
  name: string
  number: number | null
  color: string
  psnTrackerId: number | null
  defaultHeightCm: number
  /** Zone backstage d'attache — null = première zone du projet. */
  homeZoneId: string | null
  /** Sous-groupe du roster (purement organisationnel, §12.2 non concerné) —
   * null = sans groupe. Au plus un groupe par acteur. */
  rosterGroupId: string | null
  /** Préremplit UNIQUEMENT les nouvelles activations de cet acteur (phase
   * TRAJET seulement — l'arrivée retombe toujours sur "hold") — aucune
   * autorité sur celles déjà réglées (DIRECTIVES.md point 5/6). Renommé de
   * defaultOrientationMode le 2026-08-04. */
  defaultTravelOrientationMode: 'fixed' | 'path' | 'focus'
  /** Simple repère de visée, pas un acteur réel — pas d'orientation propre,
   * jamais émis en PSN, jamais placé en coulisse (mission "modes
   * d'orientation", 2026-08-04). */
  isFocusPoint: boolean
}

/** Sous-groupe du roster — juste un nom, l'ordre/l'appartenance vivent sur
 * Point.rosterGroupId et l'ordre de Project.points. */
export interface RosterGroup {
  id: string
  name: string
}

/** Preset de montage de fixture (mission "modes d'orientation", phase D,
 * 2026-08-04) — catalogue PROJET, éditable/ajoutable (pas un enum codé en
 * dur). Complète tangage/roulis, dérivés du lacet déjà résolu au moment de
 * l'émission PSN (core/engine.py::apply_mount_preset) — jamais une nouvelle
 * timeline d'animation. */
export interface FixtureMountPreset {
  id: string
  name: string
  basePitchDeg: number
  baseRollDeg: number
  pitchTracksYaw: boolean
  rollTracksYaw: boolean
}

/** Zone backstage : rectangle nommé en coordonnées scène (souvent hors de
 * la zone de jeu) — point d'entrée/sortie des acteurs. */
export interface BackstageZone {
  id: string
  name: string
  xCm: number
  yCm: number
  widthCm: number
  heightCm: number
}

// Nœud de courbe du graph editor — même format que core/timeline.py
// eval_curve et native/src/curve.rs (poignées Bézier absolues).
export interface CurveNode {
  t: number
  v: number
  inT: number | null
  inV: number | null
  outT: number | null
  outV: number | null
  mode: 'smooth' | 'symmetric' | 'corner'
}

// Tracé spatial (motion path AE) : waypoint absolu + poignées relatives.
export interface PathPoint {
  xCm: number
  yCm: number
  inDxCm: number | null
  inDyCm: number | null
  outDxCm: number | null
  outDyCm: number | null
}

export interface PathHandle {
  dxCm: number
  dyCm: number
}

export interface Activation {
  targetXCm: number | null
  targetYCm: number | null
  targetZCm: number | null
  fadeMs: number
  /** "global vs sélectif" (2026-08-03) : fade_ms modifié à la main — sort du
   * recalcul de la durée automatique du bloc tant qu'il reste personnalisé. */
  fadeOverridden: boolean
  /** "global vs sélectif", décalage de départ (2026-08-03) : cette
   * activation démarre startOffsetMs après le début nominal du bloc — 0 =
   * comportement historique. Entrées en escalier/vague. */
  startOffsetMs: number
  easing: string
  /** Mission "modes d'orientation" (2026-08-04, remplace orientationMode/
   * targetYawDeg/focusXCm/focusYCm) : le lacet se règle en DEUX phases
   * indépendantes — "en trajet" pendant le fondu, "à l'arrivée" pendant le
   * maintien. Plus de mode animé en douceur ("manual") : tout est discret. */
  travelOrientationMode: 'fixed' | 'path' | 'focus'
  travelFixedYawDeg: number
  /** Id d'un Point(isFocusPoint=true) ; null si mode "focus" pas encore réglé. */
  travelFocusPointId: string | null
  arrivalOrientationMode: 'hold' | 'fixed' | 'focus'
  arrivalFixedYawDeg: number
  arrivalFocusPointId: string | null
  /** "global vs sélectif" étendu à l'orientation : marque une
   * personnalisation qui sort des défauts d'orientation du bloc (Cue,
   * mission "modes d'orientation") tant qu'elle reste personnalisée. */
  orientationOverridden: boolean
  /** Temps de rotation (2026-08-05) : durée (ms) du fondu du lacet aux
   * transitions (entrée de fenêtre + bascule trajet→arrivée), plus court
   * chemin angulaire. 0 = cut. */
  yawTurnMs: number
  /** Preset de montage de fixture, PAR ACTIVATION (recadrage 2026-08-04 :
   * "au niveau des acteurs dans les blocs, avec option ne rien changer") :
   * null = "ne rien changer" (le bloc ne touche pas le canal, le preset
   * gouvernant précédent continue, LTP) ; '' = "aucun preset" (efface la
   * correction) ; sinon FixtureMountPreset.id. Résolu à l'émission PSN
   * uniquement. */
  mountPresetId: string | null
  /** Courbes par axe (graph editor) ; axe absent = easing nommé. Plus
   * d'axe "yaw" depuis la mission "modes d'orientation" — le lacet n'est
   * plus jamais résolu via une courbe/easing. */
  curves?: Partial<Record<'x' | 'y' | 'z', CurveNode[]>> | null
  /** Tracé spatial : tout absent/null = ligne droite. */
  pathPoints?: PathPoint[] | null
  startHandle?: PathHandle | null
  targetHandle?: PathHandle | null
}

export interface Cue {
  id: string
  name: string
  color: string
  startMs: number
  durationMs: number
  /** Piste de la timeline (placement libre des blocs). */
  lane: number
  /** Quand actif, durationMs suit la distance/vitesse de référence du
   * projet au lieu d'être réglé à la main (recalculé par le backend). */
  autoDuration: boolean
  /** Réglage par défaut du BLOC pour l'orientation (mission "modes
   * d'orientation", 2026-08-04, même esprit que le timing point 6) : null =
   * pas encore réglé, chaque nouvelle activation du bloc retombe alors sur
   * Point.defaultTravelOrientationMode/"hold". */
  defaultTravelOrientationMode: 'fixed' | 'path' | 'focus' | null
  defaultTravelFixedYawDeg: number | null
  defaultTravelFocusPointId: string | null
  defaultArrivalOrientationMode: 'hold' | 'fixed' | 'focus' | null
  defaultArrivalFixedYawDeg: number | null
  defaultArrivalFocusPointId: string | null
  /** Preset orientation par défaut du bloc (2026-08-05) : null = jamais
   * réglé, '' = défaut explicite "ne rien changer", sinon id de preset. */
  defaultMountPresetId: string | null
  /** Temps de rotation par défaut du bloc (ms) — null = jamais réglé. */
  defaultYawTurnMs: number | null
  activations: Record<string, Activation>
}

export interface Project {
  format: string
  version: number
  name: string
  stageWidthCm: number
  stageHeightCm: number
  gridSizeCm: number
  floorImagePath: string | null
  terrainGltfPath: string | null
  audioPath: string | null
  audioDurationS: number | null
  bpm: number | null
  timecodeOffsetMs: number
  psnSystemName: string
  psnMcastIp: string
  psnPort: number
  transformOriginXCm: number
  transformOriginYCm: number
  transformInvertX: boolean
  transformInvertY: boolean
  transformSwapXy: boolean
  transformUpAxis: 'y' | 'z'
  psnIfaceIp: string
  psnRateHz: number
  stageMapOriginXM: number
  stageMapOriginZM: number
  stageMapRotationDeg: number
  terrainRotationDeg: number
  /** cm/s — durée des blocs en "durée automatique" (distance / vitesse). */
  referenceSpeedCms: number
  /** Diamètre du marqueur d'acteur dans la scène (cm) — purement visuel. */
  actorDiameterCm: number
  backstageZones: BackstageZone[]
  rosterGroups: RosterGroup[]
  fixtureMountPresets: FixtureMountPreset[]
  points: Point[]
  cues: Cue[]
}

/** [x_cm, y_cm, z_cm, yaw_deg] */
export type Pose = [number, number, number, number]

export interface ProjectMessage {
  type: 'project'
  project: Project
  psnRunning: boolean
  /** Historique d'édition côté sidecar (undo/redo, backend-autoritaire) —
   * pilote l'état grisé du menu Édition et des raccourcis Ctrl+Z. */
  undoAvailable: boolean
  redoAvailable: boolean
}

export interface TickMessage {
  type: 'tick'
  tMs: number
  playing: boolean
  durationMs: number
  positions: Record<string, Pose>
}

// Block-edit context (§12.6): everything the scene needs to display a
// selected cue's targets and static trajectories. `path` is pure spatial
// geometry (uniform-parameter samples, no easing baked in); `timing` is
// what maps time onto it — kept separate on purpose (§13.1.11). All values
// are resolved by the backend; the frontend never interpolates.
export interface TrajectoryTiming {
  startMs: number
  fadeMs: number
  easing: string
}

export interface BlockContextEntry {
  /** Where the point really tracks from (last cue that touched each axis),
   * or null if it has no known position when the block starts. */
  startPose: Pose | null
  targetPose: Pose | null
  /** [x_cm, y_cm, z_cm][] — empty when there is no spatial movement. */
  path: [number, number, number][]
  timing: TrajectoryTiming
  /** Per axis, the id of the cue the start value tracks from (null =
   * first appearance or axis untouched by this block). */
  sources: Record<'x' | 'y' | 'z' | 'yaw', string | null>
}

export interface BlockContextMessage {
  type: 'block_context'
  cueId: string
  entries: Record<string, BlockContextEntry>
}

// Overlay de trajectoire à la sélection (remplace la ligne d'automation
// x/y/z retirée du bloc) : la courbe de déplacement de chaque acteur
// sélectionné sur toute la durée du projet, échantillonnée régulièrement.
// `null` à un index = le point n'a pas de position connue à cet instant
// (jamais un repli (0,0), §13.1.7).
export interface TrajectoriesMessage {
  type: 'trajectories'
  timesMs: number[]
  trajectories: Record<string, (Pose | null)[]>
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export interface SavedMessage {
  type: 'saved'
  path: string
}

/** Une entrée de archive/ (format bundle 2026-07-31) : une copie horodatée
 * de l'état du projet AVANT une sauvegarde explicite qui l'a remplacée. */
export interface BundleArchiveEntry {
  name: string
  /** ISO 8601, pour affichage humain uniquement — le tri se fait par nom
   * côté backend (l'horodatage y est encodé et trie correctement en texte,
   * insensible à la résolution de mtime du système de fichiers). */
  mtime: string
}

export interface BundleArchiveMessage {
  type: 'bundle_archive'
  path: string
  entries: BundleArchiveEntry[]
}

export interface AckMessage {
  type: 'ack'
}

export interface IfacesMessage {
  type: 'ifaces'
  addresses: string[]
}

export interface PsnPreviewTracker {
  id: number
  name: string
  posX: number
  posY: number
  posZ: number
  oriX: number
  oriY: number
  oriZ: number
}

export interface PsnPreviewMessage {
  type: 'psn_preview'
  running: boolean
  packetsSent: number
  dest: string
  ifaceIp: string
  rateHz: number
  upAxis: 'y' | 'z'
  lastError: string | null
  trackers: PsnPreviewTracker[]
}

export type ServerMessage =
  | ProjectMessage | TickMessage | BlockContextMessage | TrajectoriesMessage
  | ErrorMessage | SavedMessage | AckMessage
  | IfacesMessage | PsnPreviewMessage | BundleArchiveMessage
