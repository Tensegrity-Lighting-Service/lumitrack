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
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { OrthographicCamera, MapControls, Grid, useGLTF } from '@react-three/drei'
import type { MapControls as MapControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { convertFileSrc } from '@tauri-apps/api/core'
import { sidecar } from '../sidecar'
import type { Project, Pose } from '../types'

const CM_TO_M = 0.01
const DRAG_SEND_INTERVAL_MS = 33 // ~30/s — matches the sidecar's own tick rate
const ACTOR_RADIUS_M = 0.4 // was 0.18 — too small to read against a full-size stage
const FIT_PADDING = 0.9 // leaves a small margin around the stage on zoom-to-fit

/** Stage (x_cm, y_cm depth, z_cm height) -> three.js world (X, Y up, Z). */
function stageToWorld(x_cm: number, y_cm: number, z_cm: number): [number, number, number] {
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

function GenericFloor({ widthCm, heightCm }: { widthCm: number; heightCm: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[widthCm * CM_TO_M / 2, 0, heightCm * CM_TO_M / 2]}>
      <planeGeometry args={[widthCm * CM_TO_M, heightCm * CM_TO_M]} />
      <meshStandardMaterial color="#1b1e26" />
    </mesh>
  )
}

function Actor({ pose, color, selected, draggable, onPointerDown }: {
  pose: Pose
  color: string
  selected: boolean
  draggable: boolean
  onPointerDown: (e: ThreeEvent<PointerEvent>, worldY: number) => void
}) {
  const [x_cm, y_cm, z_cm, yaw_deg] = pose
  const [x, y, z] = stageToWorld(x_cm, y_cm, z_cm)
  const yawRad = THREE.MathUtils.degToRad(yaw_deg)
  return (
    <group
      position={[x, y, z]}
      rotation={[0, -yawRad, 0]}
      onPointerDown={(e) => onPointerDown(e, y)}
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

/** Everything that needs useThree() (raycasting against the actual camera)
 * lives here, as a child of <Canvas>. Owns the one active drag gesture:
 * pointerdown on an actor arms it, pointermove raycasts against a
 * horizontal plane at the actor's height and throttles setActivation calls,
 * pointerup releases MapControls again. */
function SceneContent({ project, positions, selectedPointId, selectedCueId, onSelectPoint, cameraLocked, fitToken }: {
  project: Project
  positions: Record<string, Pose>
  selectedPointId: string | null
  selectedCueId: string | null
  onSelectPoint: (pointId: string) => void
  cameraLocked: boolean
  fitToken: number
}) {
  const widthM = project.stageWidthCm * CM_TO_M
  const heightM = project.stageHeightCm * CM_TO_M

  const { camera, raycaster, gl, size } = useThree()
  const controlsRef = useRef<MapControlsImpl>(null)
  const dragRef = useRef<{ pointId: string; planeY: number; lastSent: number } | null>(null)
  const [terrainBounds, setTerrainBounds] = useState<PlanarBounds | null>(null)
  const onTerrainBounds = useCallback((b: PlanarBounds) => setTerrainBounds(b), [])

  // "Fit" region = union of the declared stage rectangle and the actual
  // terrain footprint. The two have no necessary relation (the stage is an
  // abstract prop-placement rectangle; the terrain is a real venue survey,
  // often centred on its own origin) — using only the stage size cropped
  // the Belfius arena to a fraction of itself (observed 2026-07-28) because
  // the demo stage (60x40m) is smaller than the venue (~100m) and not even
  // centred on the same point.
  const fit = useMemo(() => {
    let minX = 0, maxX = widthM, minZ = 0, maxZ = heightM
    if (terrainBounds) {
      minX = Math.min(minX, terrainBounds.minX)
      maxX = Math.max(maxX, terrainBounds.maxX)
      minZ = Math.min(minZ, terrainBounds.minZ)
      maxZ = Math.max(maxZ, terrainBounds.maxZ)
    }
    return { centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2, spanX: maxX - minX, spanZ: maxZ - minZ }
  }, [widthM, heightM, terrainBounds])

  const span = Math.max(fit.spanX, fit.spanZ)

  // Sole owner of the camera's position/orientation/zoom for the top-down
  // view, and of MapControls' pan target — set here imperatively rather
  // than via the `target` JSX prop, since drei reapplies primitive props
  // every render and this component re-renders on every tick (~30/s); a
  // fresh `target={[...]}` array each render would fight the user's own
  // panning. Runs by default (mount + whenever the fit region changes, e.g.
  // stage resize or the terrain finishing loading) and on demand via
  // `fitToken` (View menu). Looking straight down means the view direction
  // (0,-1,0) is exactly antiparallel to Three's default camera.up (0,1,0) —
  // a degenerate case for lookAt() that three.js resolves with an
  // effectively arbitrary roll, which is what actually made the terrain
  // look tilted rather than flat (checked: every node in the .glb's own
  // rotation data is yaw-only, so the asset itself was never the problem).
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
    // Depend on size.width/height (primitives), not the `size` object: r3f
    // may publish a new size object on store updates even when the actual
    // pixel dimensions haven't changed, which would silently re-run this
    // fit every such update and could look like the view fighting itself.
  }, [camera, size.width, size.height, fit, span, fitToken, cameraLocked])

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
      if (raycaster.ray.intersectPlane(plane, hit)) {
        sidecar.setActivation(selectedCueId, drag.pointId, {
          targetXCm: hit.x / CM_TO_M,
          targetYCm: hit.z / CM_TO_M,
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

  const handleActorPointerDown = (e: ThreeEvent<PointerEvent>, worldY: number, pointId: string) => {
    e.stopPropagation()
    onSelectPoint(pointId)
    if (!selectedCueId) return
    dragRef.current = { pointId, planeY: worldY, lastSent: 0 }
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
      <ambientLight intensity={1.1} />
      <directionalLight position={[fit.centerX, span * 3, fit.centerZ]} intensity={0.6} />

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

      <Suspense fallback={<GenericFloor widthCm={project.stageWidthCm} heightCm={project.stageHeightCm} />}>
        {project.terrainGltfPath
          ? <Terrain path={project.terrainGltfPath} onBounds={onTerrainBounds} />
          : <GenericFloor widthCm={project.stageWidthCm} heightCm={project.stageHeightCm} />}
      </Suspense>

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
            onPointerDown={(e, worldY) => handleActorPointerDown(e, worldY, point.id)}
          />
        )
      })}
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
}) {
  return (
    <Canvas>
      <SceneContent {...props} />
    </Canvas>
  )
}
