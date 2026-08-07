// Utilitaires partagés de la scène (tranche C0, 2026-08-07) — extraits de
// Scene.tsx TELS QUELS pour que TransformBox.tsx / SelectionTransformLegacy
// .tsx puissent les importer sans dépendre du gros fichier (import
// circulaire sinon). Zéro changement de comportement : pure extraction.
import { useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'

export const CM_TO_M = 0.01
export const DRAG_SEND_INTERVAL_MS = 33 // ~30/s — matches the sidecar's own tick rate
// Handles keep a constant *screen* size (px) regardless of zoom — see
// ScreenSizedHandle — rather than a fixed world size, which would shrink to
// invisible once "zoom to fit" frames a whole arena (~100m) and was the
// root of "on ne voit pas du tout les éléments de transformation".
export const HANDLE_PX = 11
export const BOX_PAD_PX = 14

export type DragKind = 'move' | 'resize' | 'rotate'

/** Stage (x_cm, y_cm depth, z_cm height) -> StageGroup-local metres
 * (X, Y up, Z). The group's own transform (position/rotation) then places
 * this into world space — children never need the placement themselves. */
export function stageToLocal(x_cm: number, y_cm: number, z_cm: number): [number, number, number] {
  return [x_cm * CM_TO_M, z_cm * CM_TO_M, y_cm * CM_TO_M]
}

/** Keeps a constant *screen* size (px) regardless of camera zoom — a fixed
 * world size would shrink to invisible once "zoom to fit" frames a whole
 * arena (~100m), which was the root of "on ne voit pas du tout les éléments
 * de transformation". `args` is the geometry's aspect ratio at unit scale
 * (e.g. [1,1,1] square, [0.35,1,1] a bar elongated along Z) — actual size
 * comes entirely from the per-frame scale below. Unlit meshBasicMaterial:
 * these are a 2D editing overlay, not scene-lit geometry. */
export function ScreenSizedHandle({ position, sizePx, args, color, onPointerDown, cursor, renderOrder }: {
  position: [number, number, number]
  sizePx: number
  args: [number, number, number]
  color: string
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
  cursor: string
  renderOrder: number
}) {
  // Zone de saisie ÉLARGIE : un carré invisible ~2.6x autour de la poignée
  // visible — attraper une poignée ne demande plus une visée au pixel.
  const hitRef = useRef<THREE.Mesh>(null)
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ camera }) => {
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const s = sizePx / zoom
    if (ref.current) ref.current.scale.set(s, s, s)
    if (hitRef.current) hitRef.current.scale.set(s * 2.6, s * 2.6, s * 2.6)
  })
  return (
    <group>
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
      <mesh
        ref={hitRef}
        position={position}
        renderOrder={renderOrder - 1}
        onPointerDown={onPointerDown}
        onPointerOver={() => { document.body.style.cursor = cursor }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <boxGeometry args={[1, 0.4, 1]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}
