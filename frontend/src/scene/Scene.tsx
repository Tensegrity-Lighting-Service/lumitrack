// Vue Dessus (top-down) — the only edit view in v1 (CONCEPTION.md §13.1.3).
// Face/Côté/3D libre (§12.4) are deferred. One react-three-fiber scene
// reused across future camera presets, per §12.4's "un seul environnement
// 3D, quatre caméras" — this file only wires up the first of the four.
//
// Editing model: click an actor to select it (Roster/Inspector follow).
// With a Cue selected in the timeline, dragging a selected actor writes its
// new x/y straight into that Cue's Activation (§13.1 point 3, "déplacement
// + rotation" in Vue Dessus) — there's nowhere else for a position edit to
// go, since Activations only exist inside a Cue. Without a Cue selected,
// actors are select-only. MapControls (pan/zoom) is disabled for the
// duration of a drag so the two gestures never fight over the same mouse
// movement.
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
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { OrthographicCamera, MapControls, Grid, useGLTF, Line } from '@react-three/drei'
import type { MapControls as MapControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { convertFileSrc } from '@tauri-apps/api/core'
import { sidecar } from '../sidecar'
import type { Project, Pose } from '../types'

const CM_TO_M = 0.01
const DRAG_SEND_INTERVAL_MS = 33 // ~30/s — matches the sidecar's own tick rate
const ACTOR_RADIUS_M = 0.4 // was 0.18 — too small to read against a full-size stage
const FIT_PADDING = 0.9 // leaves a small margin around the fit region on zoom-to-fit
const HANDLE_SIZE_M = 0.6
const ROTATE_HANDLE_OFFSET_M = 1.5

/** Stage (x_cm, y_cm depth, z_cm height) -> StageGroup-local metres
 * (X, Y up, Z). The group's own transform (position/rotation) then places
 * this into world space — children never need the placement themselves. */
function stageToLocal(x_cm: number, y_cm: number, z_cm: number): [number, number, number] {
  return [x_cm * CM_TO_M, z_cm * CM_TO_M, y_cm * CM_TO_M]
}

export interface PlanarBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Reports its actual bounding box (XZ footprint) once loaded: the terrain's
 * real-world size/origin has no necessary relation to the project's own
 * "stage" dimensions (an abstract prop-placement rectangle, not a survey of
 * the venue) — zoom-to-fit needs the real footprint to show the whole
 * model instead of whatever fraction of it overlaps the stage rectangle. */
function Terrain({ path, onBounds }: { path: string; onBounds: (bounds: PlanarBounds) => void }) {
  const url = useMemo(() => convertFileSrc(path), [path])
  const { scene } = useGLTF(url)
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene)
    onBounds({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z })
  }, [scene, onBounds])
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

