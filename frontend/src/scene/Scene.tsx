// Vue Dessus (top-down) — the only edit view in v1 (CONCEPTION.md §13.1.3).
// Face/Côté/3D libre (§12.4) are deferred. One react-three-fiber scene
// reused across future camera presets, per §12.4's "un seul environnement
// 3D, quatre caméras" — this file only wires up the first of the four.
//
// Editing model: click an actor to select it (Roster/Inspector follow).
// Selecting a Cue in the timeline puts the scene in that block's edit mode
// (§12.6): the block's targets (draggable ghost markers) and static
// trajectories (backend-sampled polylines, see `resolve_block_context`)
// are displayed on top of the live state, which stays visible but dimmed.
// Dragging an actor — or its target ghost — writes the new x/y into that
// Cue's Activation, and the ghost/trajectory follow each echoed snapshot,
// so no edit is ever silent (the constat n°2 anti-pattern: writing into a
// cue that doesn't govern the current playhead used to move nothing on
// screen). Without a Cue selected, actors are select-only. MapControls
// (pan/zoom) is disabled for the duration of a drag so the two gestures
// never fight over the same mouse movement.
//
// Stage-to-terrain mapping: the "zone de jeu" (the stage rectangle actors
// are positioned within, stageWidthCm x stageHeightCm) has no inherent
// relation to the terrain glTF's own origin/orientation — a venue survey
// and an abstract prop-placement rectangle are two independent coordinate
// systems. `stageMapOriginXM/ZM/RotationDeg` place the rectangle inside the
// terrain's world space. Everything stage-relative (grid, actors, the zone
// outline/handles) is nested inside one <StageGroup> so it only has to
// reason in the rectangle's own local metres — the group's transform does
// the placement once, rather than every child re-deriving it.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree, useFrame, type ThreeEvent } from '@react-three/fiber'
import { OrthographicCamera, MapControls, Grid, useGLTF, Line } from '@react-three/drei'
import type { MapControls as MapControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { convertFileSrc } from '@tauri-apps/api/core'
import { sidecar } from '../sidecar'
import type { Activation, BlockContextEntry, BlockContextMessage, PathPoint, Project, Pose } from '../types'

const CM_TO_M = 0.01
const DRAG_SEND_INTERVAL_MS = 33 // ~30/s — matches the sidecar's own tick rate
const ACTOR_RADIUS_M = 0.4 // was 0.18 — too small to read against a full-size stage
const FIT_PADDING = 0.9 // leaves a small margin around the fit region on zoom-to-fit
// Handles keep a constant *screen* size (px) regardless of zoom — see
// ScreenSizedMesh — rather than a fixed world size, which would shrink to
// invisible once "zoom to fit" frames a whole arena (~100m) and was the
// root of "on ne voit pas du tout les éléments de transformation".
const HANDLE_PX = 11
const ROTATE_HANDLE_PX = 9
const ROTATE_HANDLE_OFFSET_PX = 40 // distance above the top edge, same constant-screen-size logic
const SNAP_RADIUS_M = 0.6
// Target ghosts keep a constant screen size like the zone handles do — a
// world-sized marker would be unreadable at zoom-to-fit scale, defeating
// the whole "every edit has visible feedback" point of block-edit mode.
const GHOST_PX = 15
// Waypoints/poignées du tracé spatial : mêmes règles d'échelle écran.
const WAYPOINT_PX = 9
const PATH_HANDLE_PX = 6
// Live-state dimming in block-edit mode (§12.6): activated actors stay
// readable, the rest is context; the ghosts/trajectories are the subject.
const EDIT_ACTIVATED_OPACITY = 0.45
const EDIT_BYSTANDER_OPACITY = 0.18
const SNAP_MAX_POINTS = 4000 // subsampled if the floor layer is denser than this
// How close to the terrain's own minimum Y counts as "floor level". Height-
// based, not name-based: any venue survey has *some* ground plane, but node
// naming is completely author-dependent (this must work for any terrain a
// user loads, not just the one glTF on hand during development).
const SNAP_FLOOR_EPSILON_M = 0.15
// Mappages souris/tactile des MapControls — constantes de module : drei
// réapplique les props primitives à CHAQUE rendu (~30/s au fil des ticks),
// un objet neuf par rendu ferait donc réécrire la config des contrôles en
// continu pendant le zoom/fit.
const MOUSE_MAPPING = { LEFT: undefined as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
const TOUCH_MAPPING = { ONE: undefined as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN }

/** Stage (x_cm, y_cm depth, z_cm height) -> StageGroup-local metres
 * (X, Y up, Z). The group's own transform (position/rotation) then places
 * this into world space — children never need the placement themselves. */
function stageToLocal(x_cm: number, y_cm: number, z_cm: number): [number, number, number] {
  return [x_cm * CM_TO_M, z_cm * CM_TO_M, y_cm * CM_TO_M]
}

const SCENE_BACKGROUND = '#0c0d10'

/** t=1 -> original color, t=0 -> faded into the scene background. Used as a
 * stand-in for opacity where a material has no such control (drei's Grid). */
function mixTowardBackground(hex: string, t: number): string {
  return new THREE.Color(hex).lerp(new THREE.Color(SCENE_BACKGROUND), 1 - t).getStyle()
}

export interface PlanarBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface SnapPoint { x: number; z: number }

/** Reports its actual bounding box (XZ footprint) once loaded: the terrain's
 * real-world size/origin has no necessary relation to the project's own
 * "stage" dimensions (an abstract prop-placement rectangle, not a survey of
 * the venue) — zoom-to-fit needs the real footprint to show the whole
 * model instead of whatever fraction of it overlaps the stage rectangle.
 *
 * Also collects snap candidates: vertices sitting near the terrain's own
 * lowest Y (SNAP_FLOOR_EPSILON_M) across *every* mesh, not ones picked by
 * node name — this has to work for whatever terrain a user loads, and glTF
 * authoring/naming is out of our control, but a floor-level heuristic holds
 * for any venue survey. Grandstands/roof/rigging sit well above the floor
 * so they're naturally excluded; whatever's drawn on the ground (pitch
 * lines, markings, thresholds) is exactly what's left. */
function Terrain({ path, onBounds, onSnapPoints }: {
  path: string
  onBounds: (bounds: PlanarBounds) => void
  onSnapPoints: (points: SnapPoint[]) => void
}) {
  const url = useMemo(() => convertFileSrc(path), [path])
  const { scene } = useGLTF(url)
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene)
    onBounds({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z })

    const floorY = box.min.y + SNAP_FLOOR_EPSILON_M
    const points: SnapPoint[] = []
    const v = new THREE.Vector3()
    scene.traverse((node) => {
      if (points.length >= SNAP_MAX_POINTS) return
      if (!(node instanceof THREE.Mesh)) return
      const position = node.geometry.getAttribute('position')
      if (!position) return
      for (let i = 0; i < position.count && points.length < SNAP_MAX_POINTS; i++) {
        v.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld)
        if (v.y <= floorY) points.push({ x: v.x, z: v.z })
      }
    })
    onSnapPoints(points)
  }, [scene, onBounds, onSnapPoints])
  return <primitive object={scene} />
}

function GenericFloor({ widthM, heightM }: { widthM: number; heightM: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[widthM / 2, 0, heightM / 2]}>
      <planeGeometry args={[widthM, heightM]} />
      <meshStandardMaterial color="#1b1e26" />
    </mesh>
  )
}

