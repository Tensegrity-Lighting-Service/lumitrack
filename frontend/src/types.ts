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

export interface Activation {
  targetXCm: number | null
  targetYCm: number | null
  targetZCm: number | null
  targetYawDeg: number | null
  fadeMs: number
  easing: string
  orientationMode: 'manual' | 'path'
}

export interface Cue {
  id: string
  name: string
  startMs: number
  durationMs: number
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

export type ServerMessage = ProjectMessage | TickMessage | ErrorMessage | SavedMessage | AckMessage
