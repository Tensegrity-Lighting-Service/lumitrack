// Boîte de transformation type After Effects / Capture (tranches C1-C3,
// 2026-08-07) — remplace le gizmo PivotControls (SelectionTransformLegacy,
// rebranchable via USE_LEGACY_GIZMO tant que celle-ci n'est pas validée).
//
// - 8 poignées d'étirement : le point OPPOSÉ est fixe ; Maj maintenu =
//   symétrique par rapport à l'ANCRE (au centre par défaut, comme AE) ;
//   arête = un axe, coin = deux axes ratio libre.
// - Point d'ANCRAGE déplaçable : un CÔNE dont la POINTE est le pivot
//   (référence Capture) — pivot des rotations et du scale symétrique.
//   Session-only, revient au centre quand la sélection change.
// - Anneau de rotation DOUBLE-MODE autour de l'ancre : bande pleine
//   intérieure = rotation du GROUPE (positions + lacet, arcs Bézier si
//   rotation sur place) ; bord fin extérieur = rotation du LACET INDIVIDUEL
//   de chaque acteur en DELTA additif (seules les phases en mode 'fixed'
//   sont touchées — path/focus jamais, arbitrage Florian).
// - Drag de l'intérieur = déplacement (snap grille).
//
// Modèle de geste : pattern ZoneHandles (pointerdown r3f arme dragRef, un
// useEffect écoute pointermove/up/cancel sur window, raycast du plan sol
// converti en cm scène via le parent StageGroup) — PAS le onDrag de drei.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import type { MapControls as MapControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { sidecar } from '../sidecar'
import type { BlockContextEntry, Pose, Project } from '../types'
import {
  BOX_HANDLES, boundsOf, handlePointCm, oppositePointCm, rotationArc, scaleFactors,
  type Bounds, type BoxHandleDef,
} from './transformBox'
import { BOX_PAD_PX, CM_TO_M, DRAG_SEND_INTERVAL_MS, HANDLE_PX, ScreenSizedHandle, stageToLocal } from './sceneShared'

type Member = {
  pointId: string; baseX: number; baseY: number
  /** null si la phase n'est pas en mode "fixed" — path/focus sont dérivés
   * par le backend, jamais d'angle écrit (demande Florian 2026-08-01). */
  baseTravelYaw: number | null
  baseArrivalYaw: number | null
}

type BoxDragKind = 'move' | 'scale' | 'rotate-group' | 'rotate-yaw' | 'anchor'

interface BoxDrag {
  kind: BoxDragKind
  members: Member[]
  cueId: string
  bounds0: Bounds
  anchorCm: { x: number; y: number }
  startCursorCm: { x: number; y: number }
  handle: BoxHandleDef | null
  /** Poignee saisie sur la bbox PADDEE (la ou vit le visuel)... */
  handleStartCm: { x: number; y: number } | null
  /** ...et son equivalent sur la bbox REELLE des acteurs (sans la
   * marge ecran) : c'est LUI qui ancre les facteurs d'echelle — la
   * marge de 14 px faisait bouger legerement l'acteur du cote fixe
   * (retour 2026-08-07). */
  handleStartRawCm: { x: number; y: number } | null
  boundsRaw: Bounds | null
  startTheta: number
  lastTheta: number
  lastSent: number
  /** Dernieres entrees envoyees en APERCU — rejouees en ecriture
   * FINALE (non-preview) au relachement pour move/scale. */
  lastEntries: Array<Record<string, unknown> & { pointId: string }> | null
  entriesAtStart: Record<string, BlockContextEntry> | null
}

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