function Actor({ pose, color, selected, draggable, opacity, onPointerDown }: {
  pose: Pose
  color: string
  selected: boolean
  draggable: boolean
  /** 1 in live view; dimmed in block-edit mode, where the live state is
   * context and the targets/trajectories are the subject (§12.6). */
  opacity: number
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
}) {
  const [x_cm, y_cm, z_cm, yaw_deg] = pose
  const [x, y, z] = stageToLocal(x_cm, y_cm, z_cm)
  const yawRad = THREE.MathUtils.degToRad(yaw_deg)
  const transparent = opacity < 1
  return (
    <group
      position={[x, y, z]}
      rotation={[0, -yawRad, 0]}
      onPointerDown={onPointerDown}
      onPointerOver={() => { document.body.style.cursor = draggable ? 'grab' : 'pointer' }}
      onPointerOut={() => { document.body.style.cursor = 'auto' }}
    >
      <mesh>
        <sphereGeometry args={[ACTOR_RADIUS_M, 20, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={selected ? color : '#000000'}
          emissiveIntensity={selected ? 0.6 : 0}
          transparent={transparent}
          opacity={opacity}
        />
      </mesh>
      {/* Directional pointer: shows which way the carried fixture faces (§12.5). */}
      <mesh position={[0, 0, ACTOR_RADIUS_M * 1.8]}>
        <coneGeometry args={[ACTOR_RADIUS_M * 0.45, ACTOR_RADIUS_M * 1.6, 12]} />
        <meshStandardMaterial color={color} transparent={transparent} opacity={opacity} />
      </mesh>
      {/* Larger invisible hit target: the visible marker is small, dragging
          shouldn't require pixel-perfect aim on it. */}
      <mesh visible={false}>
        <sphereGeometry args={[ACTOR_RADIUS_M * 1.8, 8, 8]} />
      </mesh>
    </group>
  )
}

/** Visual weight of one block-edit element, driven by actor selection
 * (§12.6): no actor selected → every trajectory reads equally; an actor
 * selected → its trajectory/ghost pops, the rest stays visible but dim. */
type Emphasis = 'highlight' | 'normal' | 'dim'

const EMPHASIS_OPACITY: Record<Emphasis, number> = { highlight: 1, normal: 0.85, dim: 0.25 }

/** Static trajectory of one activation in the selected block: the polyline
 * sampled by the backend from the real tracking-chain start to the target
 * (`resolve_block_context`). Pure display — the geometry arrives fully
 * resolved, nothing is interpolated here (§13.1.7). */
function Trajectory({ path, color, emphasis, onDoubleClick }: {
  path: [number, number, number][]
  color: string
  emphasis: Emphasis
  onDoubleClick?: (e: ThreeEvent<MouseEvent>) => void
}) {
  const points = useMemo(
    () => path.map(([x_cm, y_cm, z_cm]) => new THREE.Vector3(...stageToLocal(x_cm, y_cm, z_cm))),
    [path],
  )
  return (
    <Line
      points={points}
      color={color}
      lineWidth={emphasis === 'highlight' ? 3.5 : 2}
      transparent
      opacity={EMPHASIS_OPACITY[emphasis]}
      depthTest={false}
      renderOrder={1010}
      onDoubleClick={onDoubleClick}
    />
  )
}

/** Marqueur d'édition du tracé à taille écran constante (waypoint = carré
 * pivoté, poignée = disque). Même logique de zoom que TargetGhost. */
function PathMarker({ xCm, yCm, zCm, px, color, shape, selected, onPointerDown }: {
  xCm: number
  yCm: number
  zCm: number
  px: number
  color: string
  shape: 'diamond' | 'dot'
  selected: boolean
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
}) {
  const [x, y, z] = stageToLocal(xCm, yCm, zCm)
  const ref = useRef<THREE.Group>(null)
  useFrame(({ camera }) => {
    if (!ref.current) return
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const sc = px / zoom
    ref.current.scale.set(sc, sc, sc)
  })
  return (
    <group position={[x, y + 0.02, z]}>
      <group
        ref={ref}
        rotation={[-Math.PI / 2, 0, shape === 'diamond' ? Math.PI / 4 : 0]}
        onPointerDown={onPointerDown}
        onPointerOver={() => { document.body.style.cursor = 'grab' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        {shape === 'diamond'
          ? <mesh renderOrder={1030}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial color={selected ? '#ffffff' : color} depthTest={false} transparent side={THREE.DoubleSide} />
            </mesh>
          : <mesh renderOrder={1030}>
              <circleGeometry args={[0.5, 20]} />
              <meshBasicMaterial color={color} depthTest={false} transparent side={THREE.DoubleSide} />
            </mesh>}
        {/* Hitbox élargie : les marqueurs font ~9 px, la zone de saisie 3x. */}
        <mesh renderOrder={1029} visible={false}>
          <circleGeometry args={[1.6, 12]} />
          <meshBasicMaterial depthTest={false} transparent opacity={0} side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  )
}

// Ancres du tracé (départ dynamique, waypoints, cible) + poignées par
// défaut au tiers de corde — MÊME convention que le moteur (timeline.py /
// path.rs), pour que la poignée affichée soit celle réellement appliquée.
function pathAnchors(entry: BlockContextEntry, act: Activation): [number, number][] {
  const out: [number, number][] = []
  if (entry.startPose) out.push([entry.startPose[0], entry.startPose[1]])
  for (const wp of act.pathPoints ?? []) out.push([wp.xCm, wp.yCm])
  if (entry.targetPose) out.push([entry.targetPose[0], entry.targetPose[1]])
  return out
}

function defaultHandle(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3]
}

/** Overlay d'édition du tracé de l'activation mise en avant : waypoints
 * (losanges), poignées de Bézier (points reliés à leur ancre), double-clic
 * sur le tracé pour insérer — l'affichage de la courbe elle-même reste le
 * Trajectory backend-échantillonné. */
function PathEditOverlay({ entry, act, color, selectedIndex, onWaypointDown, onHandleDown }: {
  entry: BlockContextEntry
  act: Activation
  color: string
  selectedIndex: number | null
  onWaypointDown: (e: ThreeEvent<PointerEvent>, index: number) => void
  onHandleDown: (e: ThreeEvent<PointerEvent>, anchor: 'start' | 'target' | number, side: 'in' | 'out') => void
}) {
  const anchors = pathAnchors(entry, act)
  if (anchors.length < 2 || !entry.startPose || !entry.targetPose) return null
  const zCm = entry.startPose[2]
  const wps = act.pathPoints ?? []

  const handleMarkers: {
    key: string
    anchor: 'start' | 'target' | number
    side: 'in' | 'out'
    pos: [number, number]
    from: [number, number]
  }[] = []

  // Poignée sortante du départ (toujours visible : c'est elle qui donne la
  // première tangente, comme en AE).
  const startPos: [number, number] = anchors[0]
  const startHandlePos: [number, number] = act.startHandle
    ? [startPos[0] + act.startHandle.dxCm, startPos[1] + act.startHandle.dyCm]
    : defaultHandle(startPos, anchors[1])
  handleMarkers.push({ key: 'h-start', anchor: 'start', side: 'out', pos: startHandlePos, from: startPos })

  // Poignée entrante de la cible.
  const targetPos: [number, number] = anchors[anchors.length - 1]
  const targetHandlePos: [number, number] = act.targetHandle
    ? [targetPos[0] + act.targetHandle.dxCm, targetPos[1] + act.targetHandle.dyCm]
    : defaultHandle(targetPos, anchors[anchors.length - 2])
  handleMarkers.push({ key: 'h-target', anchor: 'target', side: 'in', pos: targetHandlePos, from: targetPos })

  // Poignées du waypoint sélectionné uniquement (les autres restent des
  // losanges nus pour ne pas transformer la scène en sapin de Noël).
  if (selectedIndex !== null && wps[selectedIndex]) {
    const wp = wps[selectedIndex]
    const aIdx = selectedIndex + 1 // index de ce waypoint dans anchors
    const wpPos: [number, number] = [wp.xCm, wp.yCm]
    const inPos: [number, number] = wp.inDxCm !== null
      ? [wp.xCm + wp.inDxCm, wp.yCm + (wp.inDyCm ?? 0)]
      : defaultHandle(wpPos, anchors[aIdx - 1])
    const outPos: [number, number] = wp.outDxCm !== null
      ? [wp.xCm + wp.outDxCm, wp.yCm + (wp.outDyCm ?? 0)]
      : defaultHandle(wpPos, anchors[aIdx + 1])
    handleMarkers.push({ key: `h-in-${selectedIndex}`, anchor: selectedIndex, side: 'in', pos: inPos, from: wpPos })
    handleMarkers.push({ key: `h-out-${selectedIndex}`, anchor: selectedIndex, side: 'out', pos: outPos, from: wpPos })
  }

  return (
    <group>
      {handleMarkers.map((h) => (
        <group key={h.key}>
          <Line
            points={[
              new THREE.Vector3(...stageToLocal(h.from[0], h.from[1], zCm)),
              new THREE.Vector3(...stageToLocal(h.pos[0], h.pos[1], zCm)),
            ]}
            color="#8a8a99"
            lineWidth={1}
            transparent
            opacity={0.9}
            depthTest={false}
            renderOrder={1025}
          />
          <PathMarker
            xCm={h.pos[0]} yCm={h.pos[1]} zCm={zCm}
            px={PATH_HANDLE_PX} color="#d8d8e2" shape="dot" selected={false}
            onPointerDown={(e) => onHandleDown(e, h.anchor, h.side)}
          />
        </group>
      ))}
      {wps.map((wp, i) => (
        <PathMarker
          key={`wp-${i}`}
          xCm={wp.xCm} yCm={wp.yCm} zCm={zCm}
          px={WAYPOINT_PX} color={color} shape="diamond" selected={i === selectedIndex}
          onPointerDown={(e) => onWaypointDown(e, i)}
        />
      ))}
    </group>
  )
}

/** Where this activation sends the actor: a flat ring + heading tick at the
 * target pose, constant screen size (same `useFrame`/`camera.zoom` scaling
 * as the zone handles). Draggable: grabbing the ghost — like dragging the
 * actor itself while a block is selected — moves the block's target, so the
 * thing being edited is always the thing on screen. */
function TargetGhost({ pose, color, emphasis, onPointerDown }: {
  pose: Pose
  color: string
  emphasis: Emphasis
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
}) {
  const [x_cm, y_cm, z_cm, yaw_deg] = pose
  const [x, y, z] = stageToLocal(x_cm, y_cm, z_cm)
  const yawRad = THREE.MathUtils.degToRad(yaw_deg)
  const scaledRef = useRef<THREE.Group>(null)
  useFrame(({ camera }) => {
    if (!scaledRef.current) return
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const s = GHOST_PX / zoom
    scaledRef.current.scale.set(s, s, s)
  })
  const opacity = EMPHASIS_OPACITY[emphasis]
  return (
    <group position={[x, y, z]} rotation={[0, -yawRad, 0]}>
      <group
        ref={scaledRef}
        onPointerDown={onPointerDown}
        onPointerOver={() => { document.body.style.cursor = 'grab' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={1011}>
          <ringGeometry args={[0.68, 1, 32]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={1011}>
          <circleGeometry args={[0.28, 16]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
        {/* Flat heading tick: apex points along local +Z, the same axis the
            actor's own directional cone offsets toward, so ghost and actor
            agree on what the target yaw means. */}
        <mesh position={[0, 0, 1.45]} rotation={[Math.PI / 2, 0, 0]} renderOrder={1011}>
          <coneGeometry args={[0.38, 0.85, 3]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} />
        </mesh>
        {/* Invisible hit disc: dragging shouldn't need pixel-perfect aim. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} visible={false}>
          <circleGeometry args={[1.7, 12]} />
        </mesh>
      </group>
    </group>
  )
}

/** The zone's rectangle outline, drawn in local space. Brighter and filled
 * while being edited so it reads as "the thing you're manipulating"; a
 * faint outline the rest of the time so it's still a spatial reference. */
function ZoneOutline({ widthM, heightM, editing }: { widthM: number; heightM: number; editing: boolean }) {
  const points = useMemo(() => [
    new THREE.Vector3(0, 0.01, 0),
    new THREE.Vector3(widthM, 0.01, 0),
    new THREE.Vector3(widthM, 0.01, heightM),
    new THREE.Vector3(0, 0.01, heightM),
    new THREE.Vector3(0, 0.01, 0),
  ], [widthM, heightM])
  return (
    <>
      {/* renderOrder + depthTest=false: this is a 2D editing overlay, not
          part of the 3D scene proper — it must stay visible on top of the
          terrain (grandstands, LED boards etc. sit above y=0 in a real
          venue survey) rather than being occluded like normal geometry.
          drei's <Line>, not the bare <line> primitive: plain JSX `<line>`
          resolves to the DOM/SVG element's TypeScript type in this project
          rather than react-three-fiber's, which happened not to matter
          until a prop (renderOrder) only the 3D one has was added. */}
      <Line
        points={points}
        color={editing ? '#ffffff' : '#4f6df5'}
        lineWidth={2}
        transparent
        opacity={editing ? 0.9 : 0.4}
        depthTest={false}
        renderOrder={1000}
      />
      {editing && (
        <mesh position={[widthM / 2, 0.005, heightM / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={999}>
          <planeGeometry args={[widthM, heightM]} />
          <meshBasicMaterial color="#4f6df5" transparent opacity={0.12} depthWrite={false} depthTest={false} />
        </mesh>
      )}
    </>
  )
}

type DragKind = 'move' | 'resize' | 'rotate'

/** One of the 8 resize handles: 4 corners (resize both axes) + 4 edge
 * midpoints (resize one axis, "le resize doit pouvoir se faire depuis les
 * bords"). fx/fz are the handle's position as a fraction of width/height
 * (0, 0.5 or 1) — also used to derive which corner is the fixed anchor
 * (1-fx, 1-fz) that must not move in world space while dragging. */
interface ResizeHandleDef {
  key: string
  axis: 'x' | 'z' | 'both'
  fx: number
  fz: number
  cursor: string
}
const RESIZE_HANDLES: ResizeHandleDef[] = [
  { key: 'tl', axis: 'both', fx: 0, fz: 0, cursor: 'nwse-resize' },
  { key: 'tr', axis: 'both', fx: 1, fz: 0, cursor: 'nesw-resize' },
  { key: 'br', axis: 'both', fx: 1, fz: 1, cursor: 'nwse-resize' },
  { key: 'bl', axis: 'both', fx: 0, fz: 1, cursor: 'nesw-resize' },
  { key: 'top', axis: 'z', fx: 0.5, fz: 0, cursor: 'ns-resize' },
  { key: 'bottom', axis: 'z', fx: 0.5, fz: 1, cursor: 'ns-resize' },
  { key: 'left', axis: 'x', fx: 0, fz: 0.5, cursor: 'ew-resize' },
  { key: 'right', axis: 'x', fx: 1, fz: 0.5, cursor: 'ew-resize' },
]

/** Nearest snap candidate to (x,z) within SNAP_RADIUS_M, or null. Linear
 * scan: fine at SNAP_MAX_POINTS scale and only run at drag-throttle rate,
 * not every raw pointermove. */
function findSnap(x: number, z: number, points: SnapPoint[]): SnapPoint | null {
  let best: SnapPoint | null = null
  let bestDistSq = SNAP_RADIUS_M * SNAP_RADIUS_M
  for (const p of points) {
    const dx = p.x - x, dz = p.z - z
    const distSq = dx * dx + dz * dz
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      best = p
    }
  }
  return best
}

/** Keeps a constant *screen* size (px) regardless of camera zoom — a fixed
 * world size would shrink to invisible once "zoom to fit" frames a whole
 * arena (~100m), which was the root of "on ne voit pas du tout les éléments
 * de transformation". `args` is the geometry's aspect ratio at unit scale
 * (e.g. [1,1,1] square, [0.35,1,1] a bar elongated along Z) — actual size
 * comes entirely from the per-frame scale below. Unlit meshBasicMaterial:
 * these are a 2D editing overlay, not scene-lit geometry. */
function ScreenSizedHandle({ position, sizePx, args, color, onPointerDown, cursor, renderOrder }: {
  position: [number, number, number]
  sizePx: number
  args: [number, number, number]
  color: string
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
  cursor: string
  renderOrder: number
}) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ camera }) => {
    if (!ref.current) return
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const s = sizePx / zoom
    ref.current.scale.set(s, s, s)
  })
  return (
    <mesh
      ref={ref}
      position={position}
      renderOrder={renderOrder}
      onPointerDown={onPointerDown}
      onPointerOver={() => { document.body.style.cursor = cursor }}
      onPointerOut={() => { document.body.style.cursor = 'auto' }}
    >
      <boxGeometry args={args} />
      <meshBasicMaterial color={color} depthTest={false} />
    </mesh>
  )
}

/** Rotate handle: offset outward from the top edge (screen-up is -Z, since
 * the camera's `up` is set to (0,0,-1) for the top-down view). Both its
 * offset distance and size are recomputed every frame from the current
 * zoom, same reasoning as ScreenSizedHandle — a fixed-world-metres offset
 * would put it almost on top of the corner once zoomed out to fit a whole
 * arena. */
function RotateHandle({ widthM, onPointerDown }: {
  widthM: number
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
}) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ camera }) => {
    if (!ref.current) return
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const offset = ROTATE_HANDLE_OFFSET_PX / zoom
    ref.current.position.set(widthM / 2, 0.03, -offset)
    const s = ROTATE_HANDLE_PX / zoom
    ref.current.scale.set(s, s, s)
  })
  return (
    <mesh
      ref={ref}
      renderOrder={1002}
      onPointerDown={onPointerDown}
      onPointerOver={() => { document.body.style.cursor = 'grab' }}
      onPointerOut={() => { document.body.style.cursor = 'auto' }}
    >
      <sphereGeometry args={[0.5, 16, 12]} />
      <meshBasicMaterial color="#4ff58c" depthTest={false} />
    </mesh>
  )
}

/** Move/resize/rotate handles for the "zone de jeu", only rendered while
 * editing. All gestures raycast against a ground plane:
 *  - move: world-space delta added straight to the origin (translation
 *    doesn't care about rotation), snapped to nearby floor geometry.
 *  - resize: general anchor-preserving formula — whichever corner is
 *    diagonally (or, for an edge handle, directly) opposite the dragged
 *    handle is frozen in *world* space for the whole gesture (its position
 *    is cached once at drag start, using the rotation/origin at that
 *    moment, so it's immune to the group's transform changing mid-drag).
 *    The raycasted hit is expressed in that same frozen local frame to get
 *    the new width/height, then the anchor's world position is used to
 *    solve for the new origin. Reduces to the simple "grow from one fixed
 *    corner" case when dragging the corner whose anchor is local (0,0).
 *  - rotate: angle-from-pivot delta (current minus drag-start) added to the
 *    rotation at drag start — a relative delta needs no assumption about
 *    which way three.js' Y-rotation matrix winds, only that it's applied
 *    consistently between the two samples.
 */
function ZoneHandles({ project, widthM, heightM, stageGroupRef, controlsRef, snapPoints }: {
  project: Project
  widthM: number
  heightM: number
  stageGroupRef: React.RefObject<THREE.Group | null>
  controlsRef: React.RefObject<MapControlsImpl | null>
  snapPoints: SnapPoint[]
}) {
  const { camera, raycaster, gl } = useThree()
  const dragRef = useRef<{
    kind: DragKind
    startWorld: THREE.Vector3
    startOriginXM: number
    startOriginZM: number
    startRotationDeg: number
    lastSent: number
    resize?: {
      handle: ResizeHandleDef
      cos0: number
      sin0: number
      width0: number
      height0: number
      anchorWorldX: number
      anchorWorldZ: number
    }
  } | null>(null)

  useEffect(() => {
    const dom = gl.domElement
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()

    const toNdc = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect()
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
    }

    const raycastGround = (e: PointerEvent): THREE.Vector3 | null => {
      raycaster.setFromCamera(toNdc(e), camera)
      return raycaster.ray.intersectPlane(plane, hit) ? hit.clone() : null
    }

    const endDrag = () => {
      dragRef.current = null
      if (controlsRef.current) controlsRef.current.enabled = true
    }

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const now = performance.now()
      if (now - drag.lastSent < DRAG_SEND_INTERVAL_MS) return
      drag.lastSent = now
      const world = raycastGround(e)
      if (!world) return

      if (drag.kind === 'move') {
        // Snap the rectangle's own origin corner to a nearby line vertex —
        // lets the user click a corner/dot on the pitch and have the zone
        // lock onto it instead of eyeballing the position.
        let originXM = drag.startOriginXM + (world.x - drag.startWorld.x)
        let originZM = drag.startOriginZM + (world.z - drag.startWorld.z)
        const snap = findSnap(originXM, originZM, snapPoints)
        if (snap) { originXM = snap.x; originZM = snap.z }
        sidecar.updateStageMap({ originXM, originZM })
      } else if (drag.kind === 'resize' && drag.resize) {
        const { handle, cos0, sin0, width0, height0, anchorWorldX, anchorWorldZ } = drag.resize
        const snap = findSnap(world.x, world.z, snapPoints)
        const targetX = snap ? snap.x : world.x
        const targetZ = snap ? snap.z : world.z

        // World delta from the frozen anchor, expressed in the rectangle's
        // *local* axes (rotation-only inverse — R is orthogonal, so its
        // inverse is its transpose; no origin/translation involved since
        // this is a delta, not a point).
        const dxw = targetX - anchorWorldX
        const dzw = targetZ - anchorWorldZ
        const localDx = dxw * cos0 - dzw * sin0
        const localDz = dxw * sin0 + dzw * cos0

        let newWidthM = width0
        let newHeightM = height0
        if (handle.axis !== 'z') newWidthM = Math.max(0.1, handle.fx === 1 ? localDx : -localDx)
        if (handle.axis !== 'x') newHeightM = Math.max(0.1, handle.fz === 1 ? localDz : -localDz)

        // Where the anchor sits relative to the *new* origin — rotate that
        // back into world space and subtract from the anchor's (fixed)
        // world position to get the new origin.
        const anchorNewLocalX = newWidthM * (1 - handle.fx)
        const anchorNewLocalZ = newHeightM * (1 - handle.fz)
        const rotatedX = anchorNewLocalX * cos0 + anchorNewLocalZ * sin0
        const rotatedZ = -anchorNewLocalX * sin0 + anchorNewLocalZ * cos0

        sidecar.updateStageMap({
          widthCm: newWidthM / CM_TO_M,
          heightCm: newHeightM / CM_TO_M,
          originXM: anchorWorldX - rotatedX,
          originZM: anchorWorldZ - rotatedZ,
        })
      } else {
        const pivotX = drag.startOriginXM
        const pivotZ = drag.startOriginZM
        const startAngle = Math.atan2(drag.startWorld.x - pivotX, drag.startWorld.z - pivotZ)
        const currentAngle = Math.atan2(world.x - pivotX, world.z - pivotZ)
        const deltaDeg = THREE.MathUtils.radToDeg(currentAngle - startAngle)
        sidecar.updateStageMap({ rotationDeg: drag.startRotationDeg + deltaDeg })
      }
    }

    dom.addEventListener('pointermove', onMove)
    dom.addEventListener('pointerup', endDrag)
    dom.addEventListener('pointerleave', endDrag)
    return () => {
      dom.removeEventListener('pointermove', onMove)
      dom.removeEventListener('pointerup', endDrag)
      dom.removeEventListener('pointerleave', endDrag)
    }
  }, [camera, raycaster, gl, stageGroupRef, controlsRef, snapPoints])

  const beginMoveOrRotateDrag = (e: ThreeEvent<PointerEvent>, kind: 'move' | 'rotate') => {
    e.stopPropagation()
    dragRef.current = {
      kind,
      startWorld: e.point.clone(),
      startOriginXM: project.stageMapOriginXM,
      startOriginZM: project.stageMapOriginZM,
      startRotationDeg: project.stageMapRotationDeg,
      lastSent: 0,
    }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  const beginResizeDrag = (e: ThreeEvent<PointerEvent>, handle: ResizeHandleDef) => {
    e.stopPropagation()
    const rotRad0 = THREE.MathUtils.degToRad(project.stageMapRotationDeg)
    const cos0 = Math.cos(rotRad0)
    const sin0 = Math.sin(rotRad0)
    const originXM = project.stageMapOriginXM
    const originZM = project.stageMapOriginZM
    const anchorLocalX = (1 - handle.fx) * widthM
    const anchorLocalZ = (1 - handle.fz) * heightM
    const anchorWorldX = originXM + anchorLocalX * cos0 + anchorLocalZ * sin0
    const anchorWorldZ = originZM + (-anchorLocalX * sin0 + anchorLocalZ * cos0)
    dragRef.current = {
      kind: 'resize',
      startWorld: e.point.clone(),
      startOriginXM: originXM,
      startOriginZM: originZM,
      startRotationDeg: project.stageMapRotationDeg,
      lastSent: 0,
      resize: { handle, cos0, sin0, width0: widthM, height0: heightM, anchorWorldX, anchorWorldZ },
    }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  return (
    <>
      {/* Move: drag the whole filled zone. renderOrder + depthTest=false: a
          2D editing overlay must stay visible/on top of the terrain rather
          than being occluded like normal 3D geometry (grandstands, LED
          boards etc. sit above y=0 in a real venue survey). */}
      <mesh
        position={[widthM / 2, 0.02, heightM / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={1001}
        onPointerDown={(e) => beginMoveOrRotateDrag(e, 'move')}
        onPointerOver={() => { document.body.style.cursor = 'move' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <planeGeometry args={[widthM, heightM]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
      </mesh>

      {RESIZE_HANDLES.map((h) => (
        <ScreenSizedHandle
          key={h.key}
          position={[widthM * h.fx, 0.03, heightM * h.fz]}
          sizePx={HANDLE_PX}
          args={h.axis === 'x' ? [0.35, 1, 1] : h.axis === 'z' ? [1, 1, 0.35] : [1, 1, 1]}
          color="#f5734f"
          cursor={h.cursor}
          renderOrder={1002}
          onPointerDown={(e) => beginResizeDrag(e, h)}
        />
      ))}

      <RotateHandle widthM={widthM} onPointerDown={(e) => beginMoveOrRotateDrag(e, 'rotate')} />
    </>
  )
}

/** Everything stage-relative (grid, actors, the zone outline/handles)
 * nested under one transform, so only this group needs to know where the
 * stage rectangle sits inside the terrain (see file header). */
function StageGroup({ project, groupRef, children }: {
  project: Project
  groupRef: React.RefObject<THREE.Group | null>
  children: React.ReactNode
}) {
  const rotationRad = THREE.MathUtils.degToRad(project.stageMapRotationDeg)
  return (
    <group ref={groupRef} position={[project.stageMapOriginXM, 0, project.stageMapOriginZM]} rotation={[0, rotationRad, 0]}>
      {children}
    </group>
  )
}

/** Darkens everything outside the zone rectangle (the "surbrillance"
 * principle applied to the terrain itself: highlight what's being edited,
 * dim the rest) via a single plane covering the fit region with a
 * rectangular hole cut where the zone is. The hole is built from the
 * zone's actual world-space corners (via stageGroupRef.localToWorld), so it
 * tracks the zone's rotation correctly without this mask needing its own
 * rotation math. */
function DarkenMask({ maskBounds, stageGroupRef, widthM, heightM }: {
  maskBounds: PlanarBounds
  stageGroupRef: React.RefObject<THREE.Group | null>
  widthM: number
  heightM: number
}) {
  const geometry = useMemo(() => {
    const group = stageGroupRef.current
    const cx = (maskBounds.minX + maskBounds.maxX) / 2
    const cz = (maskBounds.minZ + maskBounds.maxZ) / 2
    const w = Math.max(maskBounds.maxX - maskBounds.minX, widthM) * 1.5
    const h = Math.max(maskBounds.maxZ - maskBounds.minZ, heightM) * 1.5

    const shape = new THREE.Shape()
    shape.moveTo(-w / 2, -h / 2)
    shape.lineTo(w / 2, -h / 2)
    shape.lineTo(w / 2, h / 2)
    shape.lineTo(-w / 2, h / 2)
    shape.closePath()

    if (group) {
      const corners = [
        [0, 0], [widthM, 0], [widthM, heightM], [0, heightM],
      ].map(([lx, lz]) => group.localToWorld(new THREE.Vector3(lx, 0, lz)))
      const hole = new THREE.Path()
      corners.forEach((corner, i) => {
        const localX = corner.x - cx
        const localZ = corner.z - cz
        if (i === 0) hole.moveTo(localX, -localZ)
        else hole.lineTo(localX, -localZ)
      })
      hole.closePath()
      shape.holes.push(hole)
    }

    return new THREE.ShapeGeometry(shape)
  }, [maskBounds, stageGroupRef, widthM, heightM])

  const cx = (maskBounds.minX + maskBounds.maxX) / 2
  const cz = (maskBounds.minZ + maskBounds.maxZ) / 2

  return (
    <mesh geometry={geometry} position={[cx, 0.015, cz]} rotation={[-Math.PI / 2, 0, 0]}>
      <meshBasicMaterial color="#000000" transparent opacity={0.6} depthWrite={false} />
    </mesh>
  )
}

/** Everything that needs useThree() (raycasting against the actual camera)
 * lives here, as a child of <Canvas>. Owns the one active drag gesture:
 * pointerdown on an actor arms it, pointermove raycasts against a
 * horizontal plane at the actor's height and throttles setActivation calls,
 * pointerup releases MapControls again. */
function SceneContent({
  project, positions, selectedPointId, selectedPointIds, selectedCueId, blockContext, onSelectPoint, onSelectPoints,
  onLassoRect, cameraLocked, fitToken, editingZone,
  gridOpacity, snapToGrid, zoomAction,
}: {
  project: Project
  positions: Record<string, Pose>
  selectedPointId: string | null
  selectedPointIds: string[]
  selectedCueId: string | null
  blockContext: BlockContextMessage | null
  onSelectPoint: (pointId: string) => void
  onSelectPoints: (ids: string[]) => void
  onLassoRect: (rect: { x: number; y: number; w: number; h: number } | null) => void
  cameraLocked: boolean
  fitToken: number
  editingZone: boolean
  gridOpacity: number
  snapToGrid: boolean
  zoomAction: { token: number; factor: number }
}) {
  const widthM = project.stageWidthCm * CM_TO_M
  const heightM = project.stageHeightCm * CM_TO_M

  const { camera, raycaster, gl, size } = useThree()
  const controlsRef = useRef<MapControlsImpl>(null)
  const stageGroupRef = useRef<THREE.Group>(null)
  type SceneDrag =
    | { kind: 'target'; pointId: string; planeY: number; lastSent: number;
        /** Transformation groupée : membres avec leur position de base, et
         * curseur de référence (cm) fixé au premier échantillon du drag —
         * chaque membre suit alors le MÊME delta que la souris. */
        group: { pointId: string; baseX: number; baseY: number }[] | null
        baseCursor: { x: number; y: number } | null }
    | { kind: 'waypoint'; pointId: string; index: number; planeY: number; lastSent: number }
    | { kind: 'handle'; pointId: string; anchor: 'start' | 'target' | number; side: 'in' | 'out'; planeY: number; lastSent: number }
  const dragRef = useRef<SceneDrag | null>(null)
  // Sélection d'un waypoint du tracé (Suppr le retire, voir keydown).
  const [selectedWaypoint, setSelectedWaypoint] = useState<{ pointId: string; index: number } | null>(null)
  // Lus par le onMove global au moment de l'évènement (l'effet ne dépend
  // pas du project : il se ré-abonnerait à chaque écho sinon).
  const liveRef = useRef<{ project: Project; entries: Record<string, BlockContextEntry> | null }>({ project, entries: null })
  // Lasso : rectangle écran en cours (px, repère du canvas).
  const lassoRef = useRef<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null)
  const selectedIdsRef = useRef(selectedPointIds)
  selectedIdsRef.current = selectedPointIds
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const [terrainBounds, setTerrainBounds] = useState<PlanarBounds | null>(null)
  const onTerrainBounds = useCallback((b: PlanarBounds) => setTerrainBounds(b), [])
  const [snapPoints, setSnapPoints] = useState<SnapPoint[]>([])
  const onSnapPoints = useCallback((p: SnapPoint[]) => setSnapPoints(p), [])

  // Fit region: the zone's own *mapped* world-space footprint — the actual
  // work area, which is what "zoom to fit" should frame tightly around.
  // Deliberately *not* the terrain's own bounding box: a full venue survey
  // includes grandstands/roof/rigging, and unioning against it (an earlier
  // attempt) meant the union was dominated by the terrain whenever the zone
  // sits inside it (the normal case once properly mapped) — "zoom to fit"
  // then showed the whole arena with the zone as a barely-visible rectangle
  // inside it, not actually fit to the zone at all. The terrain is still
  // fully reachable by panning/zooming out manually; this only decides
  // where the *default*/explicit-fit framing lands.
  const fit = useMemo(() => {
    const rotRad = THREE.MathUtils.degToRad(project.stageMapRotationDeg)
    const cos = Math.cos(rotRad), sin = Math.sin(rotRad)
    // Same Y-rotation convention Three.js applies to the group's own
    // `rotation` prop (verified against DarkenMask's hole alignment).
    const toWorldX = (lx: number, lz: number) => project.stageMapOriginXM + lx * cos + lz * sin
    const toWorldZ = (lx: number, lz: number) => project.stageMapOriginZM + (-lx * sin + lz * cos)
    const corners = [[0, 0], [widthM, 0], [widthM, heightM], [0, heightM]]
      .map(([lx, lz]) => [toWorldX(lx, lz), toWorldZ(lx, lz)])
    const minX = Math.min(...corners.map((c) => c[0]))
    const maxX = Math.max(...corners.map((c) => c[0]))
    const minZ = Math.min(...corners.map((c) => c[1]))
    const maxZ = Math.max(...corners.map((c) => c[1]))
    return { centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2, spanX: maxX - minX, spanZ: maxZ - minZ }
  }, [widthM, heightM, project.stageMapOriginXM, project.stageMapOriginZM, project.stageMapRotationDeg])

  // Always current for the effect below to read without depending on it
  // (see that effect's comment for why).
  const fitRef = useRef(fit)
  fitRef.current = fit
  const span = Math.max(fit.spanX, fit.spanZ)

  // Sole owner of the camera's position/orientation/zoom for the top-down
  // view, and of MapControls' pan target — set here imperatively rather
  // than via the `target` JSX prop, since drei reapplies primitive props
  // every render and this component re-renders on every tick (~30/s); a
  // fresh `target={[...]}` array each render would fight the user's own
  // panning. Looking straight down means the view direction (0,-1,0) is
  // exactly antiparallel to Three's default camera.up (0,1,0) — a
  // degenerate case for lookAt() that three.js resolves with an
  // effectively arbitrary roll, which is what actually made the terrain
  // look tilted rather than flat (checked: every node in the .glb's own
  // rotation data is yaw-only, so the asset itself was never the problem).
  //
  // Runs on mount, when the terrain finishes loading (terrainBounds turns
  // non-null), on panel resize, and on demand via `fitToken` (View menu) —
  // deliberately *not* on every change to `fit` itself: `fit` now includes
  // the zone's placement so an explicit re-fit reflects wherever the zone
  // currently is, but auto-re-running on every drag frame of that same
  // placement is exactly what made the camera jump while moving the zone.
  // Reading the latest fit via `fitRef` decouples "what to apply" from
  // "when to apply it".
  useEffect(() => {
    // A locked camera is meant to be fully frozen, not just immune to mouse
    // pan/zoom — otherwise resizing the scene panel (which changes `size`,
    // one of this effect's triggers) would silently move a "locked" view.
    if (cameraLocked) return
    const currentFit = fitRef.current
    if (currentFit.spanX <= 0 || currentFit.spanZ <= 0) return
    const currentSpan = Math.max(currentFit.spanX, currentFit.spanZ)
    const cam = camera as THREE.OrthographicCamera
    cam.up.set(0, 0, -1)
    cam.position.set(currentFit.centerX, currentSpan * 2, currentFit.centerZ)
    cam.lookAt(currentFit.centerX, 0, currentFit.centerZ)
    const zoomX = (size.width * FIT_PADDING) / currentFit.spanX
    const zoomY = (size.height * FIT_PADDING) / currentFit.spanZ
    cam.zoom = Math.min(zoomX, zoomY)
    cam.updateProjectionMatrix()
    if (controlsRef.current) {
      controlsRef.current.target.set(currentFit.centerX, 0, currentFit.centerZ)
      controlsRef.current.update()
    }
  }, [camera, size.width, size.height, terrainBounds !== null, fitToken, cameraLocked])

  // Viewport +/- buttons (top-right of the scene panel). Multiplies zoom
  // around the current view centre — mouse-wheel zoom already goes to the
  // cursor via MapControls' zoomToCursor, this is just the button variant.
  const zoomActionTokenRef = useRef(-1)
  useEffect(() => {
    if (zoomAction.token === zoomActionTokenRef.current) return
    zoomActionTokenRef.current = zoomAction.token
    if (cameraLocked) return
    const cam = camera as THREE.OrthographicCamera
    cam.zoom = Math.max(0.01, cam.zoom * zoomAction.factor)
    cam.updateProjectionMatrix()
  }, [camera, zoomAction, cameraLocked])

  useEffect(() => {
    const dom = gl.domElement
    const plane = new THREE.Plane()
    const hit = new THREE.Vector3()

    const toNdc = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect()
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
    }

    const endDrag = () => {
      if (!dragRef.current) return
      dragRef.current = null
      // Restore to the *locked* state, not unconditionally true — otherwise
      // finishing an actor drag would silently re-enable a locked camera.
      if (controlsRef.current) controlsRef.current.enabled = !cameraLocked
    }

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || !selectedCueId) return
      const now = performance.now()
      if (now - drag.lastSent < DRAG_SEND_INTERVAL_MS) return
      drag.lastSent = now
      plane.setComponents(0, 1, 0, -drag.planeY)
      raycaster.setFromCamera(toNdc(e), camera)
      if (!raycaster.ray.intersectPlane(plane, hit) || !stageGroupRef.current) return
      const local = stageGroupRef.current.worldToLocal(hit.clone())
      let xCm = local.x / CM_TO_M
      let yCm = local.z / CM_TO_M
      const { project: proj, entries } = liveRef.current
      if (snapToGrid && proj.gridSizeCm > 0 && drag.kind !== 'handle') {
        xCm = Math.round(xCm / proj.gridSizeCm) * proj.gridSizeCm
        yCm = Math.round(yCm / proj.gridSizeCm) * proj.gridSizeCm
      }

      if (drag.kind === 'target') {
        if (drag.group) {
          // Transformation groupée : delta souris depuis le premier
          // échantillon, appliqué à la base de CHAQUE membre (les
          // écarts entre acteurs sont préservés). Snap : sur le delta.
          if (!drag.baseCursor) drag.baseCursor = { x: xCm, y: yCm }
          let dx = xCm - drag.baseCursor.x
          let dy = yCm - drag.baseCursor.y
          if (snapToGrid && proj.gridSizeCm > 0) {
            dx = Math.round(dx / proj.gridSizeCm) * proj.gridSizeCm
            dy = Math.round(dy / proj.gridSizeCm) * proj.gridSizeCm
          }
          for (const m of drag.group) {
            sidecar.setActivation(selectedCueId, m.pointId, {
              targetXCm: m.baseX + dx, targetYCm: m.baseY + dy,
            })
          }
        } else {
          sidecar.setActivation(selectedCueId, drag.pointId, { targetXCm: xCm, targetYCm: yCm })
        }
        return
      }

      const cue = proj.cues.find((c) => c.id === selectedCueId)
      const act = cue?.activations[drag.pointId]
      if (!act) return

      if (drag.kind === 'waypoint') {
        const wps = (act.pathPoints ?? []).map((wp) => ({ ...wp }))
        if (!wps[drag.index]) return
        wps[drag.index] = { ...wps[drag.index], xCm, yCm }
        sidecar.setActivation(selectedCueId, drag.pointId, { pathPoints: wps })
        return
      }

      // Poignée : offset relatif à son ancre. Alt = casser la symétrie
      // (waypoints seulement — départ/cible n'ont qu'un côté).
      const entry = entries?.[drag.pointId]
      if (!entry) return
      if (drag.anchor === 'start') {
        if (!entry.startPose) return
        sidecar.setActivation(selectedCueId, drag.pointId, {
          startHandle: { dxCm: xCm - entry.startPose[0], dyCm: yCm - entry.startPose[1] },
        })
      } else if (drag.anchor === 'target') {
        if (!entry.targetPose) return
        sidecar.setActivation(selectedCueId, drag.pointId, {
          targetHandle: { dxCm: xCm - entry.targetPose[0], dyCm: yCm - entry.targetPose[1] },
        })
      } else {
        const wps = (act.pathPoints ?? []).map((wp) => ({ ...wp }))
        const wp = wps[drag.anchor]
        if (!wp) return
        const dx = xCm - wp.xCm
        const dy = yCm - wp.yCm
        if (drag.side === 'in') {
          wp.inDxCm = dx
          wp.inDyCm = dy
          if (!e.altKey) { wp.outDxCm = -dx; wp.outDyCm = -dy }
        } else {
          wp.outDxCm = dx
          wp.outDyCm = dy
          if (!e.altKey) { wp.inDxCm = -dx; wp.inDyCm = -dy }
        }
        sidecar.setActivation(selectedCueId, drag.pointId, { pathPoints: wps })
      }
    }

    // ---- lasso (clic gauche sur le vide) + pan gauche+droit ----
    const lassoStart = (e: PointerEvent) => {
      // r3f a déjà traité le pointerdown : si un acteur/ghost/waypoint a
      // armé un drag, pas de lasso. Pas de lasso non plus en édition de
      // zone, ni au clic droit seul (pan MapControls).
      if (e.button !== 0 || dragRef.current || editingZone) return
      const rect = dom.getBoundingClientRect()
      lassoRef.current = {
        x0: e.clientX - rect.left, y0: e.clientY - rect.top,
        x1: e.clientX - rect.left, y1: e.clientY - rect.top,
        additive: e.ctrlKey || e.metaKey,
      }
    }

    const chordPan = (e: PointerEvent): boolean => {
      // Gauche+droit enfoncés ensemble : pan manuel de la caméra ortho
      // (1 px écran = 1/zoom unité monde ; up caméra = -Z, donc dy écran
      // suit +Z monde tel quel).
      if ((e.buttons & 3) !== 3 || cameraLocked) return false
      lassoRef.current = null
      onLassoRect(null)
      const cam = camera as THREE.OrthographicCamera
      const dx = -e.movementX / cam.zoom
      const dz = -e.movementY / cam.zoom
      cam.position.x += dx
      cam.position.z += dz
      if (controlsRef.current) {
        controlsRef.current.target.x += dx
        controlsRef.current.target.z += dz
        controlsRef.current.update()
      }
      return true
    }

    const lassoMove = (e: PointerEvent) => {
      if (chordPan(e)) return
      const l = lassoRef.current
      if (!l) return
      const rect = dom.getBoundingClientRect()
      l.x1 = e.clientX - rect.left
      l.y1 = e.clientY - rect.top
      if (Math.abs(l.x1 - l.x0) + Math.abs(l.y1 - l.y0) > 6) {
        onLassoRect({
          x: Math.min(l.x0, l.x1), y: Math.min(l.y0, l.y1),
          w: Math.abs(l.x1 - l.x0), h: Math.abs(l.y1 - l.y0),
        })
      }
    }

    const lassoEnd = () => {
      const l = lassoRef.current
      lassoRef.current = null
      onLassoRect(null)
      if (!l) return
      const w = Math.abs(l.x1 - l.x0)
      const h = Math.abs(l.y1 - l.y0)
      if (w < 6 && h < 6) return // simple clic sur le vide : géré ailleurs
      if (!stageGroupRef.current) return
      const rect = dom.getBoundingClientRect()
      const [minX, maxX] = [Math.min(l.x0, l.x1), Math.max(l.x0, l.x1)]
      const [minY, maxY] = [Math.min(l.y0, l.y1), Math.max(l.y0, l.y1)]
      const inside: string[] = []
      const v = new THREE.Vector3()
      for (const point of liveRef.current.project.points) {
        const pose = positionsRef.current[point.id]
        if (!pose) continue
        v.set(...stageToLocal(pose[0], pose[1], pose[2]))
        stageGroupRef.current.localToWorld(v)
        v.project(camera)
        const sx = ((v.x + 1) / 2) * rect.width
        const sy = ((1 - v.y) / 2) * rect.height
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) inside.push(point.id)
      }
      if (l.additive) {
        const current = new Set(selectedIdsRef.current)
        for (const id of inside) current.add(id)
        onSelectPoints([...current])
      } else {
        onSelectPoints(inside)
      }
    }

    const onContextMenu = (e: Event) => e.preventDefault()

    dom.addEventListener('pointermove', onMove)
    dom.addEventListener('pointerup', endDrag)
    dom.addEventListener('pointerleave', endDrag)
    dom.addEventListener('pointerdown', lassoStart)
    dom.addEventListener('pointermove', lassoMove)
    dom.addEventListener('pointerup', lassoEnd)
    dom.addEventListener('pointerleave', lassoEnd)
    dom.addEventListener('contextmenu', onContextMenu)
    return () => {
      dom.removeEventListener('pointermove', onMove)
      dom.removeEventListener('pointerup', endDrag)
      dom.removeEventListener('pointerleave', endDrag)
      dom.removeEventListener('pointerdown', lassoStart)
      dom.removeEventListener('pointermove', lassoMove)
      dom.removeEventListener('pointerup', lassoEnd)
      dom.removeEventListener('pointerleave', lassoEnd)
      dom.removeEventListener('contextmenu', onContextMenu)
    }
  }, [gl, camera, raycaster, selectedCueId, cameraLocked, snapToGrid, project.gridSizeCm, editingZone, onLassoRect, onSelectPoints])

  // Block-edit mode (§12.6): entries only trusted when the context echoes
  // the currently selected cue — a stale context from a just-deselected or
  // just-deleted cue must not draw ghosts for the wrong block.
  const editEntries: Record<string, BlockContextEntry> | null =
    selectedCueId && blockContext && blockContext.cueId === selectedCueId
      ? blockContext.entries
      : null
  liveRef.current = { project, entries: editEntries }

  // La sélection de waypoint ne survit ni au changement de bloc ni au
  // changement de point mis en avant.
  useEffect(() => { setSelectedWaypoint(null) }, [selectedCueId, selectedPointId])

  const handleWaypointDown = (e: ThreeEvent<PointerEvent>, pointId: string, index: number, zCm: number) => {
    e.stopPropagation()
    onSelectPoint(pointId)
    setSelectedWaypoint({ pointId, index })
    if (!selectedCueId) return
    dragRef.current = { kind: 'waypoint', pointId, index, planeY: zCm * CM_TO_M, lastSent: 0 }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  const handlePathHandleDown = (e: ThreeEvent<PointerEvent>, pointId: string,
                                anchor: 'start' | 'target' | number, side: 'in' | 'out', zCm: number) => {
    e.stopPropagation()
    if (typeof anchor === 'number') setSelectedWaypoint({ pointId, index: anchor })
    if (!selectedCueId) return
    dragRef.current = { kind: 'handle', pointId, anchor, side, planeY: zCm * CM_TO_M, lastSent: 0 }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  // Double-clic sur le tracé : insertion d'un waypoint à l'endroit cliqué.
  // L'index de segment vient de la fraction du parcours (échantillons
  // uniformes en longueur d'arc côté backend).
  const handleTrajectoryDoubleClick = (e: ThreeEvent<MouseEvent>, pointId: string) => {
    e.stopPropagation()
    if (!selectedCueId || !stageGroupRef.current) return
    const { project: proj, entries } = liveRef.current
    const entry = entries?.[pointId]
    const cue = proj.cues.find((c) => c.id === selectedCueId)
    const act = cue?.activations[pointId]
    if (!entry || !act || entry.path.length < 2) return
    const local = stageGroupRef.current.worldToLocal(e.point.clone())
    const xCm = local.x / CM_TO_M
    const yCm = local.z / CM_TO_M
    let best = 0
    let bestD = Infinity
    entry.path.forEach((pt, i) => {
      const d = (pt[0] - xCm) ** 2 + (pt[1] - yCm) ** 2
      if (d < bestD) { bestD = d; best = i }
    })
    const frac = best / (entry.path.length - 1)
    const wps = (act.pathPoints ?? []).map((wp) => ({ ...wp }))
    const segCount = wps.length + 1
    const segIdx = Math.min(segCount - 1, Math.floor(frac * segCount))
    const newWp: PathPoint = { xCm, yCm, inDxCm: null, inDyCm: null, outDxCm: null, outDyCm: null }
    wps.splice(segIdx, 0, newWp)
    setSelectedWaypoint({ pointId, index: segIdx })
    onSelectPoint(pointId)
    sidecar.setActivation(selectedCueId, pointId, { pathPoints: wps })
  }

  // Suppr retire le waypoint sélectionné AVANT que le raccourci global ne
  // supprime le bloc (phase capture + stopPropagation) ; Échap désélectionne
  // le waypoint sans lâcher le bloc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedWaypoint || !selectedCueId) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.stopPropagation()
        e.preventDefault()
        const { project: proj } = liveRef.current
        const cue = proj.cues.find((c) => c.id === selectedCueId)
        const act = cue?.activations[selectedWaypoint.pointId]
        if (!act) return
        const wps = (act.pathPoints ?? []).filter((_, i) => i !== selectedWaypoint.index)
        setSelectedWaypoint(null)
        sidecar.setActivation(selectedCueId, selectedWaypoint.pointId, { pathPoints: wps })
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        setSelectedWaypoint(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selectedWaypoint, selectedCueId])

  /** Positions de base des membres d'une transformation groupée : la cible
   * déjà posée dans le bloc si elle existe, sinon la position vivante. */
  const groupBases = (memberIds: string[]): { pointId: string; baseX: number; baseY: number }[] => {
    const cue = liveRef.current.project.cues.find((c) => c.id === selectedCueId)
    const out: { pointId: string; baseX: number; baseY: number }[] = []
    for (const id of memberIds) {
      const act = cue?.activations[id]
      if (act && act.targetXCm !== null && act.targetYCm !== null) {
        out.push({ pointId: id, baseX: act.targetXCm, baseY: act.targetYCm })
      } else {
        const pose = positionsRef.current[id]
        if (pose) out.push({ pointId: id, baseX: pose[0], baseY: pose[1] })
      }
    }
    return out
  }

  const handleActorPointerDown = (e: ThreeEvent<PointerEvent>, pointId: string) => {
    e.stopPropagation()
    // Glisser un acteur DÉJÀ dans la sélection multiple ne la casse pas :
    // c'est le geste "transformer la sélection". Hors sélection : simple.
    const inSelection = selectedIdsRef.current.includes(pointId)
    if (!inSelection) onSelectPoint(pointId)
    if (!selectedCueId) return
    const pose = positions[pointId]
    if (!pose) return
    // Actor height only depends on the group's Y-axis rotation, which never
    // touches Y — so local height == world height regardless of the
    // stage's placement (position/rotation) inside the terrain.
    const planeY = pose[2] * CM_TO_M
    const members = inSelection && selectedIdsRef.current.length > 1
      ? selectedIdsRef.current : [pointId]
    dragRef.current = {
      kind: 'target', pointId, planeY, lastSent: 0,
      group: members.length > 1 ? groupBases(members) : null,
      baseCursor: null,
    }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  // Grabbing a target ghost drags the same thing an actor drag edits — the
  // block's target — through the same dragRef/onMove path; only the raycast
  // plane height comes from the target pose instead of the live pose.
  const handleGhostPointerDown = (e: ThreeEvent<PointerEvent>, pointId: string, targetZCm: number) => {
    e.stopPropagation()
    onSelectPoint(pointId)
    if (!selectedCueId) return
    const inSelection = selectedIdsRef.current.includes(pointId)
    const members = inSelection && selectedIdsRef.current.length > 1
      ? selectedIdsRef.current : [pointId]
    dragRef.current = {
      kind: 'target', pointId, planeY: targetZCm * CM_TO_M, lastSent: 0,
      group: members.length > 1 ? groupBases(members) : null,
      baseCursor: null,
    }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  const emphasisFor = (pointId: string): Emphasis => {
    // Un acteur sélectionné qui n'est PAS activé dans le bloc ne doit pas
    // tout atténuer (verdict Mission 1, point c) : sans rien à mettre en
    // avant, l'atténuation générale ressemble à un état désactivé. On
    // traite ce cas comme "aucune sélection" : tout en normal.
    if (!selectedPointId || !editEntries?.[selectedPointId]) return 'normal'
    return pointId === selectedPointId ? 'highlight' : 'dim'
  }

  // drei's Grid has no true opacity/alpha control (its shader material
  // doesn't expose one) — faded toward the background colour instead, which
  // reads the same way visually for a HUD-style grid over a dark scene.
  const gridCellColor = useMemo(() => mixTowardBackground('#2b2f38', gridOpacity), [gridOpacity])
  const gridSectionColor = useMemo(() => mixTowardBackground('#3a3f4a', gridOpacity), [gridOpacity])

  return (
    <>
      <OrthographicCamera makeDefault near={0.1} far={span * 20} />
      {/* Souris 2026 : clic gauche = lasso/sélection (plus jamais la
          caméra), clic droit OU gauche+droit = pan, molette = zoom au
          curseur. Tactile : 1 doigt = sélection/drag, 2 doigts = pincer
          pour zoomer + déplacer (type iPad). */}
      <MapControls
        ref={controlsRef}
        enabled={!cameraLocked}
        enableRotate={false}
        screenSpacePanning
        zoomToCursor
        mouseButtons={MOUSE_MAPPING}
        touches={TOUCH_MAPPING}
      />
      <ambientLight intensity={editingZone ? 0.7 : 1.1} />
      <directionalLight position={[fit.centerX, span * 3, fit.centerZ]} intensity={editingZone ? 0.4 : 0.6} />

      <Suspense fallback={<GenericFloor widthM={widthM} heightM={heightM} />}>
        {project.terrainGltfPath
          ? <Terrain path={project.terrainGltfPath} onBounds={onTerrainBounds} onSnapPoints={onSnapPoints} />
          : null}
      </Suspense>

      <StageGroup project={project} groupRef={stageGroupRef}>
        {!project.terrainGltfPath && <GenericFloor widthM={widthM} heightM={heightM} />}

        <Grid
          position={[widthM / 2, 0, heightM / 2]}
          args={[widthM, heightM]}
          cellSize={project.gridSizeCm * CM_TO_M}
          sectionSize={project.gridSizeCm * CM_TO_M * 10}
          cellColor={gridCellColor}
          sectionColor={gridSectionColor}
          fadeDistance={span * 6}
          infiniteGrid={false}
        />

        <ZoneOutline widthM={widthM} heightM={heightM} editing={editingZone} />

        {editingZone && (
          <ZoneHandles
            project={project}
            widthM={widthM}
            heightM={heightM}
            stageGroupRef={stageGroupRef}
            controlsRef={controlsRef}
            snapPoints={snapPoints}
          />
        )}

        {project.points.map((point) => {
          const pose = positions[point.id]
          if (!pose) return null
          return (
            <Actor
              key={point.id}
              pose={pose}
              color={point.color}
              selected={selectedPointIds.includes(point.id)}
              draggable={Boolean(selectedCueId)}
              opacity={editEntries === null ? 1
                : editEntries[point.id] ? EDIT_ACTIVATED_OPACITY : EDIT_BYSTANDER_OPACITY}
              onPointerDown={(e) => handleActorPointerDown(e, point.id)}
            />
          )
        })}

        {/* Block-edit overlay (§12.6): every activation of the selected
            block shows its target ghost and static trajectory. By default
            all of them; selecting an actor highlights its own and dims the
            rest (context stays visible). */}
        {editEntries && project.points.map((point) => {
          const entry = editEntries[point.id]
          if (!entry) return null
          const emphasis = emphasisFor(point.id)
          return (
            <group key={`edit-${point.id}`}>
              {entry.path.length > 0 && (
                <Trajectory
                  path={entry.path}
                  color={point.color}
                  emphasis={emphasis}
                  onDoubleClick={(e) => handleTrajectoryDoubleClick(e, point.id)}
                />
              )}
              {emphasis === 'highlight' && entry.startPose && (() => {
                const cue = project.cues.find((c) => c.id === selectedCueId)
                const act = cue?.activations[point.id]
                if (!act) return null
                const zCm = entry.startPose![2]
                return (
                  <PathEditOverlay
                    entry={entry}
                    act={act}
                    color={point.color}
                    selectedIndex={selectedWaypoint?.pointId === point.id ? selectedWaypoint.index : null}
                    onWaypointDown={(e, index) => handleWaypointDown(e, point.id, index, zCm)}
                    onHandleDown={(e, anchor, side) => handlePathHandleDown(e, point.id, anchor, side, zCm)}
                  />
                )
              })()}
              {entry.targetPose && (
                <TargetGhost
                  pose={entry.targetPose}
                  color={point.color}
                  emphasis={emphasis}
                  onPointerDown={(e) => handleGhostPointerDown(e, point.id, entry.targetPose![2])}
                />
              )}
            </group>
          )
        })}
      </StageGroup>

      {editingZone && terrainBounds && (
        <DarkenMask maskBounds={terrainBounds} stageGroupRef={stageGroupRef} widthM={widthM} heightM={heightM} />
      )}
    </>
  )
}

export function Scene(props: {
  project: Project
  positions: Record<string, Pose>
  selectedPointId: string | null
  selectedPointIds: string[]
  selectedCueId: string | null
  blockContext: BlockContextMessage | null
  onSelectPoint: (pointId: string) => void
  onSelectPoints: (ids: string[]) => void
  cameraLocked: boolean
  fitToken: number
  editingZone: boolean
  gridOpacity: number
  snapToGrid: boolean
  zoomAction: { token: number; factor: number }
}) {
  // Rectangle du lasso : dessiné en HTML au-dessus du canvas (le canvas ne
  // peut pas rendre de DOM) — SceneContent pilote, ce wrapper affiche.
  const [lassoRect, setLassoRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  return (
    <div className="scene-canvas-wrap">
      <Canvas>
        <SceneContent {...props} onLassoRect={setLassoRect} />
      </Canvas>
      {lassoRect && (
        <div
          className="scene-lasso"
          style={{ left: lassoRect.x, top: lassoRect.y, width: lassoRect.w, height: lassoRect.h }}
        />
      )}
    </div>
  )
}