function Actor({ pose, color, selected, draggable, onPointerDown }: {
  pose: Pose
  color: string
  selected: boolean
  draggable: boolean
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
}) {
  const [x_cm, y_cm, z_cm, yaw_deg] = pose
  const [x, y, z] = stageToLocal(x_cm, y_cm, z_cm)
  const yawRad = THREE.MathUtils.degToRad(yaw_deg)
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
        <meshStandardMaterial color={color} emissive={selected ? color : '#000000'} emissiveIntensity={selected ? 0.6 : 0} />
      </mesh>
      {/* Directional pointer: shows which way the carried fixture faces (§12.5). */}
      <mesh position={[0, 0, ACTOR_RADIUS_M * 1.8]}>
        <coneGeometry args={[ACTOR_RADIUS_M * 0.45, ACTOR_RADIUS_M * 1.6, 12]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Larger invisible hit target: the visible marker is small, dragging
          shouldn't require pixel-perfect aim on it. */}
      <mesh visible={false}>
        <sphereGeometry args={[ACTOR_RADIUS_M * 1.8, 8, 8]} />
      </mesh>
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

/** Move/resize/rotate handles for the "zone de jeu", only rendered while
 * editing. All three gestures raycast against a ground plane and reduce to
 * a small delta applied on top of the project's current placement:
 *  - move: world-space delta added straight to the origin (translation
 *    doesn't care about rotation).
 *  - resize: the world hit converted into the *group's own local space*
 *    (stageGroupRef.worldToLocal — lets three.js invert whatever rotation
 *    is current instead of us re-deriving trig by hand) becomes the new
 *    width/height directly, since local (0,0) is the rectangle's corner.
 *  - rotate: angle-from-pivot delta (current minus drag-start) added to the
 *    rotation at drag start — a relative delta needs no assumption about
 *    which way three.js' Y-rotation matrix winds, only that it's applied
 *    consistently between the two samples.
 */
function ZoneHandles({ project, widthM, heightM, stageGroupRef, controlsRef }: {
  project: Project
  widthM: number
  heightM: number
  stageGroupRef: React.RefObject<THREE.Group | null>
  controlsRef: React.RefObject<MapControlsImpl | null>
}) {
  const { camera, raycaster, gl } = useThree()
  const dragRef = useRef<{
    kind: DragKind
    startWorld: THREE.Vector3
    startOriginXM: number
    startOriginZM: number
    startRotationDeg: number
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
      const world = raycastGround(e)
      if (!world) return

      if (drag.kind === 'move') {
        sidecar.updateStageMap({
          originXM: drag.startOriginXM + (world.x - drag.startWorld.x),
          originZM: drag.startOriginZM + (world.z - drag.startWorld.z),
        })
      } else if (drag.kind === 'resize') {
        const group = stageGroupRef.current
        if (!group) return
        const local = group.worldToLocal(world.clone())
        sidecar.updateStageMap({
          widthCm: Math.max(10, local.x / CM_TO_M),
          heightCm: Math.max(10, local.z / CM_TO_M),
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
  }, [camera, raycaster, gl, stageGroupRef, controlsRef])

  const beginDrag = (e: ThreeEvent<PointerEvent>, kind: DragKind) => {
    e.stopPropagation()
    const world = e.point.clone()
    dragRef.current = {
      kind,
      startWorld: world,
      startOriginXM: project.stageMapOriginXM,
      startOriginZM: project.stageMapOriginZM,
      startRotationDeg: project.stageMapRotationDeg,
    }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  return (
    <>
      {/* Move: drag the whole filled zone. renderOrder + depthTest=false on
          every handle here: this is a 2D editing overlay, it must stay
          visible/on top of the terrain rather than being occluded like
          normal 3D geometry (grandstands, LED boards etc. sit above y=0 in
          a real venue survey). */}
      <mesh
        position={[widthM / 2, 0.02, heightM / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={1001}
        onPointerDown={(e) => beginDrag(e, 'move')}
        onPointerOver={() => { document.body.style.cursor = 'move' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <planeGeometry args={[widthM, heightM]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
      </mesh>

      {/* Resize: bottom-right corner (local width, height). */}
      <mesh
        position={[widthM, 0.03, heightM]}
        renderOrder={1002}
        onPointerDown={(e) => beginDrag(e, 'resize')}
        onPointerOver={() => { document.body.style.cursor = 'nwse-resize' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <boxGeometry args={[HANDLE_SIZE_M, HANDLE_SIZE_M, HANDLE_SIZE_M]} />
        <meshStandardMaterial color="#f5734f" depthTest={false} />
      </mesh>

      {/* Rotate: offset outward from the top edge (screen-up is -Z, since
          the camera's `up` is set to (0,0,-1) for the top-down view). */}
      <mesh
        position={[widthM / 2, 0.03, -ROTATE_HANDLE_OFFSET_M]}
        renderOrder={1002}
        onPointerDown={(e) => beginDrag(e, 'rotate')}
        onPointerOver={() => { document.body.style.cursor = 'grab' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <sphereGeometry args={[HANDLE_SIZE_M * 0.5, 16, 12]} />
        <meshStandardMaterial color="#4ff58c" depthTest={false} />
      </mesh>
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
function SceneContent({ project, positions, selectedPointId, selectedCueId, onSelectPoint, cameraLocked, fitToken, editingZone }: {
  project: Project
  positions: Record<string, Pose>
  selectedPointId: string | null
  selectedCueId: string | null
  onSelectPoint: (pointId: string) => void
  cameraLocked: boolean
  fitToken: number
  editingZone: boolean
}) {
  const widthM = project.stageWidthCm * CM_TO_M
  const heightM = project.stageHeightCm * CM_TO_M

  const { camera, raycaster, gl, size } = useThree()
  const controlsRef = useRef<MapControlsImpl>(null)
  const stageGroupRef = useRef<THREE.Group>(null)
  const dragRef = useRef<{ pointId: string; planeY: number; lastSent: number } | null>(null)
  const [terrainBounds, setTerrainBounds] = useState<PlanarBounds | null>(null)
  const onTerrainBounds = useCallback((b: PlanarBounds) => setTerrainBounds(b), [])

  // Fit region: the terrain's real footprint when one is loaded (its size
  // has no relation to the stage rectangle's — using the stage size cropped
  // the Belfius arena to a fraction of itself, and unioning the two added a
  // slab of empty space on the side where they don't overlap, since the
  // terrain is centred on its own origin and the stage isn't. Falls back to
  // the stage's own (mapped) footprint when there's no terrain.
  const fit = useMemo(() => {
    if (terrainBounds) {
      return {
        centerX: (terrainBounds.minX + terrainBounds.maxX) / 2,
        centerZ: (terrainBounds.minZ + terrainBounds.maxZ) / 2,
        spanX: terrainBounds.maxX - terrainBounds.minX,
        spanZ: terrainBounds.maxZ - terrainBounds.minZ,
      }
    }
    const ox = project.stageMapOriginXM
    const oz = project.stageMapOriginZM
    return { centerX: ox + widthM / 2, centerZ: oz + heightM / 2, spanX: widthM, spanZ: heightM }
  }, [widthM, heightM, terrainBounds, project.stageMapOriginXM, project.stageMapOriginZM])

  const span = Math.max(fit.spanX, fit.spanZ)

  // Sole owner of the camera's position/orientation/zoom for the top-down
  // view, and of MapControls' pan target — set here imperatively rather
  // than via the `target` JSX prop, since drei reapplies primitive props
  // every render and this component re-renders on every tick (~30/s); a
  // fresh `target={[...]}` array each render would fight the user's own
  // panning. Runs by default (mount + whenever the fit region changes) and
  // on demand via `fitToken` (View menu). Looking straight down means the
  // view direction (0,-1,0) is exactly antiparallel to Three's default
  // camera.up (0,1,0) — a degenerate case for lookAt() that three.js
  // resolves with an effectively arbitrary roll, which is what actually
  // made the terrain look tilted rather than flat (checked: every node in
  // the .glb's own rotation data is yaw-only, so the asset itself was never
  // the problem).
  useEffect(() => {
    // A locked camera is meant to be fully frozen, not just immune to mouse
    // pan/zoom — otherwise resizing the scene panel (which changes `size`,
    // one of this effect's triggers) would silently move a "locked" view.
    if (cameraLocked) return
    if (fit.spanX <= 0 || fit.spanZ <= 0) return
    const cam = camera as THREE.OrthographicCamera
    cam.up.set(0, 0, -1)
    cam.position.set(fit.centerX, span * 2, fit.centerZ)
    cam.lookAt(fit.centerX, 0, fit.centerZ)
    const zoomX = (size.width * FIT_PADDING) / fit.spanX
    const zoomY = (size.height * FIT_PADDING) / fit.spanZ
    cam.zoom = Math.min(zoomX, zoomY)
    cam.updateProjectionMatrix()
    if (controlsRef.current) {
      controlsRef.current.target.set(fit.centerX, 0, fit.centerZ)
      controlsRef.current.update()
    }
    // Depend on primitives (size.width/height, fit.centerX/centerZ/spanX/
    // spanZ), not the `size`/`fit` objects: both can get a fresh reference
    // on unrelated updates even when the actual numbers haven't changed —
    // `fit` in particular is recomputed (new object) every time the zone's
    // origin moves, even though its own useMemo ignores that value once a
    // terrain is loaded. Depending on the object itself re-ran this effect
    // on every zone drag and snapped the camera back to the fit position,
    // discarding whatever pan/zoom the user had done in between (reported
    // as "the view changes place and zoom" while moving the zone).
  }, [camera, size.width, size.height, fit.centerX, fit.centerZ, fit.spanX, fit.spanZ, span, fitToken, cameraLocked])

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
      if (raycaster.ray.intersectPlane(plane, hit) && stageGroupRef.current) {
        const local = stageGroupRef.current.worldToLocal(hit.clone())
        sidecar.setActivation(selectedCueId, drag.pointId, {
          targetXCm: local.x / CM_TO_M,
          targetYCm: local.z / CM_TO_M,
        })
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
  }, [gl, camera, raycaster, selectedCueId, cameraLocked])

  const handleActorPointerDown = (e: ThreeEvent<PointerEvent>, pointId: string) => {
    e.stopPropagation()
    onSelectPoint(pointId)
    if (!selectedCueId) return
    const pose = positions[pointId]
    if (!pose) return
    // Actor height only depends on the group's Y-axis rotation, which never
    // touches Y — so local height == world height regardless of the
    // stage's placement (position/rotation) inside the terrain.
    const planeY = pose[2] * CM_TO_M
    dragRef.current = { pointId, planeY, lastSent: 0 }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  return (
    <>
      <OrthographicCamera makeDefault near={0.1} far={span * 20} />
      <MapControls
        ref={controlsRef}
        enabled={!cameraLocked}
        enableRotate={false}
        screenSpacePanning
      />
      <ambientLight intensity={editingZone ? 0.7 : 1.1} />
      <directionalLight position={[fit.centerX, span * 3, fit.centerZ]} intensity={editingZone ? 0.4 : 0.6} />

      <Suspense fallback={<GenericFloor widthM={widthM} heightM={heightM} />}>
        {project.terrainGltfPath
          ? <Terrain path={project.terrainGltfPath} onBounds={onTerrainBounds} />
          : null}
      </Suspense>

      <StageGroup project={project} groupRef={stageGroupRef}>
        {!project.terrainGltfPath && <GenericFloor widthM={widthM} heightM={heightM} />}

        <Grid
          position={[widthM / 2, 0, heightM / 2]}
          args={[widthM, heightM]}
          cellSize={project.gridSizeCm * CM_TO_M}
          sectionSize={project.gridSizeCm * CM_TO_M * 10}
          cellColor="#2b2f38"
          sectionColor="#3a3f4a"
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
              selected={point.id === selectedPointId}
              draggable={Boolean(selectedCueId)}
              onPointerDown={(e) => handleActorPointerDown(e, point.id)}
            />
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
  selectedCueId: string | null
  onSelectPoint: (pointId: string) => void
  cameraLocked: boolean
  fitToken: number
  editingZone: boolean
}) {
  return (
    <Canvas>
      <SceneContent {...props} />
    </Canvas>
  )
}