export function TransformBox({ project, positions, selectedCueId, selectedPointIds, controlsRef, snapToGrid, gridSizeCm, dragActiveRef, resolveGestureCue, blockEntries }: {
  project: Project
  positions: Record<string, Pose>
  selectedCueId: string
  resolveGestureCue: (pointIds: string[]) => string
  blockEntries: Record<string, BlockContextEntry> | null
  selectedPointIds: string[]
  controlsRef: React.RefObject<MapControlsImpl | null>
  snapToGrid: boolean
  gridSizeCm: number
  dragActiveRef: React.RefObject<boolean>
}) {
  const { camera, gl } = useThree()

  const membersNow = (): Member[] => {
    const cue = project.cues.find((c) => c.id === selectedCueId)
    const out: Member[] = []
    for (const id of selectedPointIds) {
      const act = cue?.activations[id]
      const pose = positions[id]
      const baseX = act?.targetXCm ?? pose?.[0]
      const baseY = act?.targetYCm ?? pose?.[1]
      if (baseX === undefined || baseX === null || baseY === undefined || baseY === null) continue
      const travelMode = act?.travelOrientationMode ?? 'fixed'
      const arrivalMode = act?.arrivalOrientationMode ?? 'hold'
      out.push({
        pointId: id, baseX, baseY,
        baseTravelYaw: travelMode === 'fixed' ? (act?.travelFixedYawDeg ?? 0) : null,
        baseArrivalYaw: arrivalMode === 'fixed' ? (act?.arrivalFixedYawDeg ?? 0) : null,
      })
    }
    return out
  }

  const live = membersNow()
  const zoomNow = (camera as THREE.OrthographicCamera).zoom || 1
  const padCm = (BOX_PAD_PX / zoomNow) / CM_TO_M
  const bounds = boundsOf(live, padCm)

  // Ancre : OFFSET relatif au centre bbox (elle suit le groupe qui bouge),
  // null = centre. Session-only, reset au changement de sélection.
  const [anchorOffset, setAnchorOffset] = useState<{ dx: number; dy: number } | null>(null)
  const selectionKey = [...selectedPointIds].sort().join('|')
  useEffect(() => { setAnchorOffset(null) }, [selectionKey])

  // Badge degres pendant une rotation (null = pas de rotation en cours) ;
  // le camembert suit le meme angle en radians.
  const [liveThetaDeg, setLiveThetaDeg] = useState<number | null>(null)
  const liveThetaRad = ((liveThetaDeg ?? 0) * Math.PI) / 180

  const dragRef = useRef<BoxDrag | null>(null)
  const rootRef = useRef<THREE.Group>(null)
  const shiftRef = useRef(false)

  // Raycast curseur -> cm scène. Le parent de rootRef porte la matrice
  // MONDE du StageGroup (terrain placé/tourné) — même précaution que le
  // fix "tu l'as juste inversée" du legacy.
  const raycasterRef = useRef(new THREE.Raycaster())
  const cursorCmFrom = (e: PointerEvent): { x: number; y: number } | null => {
    const parent = rootRef.current?.parent
    if (!parent) return null
    const rect = gl.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycasterRef.current.setFromCamera(ndc, camera)
    const hit = new THREE.Vector3()
    if (!raycasterRef.current.ray.intersectPlane(GROUND, hit)) return null
    const local = parent.worldToLocal(hit.clone())
    return { x: local.x / CM_TO_M, y: local.z / CM_TO_M }
  }

  // Handler de fin toujours frais pour le filet global (même piège de
  // hooks que le legacy : TOUT hook avant le return null conditionnel).
  const handleDragEndRef = useRef<() => void>(() => {})
  const handleMoveRef = useRef<(e: PointerEvent) => void>(() => {})
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      shiftRef.current = e.shiftKey
      if (dragRef.current) handleMoveRef.current(e)
    }
    const onUp = () => { if (dragRef.current) handleDragEndRef.current() }
    window.addEventListener('pointermove', onMove, { capture: true, passive: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove, { capture: true })
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  if (!bounds || live.length < 1) return null
  const singleMember = live.length === 1
  const { minX, minY, maxX, maxY } = bounds
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const anchorCm = {
    x: centerX + (anchorOffset?.dx ?? 0),
    y: centerY + (anchorOffset?.dy ?? 0),
  }

  const begin = (e: { stopPropagation: () => void; nativeEvent?: PointerEvent }, kind: BoxDragKind, handle: BoxHandleDef | null = null) => {
    e.stopPropagation()
    const native = (e as { nativeEvent?: PointerEvent }).nativeEvent
    if (!native) return
    const members = membersNow()
    if (members.length === 0) return
    // Lacet individuel sans aucun membre en mode fixed : ne rien armer —
    // et surtout ne pas appeler resolveGestureCue, qui peut CRÉER un bloc.
    if (kind === 'rotate-yaw'
      && !members.some((m) => m.baseTravelYaw !== null || m.baseArrivalYaw !== null)) return
    const cursor = cursorCmFrom(native)
    if (!cursor) return
    // L'ancre se déplace en local pur : pas de bloc à résoudre.
    const cueId = kind === 'anchor' ? '' : resolveGestureCue(members.map((m) => m.pointId))
    const bounds0: Bounds = { minX, minY, maxX, maxY }
    const boundsRaw = boundsOf(members, 0)
    dragRef.current = {
      kind, members, cueId, bounds0,
      anchorCm: { ...anchorCm },
      startCursorCm: cursor,
      handle,
      handleStartCm: handle ? handlePointCm(handle, bounds0) : null,
      handleStartRawCm: handle && boundsRaw ? handlePointCm(handle, boundsRaw) : null,
      boundsRaw,
      startTheta: Math.atan2(cursor.y - anchorCm.y, cursor.x - anchorCm.x),
      lastTheta: 0,
      lastSent: 0,
      lastEntries: null,
      entriesAtStart: blockEntries,
    }
    dragActiveRef.current = true
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  const handleMove = (e: PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const cursor = cursorCmFrom(e)
    if (!cursor) return

    if (drag.kind === 'anchor') {
      // Local pur, pas de throttle réseau. Aimantation douce (10 px) au
      // centre bbox et aux membres.
      const snapCm = (10 / zoomNow) / CM_TO_M
      let ax = cursor.x
      let ay = cursor.y
      const candidates = [{ x: centerX, y: centerY }, ...drag.members.map((m) => ({ x: m.baseX, y: m.baseY }))]
      for (const c of candidates) {
        if (Math.hypot(c.x - ax, c.y - ay) < snapCm) { ax = c.x; ay = c.y; break }
      }
      setAnchorOffset({ dx: ax - centerX, dy: ay - centerY })
      return
    }

    const now = performance.now()
    // Debit adaptatif (retour 2026-08-07, 'ca rame avec tout un tas
    // d'acteurs') : chaque envoi declenche une rediffusion projet
    // complete + un re-rendu global — 30/s x 78 acteurs etouffe tout.
    // ~30/s pour une poignee d'acteurs, ~8/s pour 78.
    const sendInterval = Math.max(DRAG_SEND_INTERVAL_MS, drag.members.length * 1.5)
    if (now - drag.lastSent < sendInterval) return
    drag.lastSent = now

    if (drag.kind === 'move') {
      let dx = cursor.x - drag.startCursorCm.x
      let dy = cursor.y - drag.startCursorCm.y
      if (snapToGrid && gridSizeCm > 0) {
        // Aimante le déplacement DU GROUPE à la grille (comme le legacy).
        dx = Math.round(dx / gridSizeCm) * gridSizeCm
        dy = Math.round(dy / gridSizeCm) * gridSizeCm
      }
      const entries = drag.members.map((m) => ({
        pointId: m.pointId,
        targetXCm: m.baseX + dx,
        targetYCm: m.baseY + dy,
      }))
      drag.lastEntries = entries
      sidecar.setActivationsPreview(drag.cueId, entries)
      return
    }

    if (drag.kind === 'scale' && drag.handle && drag.handleStartCm && drag.handleStartRawCm && drag.boundsRaw) {
      // Maj lu a CHAQUE move (togglable en plein geste, bases figees) :
      // point fixe = ancre (symetrique AE) ou point oppose — sur la
      // bbox REELLE des acteurs, pas la paddee : le point fixe doit
      // etre EXACTEMENT l'acteur extreme oppose, qui ne bouge plus
      // (retour 2026-08-07, 'l'ancrage d'en face bougeait un peu').
      const fixedPt = shiftRef.current ? drag.anchorCm : oppositePointCm(drag.handle, drag.boundsRaw)
      // Curseur ramene dans le referentiel reel : on retire le
      // decalage poignee-paddee -> poignee-reelle, fx = 1 pile au depart.
      const cursorAdj = {
        x: cursor.x - (drag.handleStartCm.x - drag.handleStartRawCm.x),
        y: cursor.y - (drag.handleStartCm.y - drag.handleStartRawCm.y),
      }
      const { fx, fy } = scaleFactors(drag.handle, fixedPt, drag.handleStartRawCm, cursorAdj)
      const entries = drag.members.map((m) => ({
        pointId: m.pointId,
        targetXCm: fixedPt.x + (m.baseX - fixedPt.x) * fx,
        targetYCm: fixedPt.y + (m.baseY - fixedPt.y) * fy,
      }))
      drag.lastEntries = entries
      sidecar.setActivationsPreview(drag.cueId, entries)
      return
    }

    // Rotations : angle balayé autour de l'ANCRE, convention stage
    // (atan2(y, x)) — la même que rotationArc, par construction.
    let theta = Math.atan2(cursor.y - drag.anchorCm.y, cursor.x - drag.anchorCm.x) - drag.startTheta
    // MAJ pendant une rotation = crans de 5 degres ENTIERS (demande
    // 2026-08-07) — l'angle continu reste le defaut.
    if (shiftRef.current) {
      theta = (Math.round(((theta * 180) / Math.PI) / 5) * 5 * Math.PI) / 180
    }
    drag.lastTheta = theta
    const thetaDeg = (theta * 180) / Math.PI
    setLiveThetaDeg(thetaDeg)

    if (drag.kind === 'rotate-group') {
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      sidecar.setActivationsPreview(drag.cueId, drag.members.map((m) => {
        const rx = m.baseX - drag.anchorCm.x
        const ry = m.baseY - drag.anchorCm.y
        return {
          pointId: m.pointId,
          targetXCm: drag.anchorCm.x + rx * c - ry * s,
          targetYCm: drag.anchorCm.y + rx * s + ry * c,
          ...(m.baseTravelYaw !== null || m.baseArrivalYaw !== null ? { orientationOverridden: true } : {}),
          ...(m.baseTravelYaw !== null ? { travelFixedYawDeg: m.baseTravelYaw + thetaDeg } : {}),
          ...(m.baseArrivalYaw !== null ? { arrivalFixedYawDeg: m.baseArrivalYaw + thetaDeg } : {}),
        }
      }))
      return
    }

    // rotate-yaw : SEULES les façades tournent (delta additif, phases
    // fixed uniquement) — positions et trajectoires intouchées.
    const eligible = drag.members.filter((m) => m.baseTravelYaw !== null || m.baseArrivalYaw !== null)
    sidecar.setActivationsPreview(drag.cueId, eligible.map((m) => ({
      pointId: m.pointId,
      orientationOverridden: true,
      ...(m.baseTravelYaw !== null ? { travelFixedYawDeg: m.baseTravelYaw + thetaDeg } : {}),
      ...(m.baseArrivalYaw !== null ? { arrivalFixedYawDeg: m.baseArrivalYaw + thetaDeg } : {}),
    })))
  }

  const handleDragEnd = () => {
    const drag = dragRef.current
    dragRef.current = null
    dragActiveRef.current = false
    setLiveThetaDeg(null)
    if (controlsRef.current) controlsRef.current.enabled = true
    if (!drag) return

    // Move/scale : rejouer le dernier apercu en ecriture FINALE —
    // c'est elle qui paie auto-duration + rediffusion projet, une fois.
    if ((drag.kind === 'move' || drag.kind === 'scale') && drag.lastEntries) {
      sidecar.setActivations(drag.cueId, drag.lastEntries)
      return
    }

    if (drag.kind === 'rotate-yaw' && Math.abs(drag.lastTheta) >= 1e-4) {
      // Écriture finale exacte (le dernier move peut avoir été throttlé).
      const thetaDeg = (drag.lastTheta * 180) / Math.PI
      const eligible = drag.members.filter((m) => m.baseTravelYaw !== null || m.baseArrivalYaw !== null)
      sidecar.setActivations(drag.cueId, eligible.map((m) => ({
        pointId: m.pointId,
        orientationOverridden: true,
        ...(m.baseTravelYaw !== null ? { travelFixedYawDeg: m.baseTravelYaw + thetaDeg } : {}),
        ...(m.baseArrivalYaw !== null ? { arrivalFixedYawDeg: m.baseArrivalYaw + thetaDeg } : {}),
      })))
      return
    }

    if (drag.kind !== 'rotate-group' || Math.abs(drag.lastTheta) < 1e-4) return
    // Écriture finale de la rotation de groupe : cible + ARC autour de
    // l'ANCRE + lacet — mêmes gardes que le legacy (inPlace < 50 cm,
    // rayon non nul avant d'écrire pathPoints, sinon on effacerait des
    // courbes personnalisées).
    const thetaDeg = (drag.lastTheta * 180) / Math.PI
    const finalEntries: Array<Record<string, unknown> & { pointId: string }> = []
    for (const m of drag.members) {
      const arc = rotationArc(m.baseX, m.baseY, drag.anchorCm.x, drag.anchorCm.y, drag.lastTheta)
      const startPose = drag.entriesAtStart?.[m.pointId]?.startPose ?? null
      const inPlace = startPose !== null
        && Math.hypot(startPose[0] - m.baseX, startPose[1] - m.baseY) < 50
      const r = Math.hypot(m.baseX - drag.anchorCm.x, m.baseY - drag.anchorCm.y)
      finalEntries.push({
        pointId: m.pointId,
        targetXCm: arc.targetXCm,
        targetYCm: arc.targetYCm,
        ...(inPlace && r >= 1e-6
          ? { pathPoints: arc.pathPoints, startHandle: arc.startHandle, targetHandle: arc.targetHandle }
          : {}),
        ...(m.baseTravelYaw !== null || m.baseArrivalYaw !== null ? { orientationOverridden: true } : {}),
        ...(m.baseTravelYaw !== null ? { travelFixedYawDeg: m.baseTravelYaw + thetaDeg } : {}),
        ...(m.baseArrivalYaw !== null ? { arrivalFixedYawDeg: m.baseArrivalYaw + thetaDeg } : {}),
      })
    }
    sidecar.setActivations(drag.cueId, finalEntries)
  }

  handleDragEndRef.current = handleDragEnd
  handleMoveRef.current = handleMove

  const widthM = (maxX - minX) * CM_TO_M
  const heightM = (maxY - minY) * CM_TO_M
  // Couloir reserve aux poignees sur le pourtour (px ecran -> m locaux).
  const moveInsetM = 24 / zoomNow
  const outline = [
    new THREE.Vector3(...stageToLocal(minX, minY, 0)),
    new THREE.Vector3(...stageToLocal(maxX, minY, 0)),
    new THREE.Vector3(...stageToLocal(maxX, maxY, 0)),
    new THREE.Vector3(...stageToLocal(minX, maxY, 0)),
    new THREE.Vector3(...stageToLocal(minX, minY, 0)),
  ].map((v) => new THREE.Vector3(v.x, 0.02, v.z))
  const anchorLocal = stageToLocal(anchorCm.x, anchorCm.y, 0)

  return (
    <group ref={rootRef}>
      <Line points={outline} color="#ffffff" lineWidth={2} transparent opacity={0.9}
        depthTest={false} renderOrder={1040} />

      {/* Intérieur = déplacement (plane invisible, comme ZoneHandles). */}
      <mesh
        position={[(minX + maxX) / 2 * CM_TO_M, 0.015, (minY + maxY) / 2 * CM_TO_M]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={1039}
        onPointerDown={(e) => begin(e, 'move')}
        onPointerOver={() => { document.body.style.cursor = 'move' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        {/* Retrecie d'un couloir de ~24 px : la plane s'etendait
            jusque SOUS les poignees, le survol basculait sans arret
            entre deplacement et etirement (retour 2026-08-07). */}
        <planeGeometry args={[Math.max(widthM * 0.3, widthM - 2 * moveInsetM), Math.max(heightM * 0.3, heightM - 2 * moveInsetM)]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
      </mesh>

      {/* 8 poignées d'étirement — pas pour un acteur seul. */}
      {!singleMember && BOX_HANDLES.map((h) => {
        const p = handlePointCm(h, bounds)
        return (
          <ScreenSizedHandle
            key={h.key}
            position={stageToLocal(p.x, p.y, 3)}
            sizePx={HANDLE_PX + 1}
            args={h.axis === 'x' ? [0.35, 1, 1] : h.axis === 'z' ? [1, 1, 0.35] : [1, 1, 1]}
            color="#ffffff"
            cursor={h.cursor}
            renderOrder={1042}
            hitScale={3.6}
            onPointerDown={(e) => begin(e, 'scale', h)}
          />
        )
      })}

      {/* Camembert de rotation (reference Capture, retour 2026-08-07) :
          pointe = l'ancre (le pivot), eventail a taille ECRAN constante
          — independant du zoom ET de l'etendue du groupe. Bande pleine
          a l'extremite = rotation du groupe ; bord au-dela = lacet
          individuel. Il suit l'angle pendant le geste. */}
      <RotationFan
        anchorLocal={anchorLocal}
        thetaRad={liveThetaRad}
        showGroupBand={!singleMember}
        onDownBand={(e) => begin(e, 'rotate-group')}
        onDownEdge={(e) => begin(e, 'rotate-yaw')}
      />

      {/* Ancre : cône dont la POINTE est le pivot (référence Capture). */}
      {!singleMember && (
        <AnchorCone
          anchorLocal={anchorLocal}
          onPointerDown={(e) => begin(e, 'anchor')}
        />
      )}

      {/* Badge degrés pendant une rotation. */}
      {liveThetaDeg !== null && (
        <Html position={[anchorLocal[0], 0.4, anchorLocal[2]]} center style={{ pointerEvents: 'none' }}>
          <div className="transform-angle-badge">{liveThetaDeg.toFixed(1)}°</div>
        </Html>
      )}
    </group>
  )
}

/** Camembert de rotation (reference Capture) : un eventail de ~30 deg
 * dont la POINTE est a l'ancre et qui pointe vers la droite (est), a
 * taille ECRAN CONSTANTE (groupe mis a l'echelle 1/zoom par frame —
 * geometries unite en "pixels", creees UNE fois, jamais recreees). La
 * bande pleine a l'extremite tourne le GROUPE ; le bord fin au-dela
 * tourne le LACET individuel. L'eventail suit l'angle pendant le geste. */
const FAN_HALF_RAD = (15 * Math.PI) / 180

function RotationFan({ anchorLocal, thetaRad, showGroupBand, onDownBand, onDownEdge }: {
  anchorLocal: [number, number, number]
  thetaRad: number
  showGroupBand: boolean
  onDownBand: (e: { stopPropagation: () => void; nativeEvent?: PointerEvent }) => void
  onDownEdge: (e: { stopPropagation: () => void; nativeEvent?: PointerEvent }) => void
}) {
  const scaleRef = useRef<THREE.Group>(null)
  const [hover, setHover] = useState<'band' | 'edge' | null>(null)
  useFrame(({ camera }) => {
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const s = 1 / zoom
    if (scaleRef.current) scaleRef.current.scale.set(s, s, s)
  })
  // Geometries unite (en px ecran) — creees une seule fois.
  const bandGeom = useMemo(() => new THREE.RingGeometry(96, 122, 24, 1, -FAN_HALF_RAD, 2 * FAN_HALF_RAD), [])
  const bandHitGeom = useMemo(() => new THREE.RingGeometry(80, 126, 16, 1, -FAN_HALF_RAD * 1.3, 2.6 * FAN_HALF_RAD), [])
  const edgeGeom = useMemo(() => new THREE.RingGeometry(126, 140, 24, 1, -FAN_HALF_RAD, 2 * FAN_HALF_RAD), [])
  const edgeHitGeom = useMemo(() => new THREE.RingGeometry(126, 162, 16, 1, -FAN_HALF_RAD * 1.3, 2.6 * FAN_HALF_RAD), [])
  useEffect(() => () => {
    bandGeom.dispose(); bandHitGeom.dispose(); edgeGeom.dispose(); edgeHitGeom.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const edges = useMemo(() => {
    const mk = (a: number): [number, number, number][] => [
      [0, 0, 0], [Math.cos(a) * 122, 0, Math.sin(a) * 122],
    ]
    return { top: mk(-FAN_HALF_RAD), bottom: mk(FAN_HALF_RAD) }
  }, [])
  return (
    <group position={[anchorLocal[0], 0.03, anchorLocal[2]]} rotation={[0, -thetaRad, 0]}>
      <group ref={scaleRef}>
        {/* Bords du cone : de la pointe (ancre) a la bande. */}
        <Line points={edges.top} color="#f5c84f" lineWidth={1} transparent opacity={0.5}
          depthTest={false} renderOrder={1041} />
        <Line points={edges.bottom} color="#f5c84f" lineWidth={1} transparent opacity={0.5}
          depthTest={false} renderOrder={1041} />
        {showGroupBand && (
          <>
            <mesh geometry={bandGeom} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1042}>
              <meshBasicMaterial color="#4F6DF5" transparent opacity={hover === 'band' ? 0.85 : 0.55}
                depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
            <mesh
              geometry={bandHitGeom}
              rotation={[-Math.PI / 2, 0, 0]}
              renderOrder={1041}
              onPointerDown={onDownBand}
              onPointerOver={() => { setHover('band'); document.body.style.cursor = 'grab' }}
              onPointerOut={() => { setHover(null); document.body.style.cursor = 'auto' }}
            >
              <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
          </>
        )}
        <mesh geometry={edgeGeom} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1042}>
          <meshBasicMaterial color="#f5c84f" transparent opacity={hover === 'edge' ? 0.8 : 0.4}
            depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
        <mesh
          geometry={edgeHitGeom}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={1041}
          onPointerDown={onDownEdge}
          onPointerOver={() => { setHover('edge'); document.body.style.cursor = 'alias' }}
          onPointerOut={() => { setHover(null); document.body.style.cursor = 'auto' }}
        >
          <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  )
}

/** Cône d'ancrage : géométrie unité dont la POINTE touche y=0 (le pivot),
 * mise à l'échelle écran-constante par frame (~18 px). */
function AnchorCone({ anchorLocal, onPointerDown }: {
  anchorLocal: [number, number, number]
  onPointerDown: (e: { stopPropagation: () => void; nativeEvent?: PointerEvent }) => void
}) {
  const ref = useRef<THREE.Group>(null)
  useFrame(({ camera }) => {
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const s = 18 / zoom
    if (ref.current) ref.current.scale.set(s, s, s)
  })
  return (
    <group ref={ref} position={[anchorLocal[0], 0, anchorLocal[2]]}>
      {/* Cône pointe en BAS : rotation π sur X, décalé pour que la pointe
          soit à y=0 exactement — la pointe EST le pivot. */}
      <mesh
        position={[0, 0.5, 0]}
        rotation={[Math.PI, 0, 0]}
        renderOrder={1043}
        onPointerDown={onPointerDown}
        onPointerOver={() => { document.body.style.cursor = 'grab' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <coneGeometry args={[0.35, 1, 12]} />
        <meshBasicMaterial color="#f5c84f" depthTest={false} />
      </mesh>
      {/* Hitbox élargie. */}
      <mesh
        position={[0, 0.5, 0]}
        renderOrder={1042}
        onPointerDown={onPointerDown}
        onPointerOver={() => { document.body.style.cursor = 'grab' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <sphereGeometry args={[1.1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}
