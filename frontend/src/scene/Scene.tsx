// Vue Dessus (top-down) — the only edit view in v1 (CONCEPTION.md §13.1.3).
// Face/Côté/3D libre (§12.4) are deferred. One react-three-fiber scene
// reused across future camera presets, per §12.4's "un seul environnement
// 3D, quatre caméras" — this file only wires up the first of the four.
import { Suspense, useMemo, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrthographicCamera, MapControls, Grid, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Project, Pose } from '../types'

const CM_TO_M = 0.01

/** Stage (x_cm, y_cm depth, z_cm height) -> three.js world (X, Y up, Z). */
function stageToWorld(x_cm: number, y_cm: number, z_cm: number): [number, number, number] {
  return [x_cm * CM_TO_M, z_cm * CM_TO_M, y_cm * CM_TO_M]
}

function Terrain({ path }: { path: string }) {
  const url = useMemo(() => convertFileSrc(path), [path])
  const { scene } = useGLTF(url)
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

function Actor({ pose, color, selected }: { pose: Pose; color: string; selected: boolean }) {
  const [x_cm, y_cm, z_cm, yaw_deg] = pose
  const [x, y, z] = stageToWorld(x_cm, y_cm, z_cm)
  const yawRad = THREE.MathUtils.degToRad(yaw_deg)
  return (
    <group position={[x, y, z]} rotation={[0, -yawRad, 0]}>
      <mesh>
        <sphereGeometry args={[0.18, 20, 16]} />
        <meshStandardMaterial color={color} emissive={selected ? color : '#000000'} emissiveIntensity={selected ? 0.6 : 0} />
      </mesh>
      {/* Directional pointer: shows which way the carried fixture faces (§12.5). */}
      <mesh position={[0, 0, 0.32]}>
        <coneGeometry args={[0.08, 0.28, 12]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  )
}

function Rig({ widthCm, heightCm }: { widthCm: number; heightCm: number }) {
  const { camera } = useThree()
  const initialised = useRef(false)
  if (!initialised.current) {
    const span = Math.max(widthCm, heightCm) * CM_TO_M
    camera.position.set(widthCm * CM_TO_M / 2, span, heightCm * CM_TO_M / 2)
    camera.lookAt(widthCm * CM_TO_M / 2, 0, heightCm * CM_TO_M / 2)
    initialised.current = true
  }
  return null
}

export function Scene({ project, positions, selectedPointId }: {
  project: Project
  positions: Record<string, Pose>
  selectedPointId: string | null
}) {
  const widthM = project.stageWidthCm * CM_TO_M
  const heightM = project.stageHeightCm * CM_TO_M
  const span = Math.max(widthM, heightM)

  return (
    <Canvas>
      <OrthographicCamera makeDefault position={[widthM / 2, span * 2, heightM / 2]}
        zoom={60} near={0.1} far={span * 20} />
      <Rig widthCm={project.stageWidthCm} heightCm={project.stageHeightCm} />
      <MapControls target={[widthM / 2, 0, heightM / 2]} enableRotate={false} screenSpacePanning />
      <ambientLight intensity={1.1} />
      <directionalLight position={[widthM, span * 3, heightM]} intensity={0.6} />

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
          ? <Terrain path={project.terrainGltfPath} />
          : <GenericFloor widthCm={project.stageWidthCm} heightCm={project.stageHeightCm} />}
      </Suspense>

      {project.points.map((point) => {
        const pose = positions[point.id]
        if (!pose) return null
        return (
          <Actor key={point.id} pose={pose} color={point.color}
            selected={point.id === selectedPointId} />
        )
      })}
    </Canvas>
  )
}
