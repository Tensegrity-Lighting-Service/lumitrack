// ANCIEN gizmo de sélection (PivotControls de drei) — extrait TEL QUEL de
// Scene.tsx (tranche C0, 2026-08-07) pour rester rebranchable en une ligne
// (USE_LEGACY_GIZMO dans Scene.tsx) pendant la validation de la nouvelle
// TransformBox. À SUPPRIMER une fois la TransformBox validée par Florian.
// Historique complet du composant : voir les commentaires ci-dessous et
// l'historique git de Scene.tsx.
import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { Line, PivotControls } from '@react-three/drei'
import type { MapControls as MapControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { sidecar } from '../sidecar'
import type { BlockContextEntry, Pose, Project } from '../types'
import { boundsOf, rotationArc } from './transformBox'
import { BOX_PAD_PX, CM_TO_M, DRAG_SEND_INTERVAL_MS, stageToLocal, type DragKind } from './sceneShared'

/** Boîte de transformation de la sélection multiple — remplace le gizmo
 * fabriqué à la main (instable près du pivot en rotation, course avec le
 * lasso jamais totalement fiable) par `PivotControls` de drei (2026-08-01,
 * demande explicite de Florian après plusieurs tentatives ratées :
 * "on décortique ça ensemble" — préférer une librairie éprouvée à du code
 * maison pour ce genre d'interaction). `autoTransform={false}` : on
 * n'attache aucun objet réel au gizmo (la "sélection" est virtuelle, ce
 * sont des positions d'activation, pas des meshes) — `onDrag` reçoit la
 * matrice delta et on l'applique nous-mêmes à chaque acteur, exactement le
 * même principe que le geste précédent (calcul de cible + écriture via
 * `sidecar.setActivation`), juste piloté par un gizmo éprouvé plutôt que
 * des poignées maison. `activeAxes={[true, false, true]}` limite aux
 * translations X/Z (le sol) + UNE seule bague de rotation (autour de Y,
 * la verticale) — cf. le code source de PivotControls : la bague de
 * rotation autour d'un axe n'apparaît que si les deux AUTRES axes sont
 * actifs, donc désactiver Y masque justement les bagues X et Z tout en
 * gardant celle-ci.
 *
 * Changement de comportement assumé : le redimensionnement (poignées
 * d'angle/d'arête) ancrait l'angle OPPOSÉ avant ; les sphères de mise à
 * l'échelle de PivotControls redimensionnent depuis le CENTRE du pivot
 * (le centre du groupe sélectionné) — plus prévisible pour "resserrer/
 * écarter une formation", à valider à l'usage.
 */
export function SelectionTransformLegacy({ project, positions, selectedCueId, selectedPointIds, controlsRef, snapToGrid, gridSizeCm, dragActiveRef, resolveGestureCue, blockEntries }: {
  project: Project
  positions: Record<string, Pose>
  selectedCueId: string
  /** Fournit le cue où écrire le geste — le bloc actif, sinon le bloc
   * GOUVERNANT les membres au playhead (fix 2026-08-06 : "quand je bouge
   * une sélection alors qu'il y a un bloc au playhead il crée un nouveau
   * bloc au lieu d'éditer l'actuel"), sinon un bloc créé au playhead
   * (fix 2026-08-05 : gizmo silencieusement inerte sans bloc actif). */
  resolveGestureCue: (pointIds: string[]) => string
  /** Entrées du contexte du bloc actif (départ/cible résolus par le
   * backend) — sert à décider si l'arc de rotation a un sens (voir
   * handleDragEnd). null hors mode édition de bloc. */
  blockEntries: Record<string, BlockContextEntry> | null
  selectedPointIds: string[]
  controlsRef: React.RefObject<MapControlsImpl | null>
  snapToGrid: boolean
  gridSizeCm: number
  /** Partagé avec le lasso de la scène parente (voir son commentaire) : ce
   * composant a son propre dragRef, invisible sans ce pont. */
  dragActiveRef: React.RefObject<boolean>
}) {
  const { camera, gl } = useThree()

  type Member = {
    pointId: string; baseX: number; baseY: number
    /** null si cette phase n'est pas en mode "fixed" — "path"/"focus" sont
     * dérivés de la position par le backend, une rotation de groupe ne
     * doit jamais leur écrire d'angle (demande de Florian, 2026-08-01 :
     * "une transformation rotation d'un groupe ne doit pas changer" le
     * pivot d'un acteur gouverné par path/focus ; étendu à l'indépendance
     * trajet/arrivée le 2026-08-04). */
    baseTravelYaw: number | null
    baseArrivalYaw: number | null
  }
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
  // Marge de la boîte en PIXELS écran (constante au zoom) : la boîte
  // dépasse la sélection de ~14 px, elle reste lisible à toute échelle.
  const zoomNow = (camera as THREE.OrthographicCamera).zoom || 1
  const padCm = (BOX_PAD_PX / zoomNow) / CM_TO_M
  const bounds = boundsOf(live, padCm)

  const dragRef = useRef<{
    kind: DragKind
    members: Member[]
    centerX: number
    centerY: number
    lastTheta: number
    lastSent: number
    /** Cue où ce geste écrit (bloc actif, gouvernant, ou créé au début
     * du geste — voir resolveGestureCue). */
    cueId: string
    /** Écartement (poignées sphères) : distance ÉCRAN curseur→centre au
     * début du geste + centre projeté à l'écran (fix 2026-08-06, "ça
     * n'écarte pas autant que je tire") — le facteur de PivotControls
     * est relatif à la taille du gizmo, pas au curseur réel, l'écart
     * traînait derrière la souris. On suit le curseur nous-mêmes. */
    resize: { startDist: number; screenCx: number; screenCy: number } | null
  } | null>(null)
  // Position réelle du curseur, entretenue pendant tout le cycle de vie du
  // composant (utilisée par le facteur d'écartement ci-dessus).
  const cursorRef = useRef({ x: 0, y: 0 })
  // Groupe racine : porte la matrice MONDE héritée du StageGroup (le
  // terrain peut être placé/tourné dans le monde) — indispensable pour
  // projeter correctement le centre à l'écran.
  const rootRef = useRef<THREE.Group>(null)

  // Filet de sécurité : si PivotControls ne redéclenche pas onDragEnd pour
  // une raison ou une autre (relâchement hors fenêtre, sélection changée
  // en plein geste, etc.), dragActiveRef resterait bloqué à true POUR
  // TOUJOURS — et avec lui, TOUS les lassos suivants seraient
  // silencieusement ignorés (2026-08-01, signalé par Florian).
  //
  // DOIT vivre AVANT le `return null` conditionnel ci-dessous (fix
  // 2026-08-04, attrapé par le nouvel ErrorBoundary : "Rendered more hooks
  // than during the previous render" — un hook après un retour anticipé
  // change le NOMBRE de hooks rendus dès que la sélection passe de vide à
  // non-vide, interdit par React). handleDragEnd n'existant qu'après ce
  // point, on passe par une ref toujours à jour.
  const handleDragEndRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onGlobalPointerUp = () => {
      if (dragRef.current) handleDragEndRef.current()
    }
    const onGlobalPointerMove = (e: PointerEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointerup', onGlobalPointerUp)
    window.addEventListener('pointercancel', onGlobalPointerUp)
    window.addEventListener('pointermove', onGlobalPointerMove, { capture: true, passive: true })
    return () => {
      window.removeEventListener('pointerup', onGlobalPointerUp)
      window.removeEventListener('pointercancel', onGlobalPointerUp)
      window.removeEventListener('pointermove', onGlobalPointerMove, { capture: true })
    }
  }, [])

  if (!bounds || live.length < 1) return null
  const singleMember = live.length === 1
  const { minX, minY, maxX, maxY } = bounds
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const matrix = new THREE.Matrix4().makeTranslation(...stageToLocal(centerX, centerY, 0))
  // La bague de rotation (et les autres poignées) doit dépasser l'étendue
  // du groupe, pas rester collée au pivot central — sinon elle semble
  // "trop près" pour une sélection large (signalé 2026-08-01). `scale` de
  // PivotControls est un rayon en PIXELS ÉCRAN (fixed=true) ; on le calcule
  // depuis la demi-diagonale du groupe (cm -> px, même conversion que
  // padCm juste au-dessus, inversée) avec 30% de marge, jamais en dessous
  // d'un plancher pour qu'un acteur seul reste saisissable.
  const halfDiagCm = Math.hypot(maxX - centerX, maxY - centerY)
  const gizmoScalePx = Math.max(70, halfDiagCm * CM_TO_M * zoomNow * 1.3)

  const kindFor = (component: string): DragKind =>
    component === 'Rotator' ? 'rotate' : component === 'Sphere' ? 'resize' : 'move'

  const handleDragStart: NonNullable<React.ComponentProps<typeof PivotControls>['onDragStart']> = (props) => {
    const members = membersNow()
    if (members.length === 0) return
    // Bloc actif > bloc gouvernant au playhead > création (resolveGestureCue,
    // fixes 2026-08-05/06) — avant, le geste était silencieusement ignoré
    // puis créait un bloc même quand un bloc gouvernait déjà les acteurs.
    const cueId = resolveGestureCue(members.map((m) => m.pointId))
    const kind = kindFor(props.component)
    let resize: { startDist: number; screenCx: number; screenCy: number } | null = null
    if (kind === 'resize') {
      // Centre du groupe projeté à l'écran + distance initiale du curseur :
      // le facteur d'écartement suivra le curseur RÉEL (pas le facteur de
      // PivotControls, relatif à la taille du gizmo — l'écart traînait).
      // localToWorld d'abord (fix 2026-08-06, "tu l'as juste inversée") :
      // stageToLocal donne des coordonnées LOCALES au StageGroup, et le
      // terrain est placé/tourné dans le monde — projeter le point local
      // tel quel plaçait le "centre écran" ailleurs, et le rapport de
      // distances pouvait s'inverser selon la direction du geste.
      const world = new THREE.Vector3(...stageToLocal(centerX, centerY, 0))
      rootRef.current?.parent?.localToWorld(world)
      const ndc = world.project(camera)
      const rect = gl.domElement.getBoundingClientRect()
      const screenCx = rect.left + ((ndc.x + 1) / 2) * rect.width
      const screenCy = rect.top + ((1 - ndc.y) / 2) * rect.height
      const startDist = Math.max(8, Math.hypot(cursorRef.current.x - screenCx, cursorRef.current.y - screenCy))
      resize = { startDist, screenCx, screenCy }
    }
    dragRef.current = { kind, members, centerX, centerY, lastTheta: 0, lastSent: 0, cueId, resize }
    dragActiveRef.current = true
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  const handleDrag: NonNullable<React.ComponentProps<typeof PivotControls>['onDrag']> = (_l, deltaL) => {
    const drag = dragRef.current
    if (!drag) return
    const now = performance.now()
    if (now - drag.lastSent < DRAG_SEND_INTERVAL_MS) return
    drag.lastSent = now

    // Écartement : facteur = rapport des distances ÉCRAN curseur→centre —
    // l'écart suit exactement le geste ("ça n'écarte pas autant que je
    // tire", 2026-08-06). Homothétie autour du centre du groupe.
    if (drag.kind === 'resize' && drag.resize) {
      const dist = Math.hypot(cursorRef.current.x - drag.resize.screenCx, cursorRef.current.y - drag.resize.screenCy)
      const factor = Math.max(0.02, dist / drag.resize.startDist)
      sidecar.setActivations(drag.cueId, drag.members.map((m) => ({
        pointId: m.pointId,
        targetXCm: drag.centerX + (m.baseX - drag.centerX) * factor,
        targetYCm: drag.centerY + (m.baseY - drag.centerY) * factor,
      })))
      return
    }

    let effectiveDelta = deltaL
    if (drag.kind === 'move' && snapToGrid && gridSizeCm > 0) {
      // Aimante le déplacement DU GROUPE (pas les rotations/mises à
      // l'échelle) à la grille — reconstruit une translation pure aimantée
      // plutôt que de laisser chaque membre s'aimanter indépendamment.
      const centerLocal = new THREE.Vector3(...stageToLocal(drag.centerX, drag.centerY, 0))
      const centerNew = centerLocal.clone().applyMatrix4(deltaL)
      const dxCm = Math.round(((centerNew.x - centerLocal.x) / CM_TO_M) / gridSizeCm) * gridSizeCm
      const dzCm = Math.round(((centerNew.z - centerLocal.z) / CM_TO_M) / gridSizeCm) * gridSizeCm
      effectiveDelta = new THREE.Matrix4().makeTranslation(dxCm * CM_TO_M, 0, dzCm * CM_TO_M)
    }

    // Angle balayé depuis le début du geste, dérivé du MÊME transform que
    // la position ci-dessous (jamais décomposé "à l'aveugle" en Euler
    // depuis la matrice) : un point de référence à 1 m du pivot, avant/
    // après application du delta, donne l'angle exactement dans la
    // convention stage (atan2(y,x)) déjà utilisée par rotationArc, parce
    // que stageToLocal ne fait qu'une mise à l'échelle sans retourner
    // aucun axe (X->X, Y->Z) — la cohérence entre la position affichée
    // pendant le geste et le lacet final est garantie par construction,
    // pas par une déduction séparée qui pourrait diverger en signe.
    const centerLocal = new THREE.Vector3(...stageToLocal(drag.centerX, drag.centerY, 0))
    const centerNew = centerLocal.clone().applyMatrix4(effectiveDelta)
    const refLocal = new THREE.Vector3(...stageToLocal(drag.centerX + 100, drag.centerY, 0))
    const refNew = refLocal.clone().applyMatrix4(effectiveDelta)
    const a0 = Math.atan2(refLocal.z - centerLocal.z, refLocal.x - centerLocal.x)
    const a1 = Math.atan2(refNew.z - centerNew.z, refNew.x - centerNew.x)
    drag.lastTheta = a1 - a0
    // Pendant le geste, le lacet suit en direct (pas seulement au lâcher) —
    // sinon la façade de l'acteur ne pivote qu'un coup sec à la fin,
    // signalé comme "pas en temps réel". L'arc/tracé final (plus coûteux,
    // avec poignées Bézier) reste calculé uniquement au relâchement.
    const thetaDegLive = (drag.lastTheta * 180) / Math.PI

    // UN message groupé par échantillon (optimisation 2026-08-06) — la
    // version par-membre faisait rediffuser le projet N fois par sample.
    const rotating = drag.kind === 'rotate'
    sidecar.setActivations(drag.cueId, drag.members.map((m) => {
      const qLocal = new THREE.Vector3(...stageToLocal(m.baseX, m.baseY, 0))
      const qNew = qLocal.clone().applyMatrix4(effectiveDelta)
      return {
        pointId: m.pointId,
        targetXCm: qNew.x / CM_TO_M, targetYCm: qNew.z / CM_TO_M,
        ...(rotating && (m.baseTravelYaw !== null || m.baseArrivalYaw !== null)
          ? { orientationOverridden: true } : {}),
        ...(rotating && m.baseTravelYaw !== null
          ? { travelFixedYawDeg: m.baseTravelYaw + thetaDegLive } : {}),
        ...(rotating && m.baseArrivalYaw !== null
          ? { arrivalFixedYawDeg: m.baseArrivalYaw + thetaDegLive } : {}),
      }
    }))
  }

  const handleDragEnd = () => {
    const drag = dragRef.current
    dragRef.current = null
    dragActiveRef.current = false
    if (controlsRef.current) controlsRef.current.enabled = true
    if (!drag || drag.kind !== 'rotate' || Math.abs(drag.lastTheta) < 1e-4) return
    // Écriture finale de la rotation : cible + ARC autour du centre +
    // lacet tourné du même angle (identique à avant le passage à drei).
    const thetaDeg = (drag.lastTheta * 180) / Math.PI
    const finalEntries: Array<Record<string, unknown> & { pointId: string }> = []
    for (const m of drag.members) {
      const arc = rotationArc(m.baseX, m.baseY, drag.centerX, drag.centerY, drag.lastTheta)
      // L'arc de rotation ne décrit le CHEMIN du bloc que si l'acteur
      // TOURNE SUR PLACE — départ résolu du bloc ≈ position d'avant
      // rotation. Pour un bloc qui AMÈNE l'acteur d'ailleurs (entrée
      // backstage, déplacement), greffer l'arc sur ce départ produisait
      // des trajectoires en crochet absurdes (signalé 2026-08-06,
      // "déplacement de bloc + écartement + rotation : les courbes ne
      // vont pas"). Dans ce cas, la rotation ne change que la cible.
      const startPose = blockEntries?.[m.pointId]?.startPose ?? null
      const inPlace = startPose !== null
        && Math.hypot(startPose[0] - m.baseX, startPose[1] - m.baseY) < 50
      // Un acteur seul (ou exactement sur le pivot) ne suit aucun arc —
      // rotationArc renvoie alors pathPoints/startHandle/targetHandle à
      // null, et les envoyer quand même EFFAÇAIT silencieusement toute
      // courbe personnalisée déjà posée sur cet acteur à chaque simple
      // rotation du lacet (signalé 2026-08-01 : "tourner le lacet
      // réinitialise la courbe de l'acteur") — ces champs ne doivent être
      // touchés que quand un arc réel a été calculé (groupe, rayon non nul).
      const r = Math.hypot(m.baseX - drag.centerX, m.baseY - drag.centerY)
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

  // Voir le useEffect "filet de sécurité" AVANT le retour anticipé plus
  // haut — cette ref lui fournit toujours la dernière version du handler.
  handleDragEndRef.current = handleDragEnd

  const outline = [
    new THREE.Vector3(...stageToLocal(minX, minY, 0)),
    new THREE.Vector3(...stageToLocal(maxX, minY, 0)),
    new THREE.Vector3(...stageToLocal(maxX, maxY, 0)),
    new THREE.Vector3(...stageToLocal(minX, maxY, 0)),
    new THREE.Vector3(...stageToLocal(minX, minY, 0)),
  ].map((v) => new THREE.Vector3(v.x, 0.02, v.z))

  return (
    <group ref={rootRef}>
      {/* Contour de l'étendue de la sélection — PivotControls ne dessine
          que le gizmo au pivot, pas un cadre autour de l'étendue. */}
      <Line points={outline} color="#ffffff" lineWidth={2} transparent opacity={0.9}
        depthTest={false} renderOrder={1040} />
      <PivotControls
        matrix={matrix}
        autoTransform={false}
        activeAxes={[true, false, true]}
        disableScaling={singleMember}
        disableSliders={false}
        fixed
        scale={gizmoScalePx}
        lineWidth={2.5}
        axisColors={['#4F6DF5', '#4F6DF5', '#4F6DF5']}
        hoveredColor="#f5c84f"
        depthTest={false}
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
      />
    </group>
  )
}
