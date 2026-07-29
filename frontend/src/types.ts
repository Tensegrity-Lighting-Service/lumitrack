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
  targetYawDeg: number | null
  fadeMs: number
  easing: string
  orientationMode: 'manual' | 'path'
  /** Courbes par axe (graph editor) ; axe absent = easing nommé. */
  curves?: Partial<Record<'x' | 'y' | 'z' | 'yaw', CurveNode[]>> | null
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
  points: Point[]
  cues: Cue[]
}

/** [x_cm, y_cm, z_cm, yaw_deg] */
export type Pose = [number, number, number, number]

export interface ProjectMessage {
  type: 'project'
  project: Project
  psnRunning: boolean
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

export interface ErrorMessage {
  type: 'error'
  message: string
}

export interface SavedMessage {
  type: 'saved'
  path: string
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
  | ProjectMessage | TickMessage | BlockContextMessage
  | ErrorMessage | SavedMessage | AckMessage
  | IfacesMessage | PsnPreviewMessage
