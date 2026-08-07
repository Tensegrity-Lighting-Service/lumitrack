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
import { Suspense, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Canvas, useThree, useFrame, type ThreeEvent } from '@react-three/fiber'
import { OrthographicCamera, MapControls, useGLTF, Line, Html } from '@react-three/drei'
import type { MapControls as MapControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { fileSrc } from '../fileSrc'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { sidecar, useTick } from '../sidecar'
import type { Activation, BackstageZone, BlockContextEntry, BlockContextMessage, Cue, PathPoint, Point, Project, Pose } from '../types'
import { openContextMenu } from '../ui/contextMenuStore'
import { buildActorContextMenuSections, buildFocusPointContextMenuSections } from '../ui/actorContextMenu'
import { t, t as t2 } from '../i18n'

// Outils du hit-test 2D des acteurs (module-level, reutilises).
const PICK_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const PICK_RAYCASTER = new THREE.Raycaster()
const PICK_HIT = new THREE.Vector3()
const PICK_NDC = new THREE.Vector2()

// Reference STABLE pour 'aucun tick encore' (evite un nouvel objet par rendu).
const EMPTY_POSITIONS: Record<string, Pose> = {}
import { CM_TO_M, DRAG_SEND_INTERVAL_MS, HANDLE_PX, stageToLocal, ScreenSizedHandle, type DragKind } from './sceneShared'
import { useDragOverrides, setDragOverrides, clearDragOverrides } from './dragOverride'
import { TransformBox } from './TransformBoxGizmo'
import { gradientColors, chevronPlacements, zoomBucket, darkenHex } from './trajectoryViz'
import { SELECT_WAYPOINT_EVENT } from '../timeline/waypoints'

// Redesign 2026-08-04 (Florian: "les acteurs sont vraiment petits sur un
// terrain de cette taille, et à l'inverse le point sélectionné est trop
// gros trop vulgaire") — replaced the old sphere with a flat disc, same
// idea (§12.5's directional marker). Tried screen-constant sizing (like
// GHOST_PX below) to fix "too small at zoom-to-fit" — round-tripped with
// Florian and explicitly REJECTED: it grows the marker's WORLD footprint
// without bound as the camera zooms out, so a backstage line-up (actors
// 60cm apart, BACKSTAGE_SPACING_CM) blows up into an overlapping blob —
// and even tuned down, a screen-constant size stops looking proportioned to
// the real stage ("on ne comprend plus rien"). Florian's call: a FIXED
// world size, true to real scale (his own reference — "la taille des
// épaules d'une personne, ou la longueur d'un tube Astera") — zoom in if
// you need to see detail, exactly like a real venue. Confirmé à 60cm de
// diamètre. Devenu un réglage PROJET (`Project.actorDiameterCm`, menu
// Réglages) plutôt qu'une constante à la demande de Florian — le fixture
// réellement porté varie d'un show à l'autre.
const FIT_PADDING = 0.9 // leaves a small margin around the fit region on zoom-to-fit
// Handles keep a constant *screen* size (px) regardless of zoom — see
// ScreenSizedMesh — rather than a fixed world size, which would shrink to
// invisible once "zoom to fit" frames a whole arena (~100m) and was the
// root of "on ne voit pas du tout les éléments de transformation".
const ROTATE_HANDLE_PX = 9
const ROTATE_HANDLE_OFFSET_PX = 40 // distance above the top edge, same constant-screen-size logic
const SNAP_RADIUS_M = 0.6
// Badge numéro/abrégé sur chaque acteur, comme Stancz (le numéro affiché
// dans son UI, cf. CONCEPTION.md §1.3 — "candidat naturel pour l'ID de
// tracker"). Taille écran constante : doit rester lisible même au zoom-to-
// fit d'un stade entier, là où la sphère elle-même ne fait que quelques px.
const ACTOR_LABEL_PX = 18
// Waypoints/poignées du tracé spatial : mêmes règles d'échelle écran.
const WAYPOINT_PX = 9
// Point de focus (mission "modes d'orientation", 2026-08-04) : un simple
// repère de visée, pas un acteur — taille écran constante comme le reste de
// ce vocabulaire visuel (contrairement à l'acteur, redevenu taille fixe en
// espace réel : un point de focus n'a pas d'occupation physique réelle à
// représenter fidèlement, juste un repère à toujours voir).
const FOCUS_MARKER_PX = 16
const PATH_HANDLE_PX = 6
// Live-state dimming in block-edit mode (§12.6): activated actors stay
// readable, the rest is context; the ghosts/trajectories are the subject.
// Transparence du mode edition SUPPRIMEE (demande 2026-08-07, 'supprime
// la transparence des acteurs lorsqu'un bloc est selectionne') : les
// acteurs restent pleinement lisibles, seuls ghosts/trajectoires
// gardent leur systeme d'emphase.
const EDIT_ACTIVATED_OPACITY = 1
const EDIT_BYSTANDER_OPACITY = 1
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
// Clic molette : AUCUNE action (le dolly au drag molette était trop
// brutal — retiré à la demande de Florian). Le zoom reste sur la molette
// qui tourne, amorti, au pointeur.
const MOUSE_MAPPING = { LEFT: undefined as unknown as THREE.MOUSE, MIDDLE: undefined as unknown as THREE.MOUSE, RIGHT: THREE.MOUSE.PAN }
const TOUCH_MAPPING = { ONE: undefined as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN }

// Bornes du zoom orthographique (px par mètre-monde, en gros). MIN dézoome
// jusqu'à voir une aréna de plusieurs centaines de mètres, MAX descend au
// millimètre par pixel.
const MIN_SCENE_ZOOM = 0.5
const MAX_SCENE_ZOOM = 5000
// Sensibilité molette : facteur de zoom par unité de deltaY. Un cran de
// molette classique (~120) donne ≈ ±15 % ; un trackpad (petits deltas
// continus) produit un zoom proportionnel et doux.
const WHEEL_ZOOM_BASE = 0.9988
// Vitesse de convergence de l'animation (1/s) : ~90 % de l'écart absorbé
// en ~180 ms, indépendant du framerate.
const ZOOM_CONVERGE_RATE = 13
// Réutilisés chaque frame par le verrouillage d'ancre (zéro allocation).
const ZOOM_GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const ZOOM_HIT = new THREE.Vector3()

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
// Résolution maximale du bake terrain (px, côté long) — 4096 couvre un
// terrain de 100 m à ~4 cm/px, largement au-delà du besoin de lecture.
const TERRAIN_BAKE_MAX_PX = 4096

function Terrain({ path, rotationDeg, onBounds, onSnapPoints }: {
  path: string
  rotationDeg: number
  onBounds: (bounds: PlanarBounds) => void
  onSnapPoints: (points: SnapPoint[]) => void
}) {
  const url = useMemo(() => fileSrc(path), [path])
  const { scene } = useGLTF(url)
  const { gl } = useThree()
  // BAKE 2D (audit fluidité 2026-08-07, idée de Florian : "rendre le 3D
  // en 2D tout en gardant les mesures absolues") : un survey d'aréna =
  // des centaines de meshes/matériaux redessinés à CHAQUE frame pour un
  // décor STATIQUE — 30-45 fps au repos rien que pour lui. On le rend UNE
  // FOIS dans une texture orthographique vue du dessus, affichée comme UN
  // plan aux dimensions monde exactes (1 draw call). La vue étant
  // orthographique du dessus, le résultat est visuellement identique ;
  // bounds et points de snap restent calculés sur la vraie géométrie.
  const [baked, setBaked] = useState<{
    texture: THREE.Texture
    centerX: number; centerZ: number
    widthM: number; depthM: number
    floorY: number
  } | null>(null)
  useEffect(() => {
    scene.rotation.y = -THREE.MathUtils.degToRad(rotationDeg)
    scene.updateWorldMatrix(true, true)

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

    // ---- Bake orthographique vu du dessus ----
    const widthM = Math.max(0.001, box.max.x - box.min.x)
    const depthM = Math.max(0.001, box.max.z - box.min.z)
    const centerX = (box.min.x + box.max.x) / 2
    const centerZ = (box.min.z + box.max.z) / 2
    const long = Math.max(widthM, depthM)
    const resX = Math.max(64, Math.round((widthM / long) * TERRAIN_BAKE_MAX_PX))
    const resY = Math.max(64, Math.round((depthM / long) * TERRAIN_BAKE_MAX_PX))
    const target = new THREE.WebGLRenderTarget(resX, resY, { samples: 4 })
    const bakeScene = new THREE.Scene()
    bakeScene.add(scene)
    bakeScene.add(new THREE.AmbientLight(0xffffff, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 0.8)
    sun.position.set(centerX, box.max.y + long, centerZ)
    bakeScene.add(sun)
    const cam = new THREE.OrthographicCamera(-widthM / 2, widthM / 2, depthM / 2, -depthM / 2, 0.1, box.max.y - box.min.y + 20)
    cam.position.set(centerX, box.max.y + 10, centerZ)
    cam.up.set(0, 0, -1)
    cam.lookAt(centerX, 0, centerZ)
    cam.updateProjectionMatrix()
    const prevTarget = gl.getRenderTarget()
    gl.setRenderTarget(target)
    gl.render(bakeScene, cam)
    gl.setRenderTarget(prevTarget)
    bakeScene.remove(scene)
    setBaked((prev) => {
      prev?.texture.dispose()
      return { texture: target.texture, centerX, centerZ, widthM, depthM, floorY: box.min.y }
    })
  }, [scene, rotationDeg, onBounds, onSnapPoints, gl])

  if (!baked) return null
  return (
    <mesh
      position={[baked.centerX, baked.floorY, baked.centerZ]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <planeGeometry args={[baked.widthM, baked.depthM]} />
      <meshBasicMaterial map={baked.texture} toneMapped={false} />
    </mesh>
  )
}

function GenericFloor({ widthM, heightM }: { widthM: number; heightM: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[widthM / 2, 0, heightM / 2]}>
      <planeGeometry args={[widthM, heightM]} />
      <meshStandardMaterial color="#1b1e26" />
    </mesh>
  )
}

const Actor = memo(function Actor({ pose, color, selected, opacity, radiusM }: {
  pose: Pose
  color: string
  selected: boolean
  /** 1 in live view; dimmed in block-edit mode, where the live state is
   * context and the targets/trajectories are the subject (§12.6). */
  opacity: number
  /** Réglage projet (menu Réglages), pas une constante — cf. ACTOR_RADIUS_M. */
  radiusM: number
}) {
  const [x_cm, y_cm, z_cm, yaw_deg] = pose
  const [x, y, z] = stageToLocal(x_cm, y_cm, z_cm)
  const yawRad = THREE.MathUtils.degToRad(yaw_deg)
  const transparent = opacity < 1
  const r = radiusM
  return (
    <group
      position={[x, y, z]}
      // π/2 − yaw, pas −yaw (fix 2026-08-05, "la flèche est de côté, 90°
      // horaire") : le backend définit lacet = atan2(dy, dx) dans le
      // repère scène (x → droite, y → bas d'écran) — lacet 0° = est. Le
      // cône au repos pointe +Z local (= y scène, bas d'écran) et
      // Ry(θ) envoie +Z sur (sin θ, cos θ) : pour viser (cos yaw, sin yaw)
      // il faut θ = π/2 − yaw. L'ancien −yaw laissait la flèche 90°
      // horaire à côté de la direction réelle (visible en mode "suivre la
      // trajectoire" : l'acteur marchait le long de la ligne, flèche de
      // travers). Même formule que TargetGhost — les deux DOIVENT bouger
      // ensemble.
      rotation={[0, Math.PI / 2 - yawRad, 0]}
    >
      {/* Disque plat vu du dessus — plus une sphère 3D, qui perdait de sa
          taille apparente sous l'éclairage/l'ombrage en vue du dessus.
          Taille FIXE en espace monde (cf. commentaire ACTOR_RADIUS_M) —
          zoomer pour voir le détail, comme dans un vrai lieu. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[r, 20]} />
        <meshBasicMaterial color={color} transparent={transparent} opacity={opacity} side={THREE.DoubleSide} />
      </mesh>
      {/* Encoche directionnelle : même trick que le tick de cap de
          TargetGhost (cône à 3 segments radiaux = triangle plat), même
          convention d'axe (+Z local) pour que l'acteur et sa cible
          s'accordent sur ce que "le lacet" veut dire. */}
      <mesh position={[0, 0, r * 1.45]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[r * 0.38, r * 0.85, 3]} />
        <meshBasicMaterial color={color} transparent={transparent} opacity={opacity} />
      </mesh>
      {/* Sélection = anneau blanc fin, jamais un disque plus gros ni une
          lueur ("le point sélectionné est trop gros trop vulgaire"). */}
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[r * 1.05, r * 1.3, 32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={opacity} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  )
}, (a, b) =>
  a.pose[0] === b.pose[0] && a.pose[1] === b.pose[1] && a.pose[2] === b.pose[2] && a.pose[3] === b.pose[3]
  && a.color === b.color && a.selected === b.selected
  && a.opacity === b.opacity && a.radiusM === b.radiusM)

/** Numéro Stancz si défini, sinon initiales/abrégé du nom (jamais vide —
 * un acteur sans numéro ni nom reste identifiable). */
function actorLabelText(point: Point): string {
  if (point.number !== null && point.number !== undefined) return String(point.number)
  const trimmed = point.name.trim()
  if (!trimmed) return '?'
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
}

/** Étiquette d'un point de focus : juste sa lettre ("Focus A" -> "A"), pas
 * les initiales comme actorLabelText — un point de focus n'a pas de
 * numéro, et prendre les initiales de "Focus A" donnerait "FA", pas "A".
 * Robuste à un renommage : dernier mot du nom, pas un motif figé. */
function focusPointLabelText(point: Point): string {
  const trimmed = point.name.trim()
  if (!trimmed) return '?'
  const words = trimmed.split(/\s+/).filter(Boolean)
  return words[words.length - 1] ?? '?'
}

/** Badge numéro/abrégé au-dessus de l'acteur : plan à taille écran
 * constante (même technique que ScreenSizedHandle/TargetGhost), texte
 * rendu dans un CanvasTexture avec contour sombre pour rester lisible sur
 * n'importe quelle couleur d'acteur. Positionné à la hauteur réelle de
 * l'acteur mais hors de son groupe pivoté : le numéro ne doit jamais
 * tourner avec le lacet (yaw), contrairement au cône directionnel. */
const ActorLabel = memo(function ActorLabel({ text, xCm, yCm, zCm, opacity, scale = 1 }: {
  text: string; xCm: number; yCm: number; zCm: number; opacity: number
  /** Réduit la taille écran fixe du badge — les acteurs entassés en
   * backstage (nombreux, espacement réel serré) faisaient se chevaucher les
   * badges en un jumble illisible (signalé 2026-08-02, capture d'écran de
   * Florian) : la zone appelante réduit ce facteur pour ses points. */
  scale?: number
}) {
  const ref = useRef<THREE.Mesh>(null)
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.font = '700 38px Roboto, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 7
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(text, 32, 34)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, 32, 34)
    const tex = new THREE.CanvasTexture(canvas)
    tex.anisotropy = 4
    return tex
  }, [text])
  useFrame(({ camera }) => {
    if (!ref.current) return
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const s = (ACTOR_LABEL_PX * scale) / zoom
    ref.current.scale.set(s, s, s)
  })
  const [x, y, z] = stageToLocal(xCm, yCm, zCm)
  return (
    <mesh ref={ref} position={[x, y + 0.05, z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1037}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={texture} transparent opacity={opacity} depthTest={false} depthWrite={false} />
    </mesh>
  )
})

/** Visual weight of one block-edit element, driven by actor selection
 * (§12.6): no actor selected → every trajectory reads equally; an actor
 * selected → its trajectory/ghost pops, the rest stays visible but dim. */
type Emphasis = 'highlight' | 'normal' | 'dim'

const EMPHASIS_OPACITY: Record<Emphasis, number> = { highlight: 1, normal: 0.7, dim: 0.18 }
const EMPHASIS_LINE_WIDTH: Record<Emphasis, number> = { highlight: 4, normal: 2, dim: 1.25 }
// Chevrons de direction (B2) : espacement écran ~56 px, taille ~9 px.
const CHEVRON_SPACING_PX = 56
const CHEVRON_PX = 9
const CHEVRON_MAX = 24
// Triangle plat unitaire pointant +X dans le plan XZ (créé UNE fois).
const CHEVRON_GEOMETRY = (() => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0.65, 0, 0,
    -0.45, 0, 0.42,
    -0.45, 0, -0.42,
  ], 3))
  g.computeVertexNormals()
  return g
})()

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
  // Dégradé temporel (B2.1) : sombre au départ → couleur pleine à la
  // cible — le sens de lecture devient évident sans animation.
  const vertexColors = useMemo(() => gradientColors(path.length, color), [path, color])
  // Chevrons de direction (B2.2) : espacement écran-constant via bucket
  // de zoom quantifié — recalcul uniquement au changement de palier.
  const [bucket, setBucket] = useState(1)
  const bucketRef = useRef(1)
  useFrame(({ camera }) => {
    const b = zoomBucket((camera as THREE.OrthographicCamera).zoom || 1)
    if (b !== bucketRef.current) { bucketRef.current = b; setBucket(b) }
  })
  const chevrons = useMemo(
    () => (emphasis === 'dim'
      ? []
      : chevronPlacements(path, (CHEVRON_SPACING_PX / bucket) / CM_TO_M, CHEVRON_MAX)),
    [path, bucket, emphasis],
  )
  const chevronS = (CHEVRON_PX / bucket)
  const opacity = EMPHASIS_OPACITY[emphasis]
  return (
    <group>
      <Line
        points={points}
        color="#ffffff"
        vertexColors={vertexColors}
        lineWidth={EMPHASIS_LINE_WIDTH[emphasis]}
        transparent
        opacity={opacity}
        depthTest={false}
        renderOrder={1010}
        onDoubleClick={onDoubleClick}
      />
      {chevrons.map((c, i) => {
        const [x, y, z] = stageToLocal(c.xCm, c.yCm, c.zCm)
        return (
          <mesh
            key={i}
            geometry={CHEVRON_GEOMETRY}
            position={[x, y + 0.03, z]}
            rotation={[0, -c.angleRad, 0]}
            scale={[chevronS, chevronS, chevronS]}
            renderOrder={1011}
            raycast={() => null}
          >
            <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} side={THREE.DoubleSide} />
          </mesh>
        )
      })}
    </group>
  )
}

/** Fantôme de départ (B2.5) : petit anneau écran-constant (~7 px) à la
 * position de départ de l'activation, couleur assombrie — marque d'où
 * l'acteur PART (le dégradé dit ensuite dans quel sens lire). Pur
 * affichage, jamais cliquable. */
function StartGhost({ pose, color, opacity }: {
  pose: [number, number, number]
  color: string
  opacity: number
}) {
  const [x, y, z] = stageToLocal(pose[0], pose[1], pose[2])
  const ref = useRef<THREE.Group>(null)
  useFrame(({ camera }) => {
    if (!ref.current) return
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const s = 7 / zoom
    ref.current.scale.set(s, s, s)
  })
  return (
    <group ref={ref} position={[x, y + 0.02, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={1009} raycast={() => null}>
        <ringGeometry args={[0.62, 1, 24]} />
        <meshBasicMaterial color={darkenHex(color, 0.45)} transparent opacity={opacity} depthTest={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/** Marqueur d'édition du tracé à taille écran constante (waypoint = carré
 * pivoté, poignée = disque). Même logique de zoom que TargetGhost. */
function PathMarker({ xCm, yCm, zCm, px, color, shape, selected, halo, onPointerDown, onContextMenu }: {
  xCm: number
  yCm: number
  zCm: number
  px: number
  color: string
  shape: 'diamond' | 'dot'
  selected: boolean
  /** B2.4 : halo sombre contrasté derrière le marqueur — keyframes des
   * acteurs SÉLECTIONNÉS nettement visibles au-dessus des trajectoires. */
  halo?: boolean
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
  onContextMenu?: (e: ThreeEvent<MouseEvent>) => void
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
        onContextMenu={onContextMenu}
        onPointerOver={() => { document.body.style.cursor = 'grab' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        {halo && (
          <mesh renderOrder={1029} raycast={() => null}>
            {shape === 'diamond'
              ? <planeGeometry args={[1.45, 1.45]} />
              : <circleGeometry args={[0.75, 20]} />}
            <meshBasicMaterial color="#0c0c10" depthTest={false} transparent opacity={0.9} side={THREE.DoubleSide} />
          </mesh>
        )}
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
        <group key={`wp-${i}`}>
          {/* B2.4 : keyframes de l'acteur sélectionné nettement visibles —
              +2 px, halo sombre, numéro d'ordre à côté du losange. */}
          <PathMarker
            xCm={wp.xCm} yCm={wp.yCm} zCm={zCm}
            px={WAYPOINT_PX + 2} color={color} shape="diamond" halo
            selected={i === selectedIndex}
            onPointerDown={(e) => onWaypointDown(e, i)}
          />
          <ActorLabel text={String(i + 1)} xCm={wp.xCm} yCm={wp.yCm} zCm={zCm} opacity={0.9} scale={0.55} />
        </group>
      ))}
    </group>
  )
}

/** Where this activation sends the actor: a flat ring + heading tick at the
 * target pose, constant screen size (same `useFrame`/`camera.zoom` scaling
 * as the zone handles). Draggable: grabbing the ghost — like dragging the
 * actor itself while a block is selected — moves the block's target, so the
 * thing being edited is always the thing on screen. */
function TargetGhost({ pose, color, emphasis, radiusM, onPointerDown }: {
  pose: Pose
  color: string
  emphasis: Emphasis
  /** Harmonisation 2026-08-07 ('leur taille est dementielle') : le ghost
   * adopte la taille MONDE de l'acteur (meme regle que le disque —
   * zoomer pour le detail), plus jamais une taille ecran constante qui
   * dominait la scene dezoomee et dont la hitbox ecran volait les clics
   * entre acteurs proches. */
  radiusM: number
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
}) {
  const [x_cm, y_cm, z_cm, yaw_deg] = pose
  const [x, y, z] = stageToLocal(x_cm, y_cm, z_cm)
  const yawRad = THREE.MathUtils.degToRad(yaw_deg)
  const s = radiusM * 1.1
  const opacity = EMPHASIS_OPACITY[emphasis]
  return (
    // π/2 − yaw : même convention que Actor (voir son commentaire) —
    // lacet 0° = est, cône au repos vers +Z local.
    <group position={[x, y, z]} rotation={[0, Math.PI / 2 - yawRad, 0]}>
      <group
        scale={[s, s, s]}
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

/** Grille 2D en surimpression, remplaçant le <Grid> de drei (2026-08-06,
 * "la grille passe toujours sous le terrain") : le matériau shader interne
 * de drei ignorait nos réglages de profondeur percés (material-depthTest),
 * le plancher d'un GLB réel (au-dessus de y=0) l'enterrait donc toujours.
 * De simples lineSegments comme le reste des calques d'édition (ZoneOutline,
 * PathMarker…) : depthTest désactivé, renderOrder sous les tracés (1000),
 * et un VRAI canal alpha — l'opacité du popover redevient une opacité. */
function GridOverlay({ widthM, heightM, cellM, shade, opacity }: {
  widthM: number
  heightM: number
  cellM: number
  shade: number
  opacity: number
}) {
  const { cellsGeom, sectionsGeom } = useMemo(() => {
    const cells: number[] = []
    const sections: number[] = []
    if (cellM > 0.01) {
      const push = (arr: number[], x1: number, z1: number, x2: number, z2: number) => {
        arr.push(x1, 0, z1, x2, 0, z2)
      }
      // Grille CENTRÉE sur la scène (demande 2026-08-06) : les lignes
      // rayonnent depuis le centre (k = 0 passe pile au milieu, et c'est
      // une ligne de section) — marges symétriques quand la dimension
      // n'est pas un multiple de la maille, au lieu de tout renvoyer le
      // reste sur le bord droit/bas.
      const cx = widthM / 2
      const cz = heightM / 2
      for (let k = -Math.floor(cx / cellM); k <= Math.floor(cx / cellM); k++) {
        const x = cx + k * cellM
        push(Math.abs(k) % 10 === 0 ? sections : cells, x, 0, x, heightM)
      }
      for (let k = -Math.floor(cz / cellM); k <= Math.floor(cz / cellM); k++) {
        const z = cz + k * cellM
        push(Math.abs(k) % 10 === 0 ? sections : cells, 0, z, widthM, z)
      }
    }
    const build = (arr: number[]) => {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3))
      return geom
    }
    return { cellsGeom: build(cells), sectionsGeom: build(sections) }
  }, [widthM, heightM, cellM])
  // Un seul geometry recréé par changement de dimensions : libérer l'ancien
  // (BufferGeometry ne part pas au GC tant que le GPU le référence).
  useEffect(() => () => { cellsGeom.dispose(); sectionsGeom.dispose() }, [cellsGeom, sectionsGeom])
  if (opacity <= 0) return null
  const color = new THREE.Color(shade, shade, shade)
  return (
    <>
      <lineSegments geometry={cellsGeom} renderOrder={996}>
        <lineBasicMaterial color={color} transparent opacity={opacity * 0.45} depthTest={false} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={sectionsGeom} renderOrder={997}>
        <lineBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} />
      </lineSegments>
    </>
  )
}


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

        // Where the anchor sits relative to the *new* CENTRE (logique de
        // centre 2026-08-06 : l'origine est le centre du rectangle) —
        // rotate that back into world space and subtract from the anchor's
        // (fixed) world position to get the new origin.
        const anchorNewLocalX = newWidthM * (1 - handle.fx) - newWidthM / 2
        const anchorNewLocalZ = newHeightM * (1 - handle.fz) - newHeightM / 2
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
    // Coordonnées locales de l'ancre PAR RAPPORT AU CENTRE (logique de
    // centre 2026-08-06) — l'origine du rectangle est son centre.
    const anchorLocalX = (1 - handle.fx) * widthM - widthM / 2
    const anchorLocalZ = (1 - handle.fz) * heightM - heightM / 2
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
  // Logique de CENTRE (2026-08-06, "le 0,0 doit être le centre du terrain
  // dans tous les cas") : stageMapOrigin place le CENTRE de la zone de jeu
  // dans le monde du terrain et la rotation pivote autour de lui — même
  // convention que OutputTransform.to_metres (Python + Rust). Le ref reste
  // sur le groupe INTERNE (repère coin 0..w des enfants) pour que toutes
  // les conversions monde<->scène existantes traversent l'offset sans
  // rien savoir du changement.
  const wM = project.stageWidthCm * CM_TO_M
  const hM = project.stageHeightCm * CM_TO_M
  return (
    <group position={[project.stageMapOriginXM, 0, project.stageMapOriginZM]} rotation={[0, rotationRad, 0]}>
      <group ref={groupRef} position={[-wM / 2, 0, -hM / 2]}>
        {children}
      </group>
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

/** Étiquette de texte hors-ligne : nom rendu dans un CanvasTexture (pas de
 * police réseau type troika), plan à taille écran constante. */
function ZoneLabel({ text, xCm, yCm }: { text: string; xCm: number; yCm: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 40
    const ctx = canvas.getContext('2d')!
    ctx.font = '600 24px Roboto, system-ui, sans-serif'
    ctx.fillStyle = '#7ee0d0'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 6, 20)
    const tex = new THREE.CanvasTexture(canvas)
    tex.anisotropy = 4
    return tex
  }, [text])
  useFrame(({ camera }) => {
    if (!ref.current) return
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const h = 16 / zoom
    ref.current.scale.set(h * (256 / 40), h, 1)
  })
  const [lx, , lz] = stageToLocal(xCm, yCm, 0)
  return (
    <mesh ref={ref} position={[lx + 0.05, 0.05, lz + 0.05]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1036}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={texture} transparent depthTest={false} depthWrite={false} />
    </mesh>
  )
}

/** Zone backstage : rectangle pointillé sarcelle + nom. En mode « Éditer la
 * zone de jeu », le corps se déplace et le coin bas-droit redimensionne
 * (mêmes poignées écran que partout ailleurs). */
function BackstageZoneOverlay({ zone, editing, stageGroupRef, controlsRef, allZones }: {
  zone: BackstageZone
  editing: boolean
  stageGroupRef: React.RefObject<THREE.Group | null>
  controlsRef: React.RefObject<MapControlsImpl | null>
  allZones: BackstageZone[]
}) {
  const { camera, raycaster, gl } = useThree()
  const dragRef = useRef<{ kind: 'move' | 'resize'; startCm: { x: number; y: number }
    orig: BackstageZone; lastSent: number } | null>(null)

  useEffect(() => {
    if (!editing) return
    const dom = gl.domElement
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()
    const hitCm = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ), camera)
      if (!raycaster.ray.intersectPlane(plane, hit) || !stageGroupRef.current) return null
      const local = stageGroupRef.current.worldToLocal(hit.clone())
      return { x: local.x / CM_TO_M, y: local.z / CM_TO_M }
    }
    const send = (patch: Partial<BackstageZone>) => {
      sidecar.setBackstageZones(allZones.map((z) => (z.id === zone.id ? { ...z, ...patch } : z)))
    }
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const now = performance.now()
      if (now - drag.lastSent < DRAG_SEND_INTERVAL_MS) return
      drag.lastSent = now
      const p = hitCm(e)
      if (!p) return
      if (drag.kind === 'move') {
        send({ xCm: drag.orig.xCm + (p.x - drag.startCm.x), yCm: drag.orig.yCm + (p.y - drag.startCm.y) })
      } else {
        send({
          widthCm: Math.max(60, drag.orig.widthCm + (p.x - drag.startCm.x)),
          heightCm: Math.max(60, drag.orig.heightCm + (p.y - drag.startCm.y)),
        })
      }
    }
    const onUp = () => {
      dragRef.current = null
      if (controlsRef.current) controlsRef.current.enabled = true
    }
    dom.addEventListener('pointermove', onMove)
    dom.addEventListener('pointerup', onUp)
    dom.addEventListener('pointerleave', onUp)
    return () => {
      dom.removeEventListener('pointermove', onMove)
      dom.removeEventListener('pointerup', onUp)
      dom.removeEventListener('pointerleave', onUp)
    }
  }, [editing, gl, camera, raycaster, zone, allZones])

  const begin = (e: ThreeEvent<PointerEvent>, kind: 'move' | 'resize') => {
    if (!editing) return
    e.stopPropagation()
    const rect = gl.domElement.getBoundingClientRect()
    raycaster.setFromCamera(new THREE.Vector2(
      ((e.nativeEvent.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.nativeEvent.clientY - rect.top) / rect.height) * 2 + 1,
    ), camera)
    const hp = new THREE.Vector3()
    raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hp)
    const local = stageGroupRef.current ? stageGroupRef.current.worldToLocal(hp.clone()) : hp
    dragRef.current = {
      kind, orig: { ...zone },
      startCm: { x: local.x / CM_TO_M, y: local.z / CM_TO_M },
      lastSent: 0,
    }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  const { xCm, yCm, widthCm, heightCm } = zone
  const outline = [
    [xCm, yCm], [xCm + widthCm, yCm], [xCm + widthCm, yCm + heightCm], [xCm, yCm + heightCm], [xCm, yCm],
  ].map(([x, y]) => {
    const [lx, , lz] = stageToLocal(x, y, 0)
    return new THREE.Vector3(lx, 0.015, lz)
  })
  const [brx, , brz] = stageToLocal(xCm + widthCm, yCm + heightCm, 0)
  return (
    <group>
      <Line points={outline} color="#4ff5e0" lineWidth={1.5} dashed dashSize={0.3} gapSize={0.18}
        transparent opacity={editing ? 0.95 : 0.5} depthTest={false} renderOrder={1035} />
      <mesh
        position={[(xCm + widthCm / 2) * CM_TO_M, 0.025, (yCm + heightCm / 2) * CM_TO_M]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={1034}
        onPointerDown={(e) => begin(e, 'move')}
        onPointerOver={() => { if (editing) document.body.style.cursor = 'move' }}
        onPointerOut={() => { document.body.style.cursor = 'auto' }}
      >
        <planeGeometry args={[widthCm * CM_TO_M, heightCm * CM_TO_M]} />
        <meshBasicMaterial color="#4ff5e0" transparent opacity={editing ? 0.10 : 0.045}
          depthWrite={false} depthTest={false} />
      </mesh>
      <ZoneLabel text={zone.name} xCm={xCm} yCm={yCm} />
      {editing && (
        <ScreenSizedHandle
          position={[brx, 0.03, brz]}
          sizePx={HANDLE_PX}
          args={[1, 1, 1]}
          color="#4ff5e0"
          cursor="nwse-resize"
          renderOrder={1041}
          onPointerDown={(e) => begin(e, 'resize')}
        />
      )}
    </group>
  )
}

/** Indicateur de cible du geste (tranche D, 2026-08-07, "clarifier la
 * lisibilite entre selection libre au-dessus d'un cue ou dans le vide") :
 * petit HUD non interactif en bas a gauche du viewport qui dit en
 * permanence ce qu'un geste ferait — editer le bloc selectionne, editer
 * le bloc GOUVERNANT au playhead, ou creer un nouveau bloc. Lecture
 * seule : la meme resolution LTP que resolveGestureCue, sans jamais rien
 * creer. */
function GestureHud({ project, selectedPointIds, selectedCueId }: {
  project: Project
  selectedPointIds: string[]
  selectedCueId: string | null
}) {
  const tick = useTick()
  if (selectedPointIds.length === 0) return null
  const tNow = tick?.tMs ?? 0
  let label: string
  let editing = true
  const named = (cue: Cue | undefined | null) => cue ? (cue.name || cue.id.slice(0, 6)) : ''
  if (selectedCueId) {
    label = named(project.cues.find((c) => c.id === selectedCueId))
  } else {
    let best: { cue: Cue; effStart: number } | null = null
    for (const pid of selectedPointIds) {
      for (const cue of project.cues) {
        const act = cue.activations[pid]
        if (!act || (act.targetXCm === null && act.targetYCm === null)) continue
        const effStart = cue.startMs + act.startOffsetMs
        if (effStart <= tNow && (!best || effStart >= best.effStart)) best = { cue, effStart }
      }
      if (best) break
    }
    if (best) label = named(best.cue)
    else { editing = false; label = '' }
  }
  return (
    <div className={`gesture-hud ${editing ? 'gesture-hud-edit' : 'gesture-hud-create'}`}>
      {editing ? t('scene.gestureEdit', { name: label }) : t('scene.gestureCreate')}
    </div>
  )
}

/** Sonde de diagnostic (dev uniquement, audit fluidite 2026-08-07) :
 * affiche les FPS REELS du canvas et le nom du renderer WebGL — un
 * "SwiftShader"/"Basic Render" = rendu LOGICIEL (pas de GPU), un "Intel
 * (R) UHD" sur un laptop gamer = mauvaise carte choisie. C'est le chiffre
 * qui transforme "c'est lent" en cause identifiable. */
function RendererProbe() {
  const { gl } = useThree()
  const frames = useRef(0)
  const last = useRef(performance.now())
  const [info, setInfo] = useState('')
  useFrame(() => {
    frames.current += 1
    const now = performance.now()
    if (now - last.current >= 1000) {
      const fps = Math.round((frames.current * 1000) / (now - last.current))
      frames.current = 0
      last.current = now
      let renderer = 'webgl?'
      try {
        const ctx = gl.getContext()
        const ext = ctx.getExtension('WEBGL_debug_renderer_info')
        renderer = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'masque'
      } catch { /* ignore */ }
      setInfo(`${fps} fps — ${renderer} — dpr ${gl.getPixelRatio().toFixed(2)}`)
    }
  })
  if (!import.meta.env.DEV && localStorage.getItem('lumitrack.showFps') !== '1') return null
  return (
    <Html position={[0, 0, 0]} calculatePosition={() => [8, 8, 0]} style={{ pointerEvents: 'none' }}>
      <div style={{
        position: 'fixed', top: 2, left: 260, zIndex: 999,
        background: 'rgba(10,10,14,0.85)', color: '#4fe081',
        font: '11px ui-monospace, monospace', padding: '2px 8px', borderRadius: 4,
        whiteSpace: 'nowrap',
      }}>{info}</div>
    </Html>
  )
}

function SceneContent({
  project, positions, tMs, selectedPointId, selectedPointIds, selectedCueId, blockContext, onSelectPoint, onSelectPoints,
  onSelectCue, onLassoRect, cameraLocked, fitToken, editingZone,
  gridOpacity, gridShade, snapToGrid, zoomAction, dropHandleRef, onToggleGrid, onFitToWindow,
}: {
  project: Project
  positions: Record<string, Pose>
  tMs: number
  selectedPointId: string | null
  selectedPointIds: string[]
  selectedCueId: string | null
  blockContext: BlockContextMessage | null
  onSelectPoint: (pointId: string) => void
  onSelectPoints: (ids: string[]) => void
  onSelectCue: (cueId: string) => void
  onLassoRect: (rect: { x: number; y: number; w: number; h: number } | null) => void
  cameraLocked: boolean
  fitToken: number
  editingZone: boolean
  gridOpacity: number
  gridShade: number
  snapToGrid: boolean
  zoomAction: { token: number; factor: number }
  dropHandleRef: React.RefObject<SceneHandle | null>
  onToggleGrid: () => void
  onFitToWindow: () => void
}) {
  // Retour visuel immediat des gestes (voir dragOverride.ts) : les
  // positions AFFICHEES fusionnent l'override du geste en cours — les
  // marqueurs suivent la souris sans attendre l'aller-retour moteur.
  const dragOverrides = useDragOverrides()
  const displayPositions = useMemo(() => {
    if (!dragOverrides) return positions
    const merged: Record<string, Pose> = { ...positions }
    for (const [pid, [x, y]] of Object.entries(dragOverrides)) {
      const base = positions[pid]
      merged[pid] = [x, y, base?.[2] ?? 0, base?.[3] ?? 0]
    }
    return merged
  }, [positions, dragOverrides])

  const widthM = project.stageWidthCm * CM_TO_M
  const heightM = project.stageHeightCm * CM_TO_M

  const { camera, raycaster, gl, size } = useThree()
  const controlsRef = useRef<MapControlsImpl>(null)
  const stageGroupRef = useRef<THREE.Group>(null)
  type SceneDrag =
    | { kind: 'target'; pointId: string; planeY: number; lastSent: number;
        /** Cue dans lequel ce geste écrit — le bloc actif, le bloc
         * GOUVERNANT au playhead (geste libre, point 3), ou un bloc créé
         * au pointerdown : la closure selectedCueId ne se met à jour
         * qu'au re-render, trop tard pour les premiers pointermove. */
        cueId: string
        /** Geste libre dans un TROU (point 3, 2026-08-05) : le bloc vient
         * d'être créé avec arrivée = playhead — à chaque échantillon, sa
         * durée est recalculée depuis la distance parcourue / la vitesse
         * de référence (début = arrivée − durée), le bloc s'étire en
         * direct dans la timeline (c'est l'aperçu "fantôme" du plan). */
        freeCreate: { originX: number; originY: number; arrivalMs: number } | null
        /** Transformation groupée : membres avec leur position de base, et
         * curseur de référence (cm) fixé au premier échantillon du drag —
         * chaque membre suit alors le MÊME delta que la souris. */
        group: { pointId: string; baseX: number; baseY: number }[] | null
        baseCursor: { x: number; y: number } | null
        /** Contextualisation clic/glisser (demande 2026-08-07) : down sur
         * un membre d'une selection MULTIPLE -> on ne sait pas encore si
         * c'est un deplacement du groupe (mouvement) ou une re-selection
         * de CET acteur (clic sec). moved bascule au-dela de 4 px ecran ;
         * au pointerup sans mouvement, clickSelect remplace la selection.
         * Aucune ecriture n'est envoyee avant le seuil. */
        startClient: { x: number; y: number }
        moved: boolean
        clickSelect: string | null
        /** Écritures DIFFÉRÉES au premier mouvement réel (2026-08-07,
         * "LA TIMELINE EST BEUGUE") : le pointerdown ne doit RIEN créer —
         * un clic sec sur un acteur sans bloc actif créait un bloc vide
         * (routage 'trou') ou un waypoint fantôme (routage 'plein fade')
         * avant même le seuil de 4 px. La création/insertion n'est envoyée
         * qu'au basculement de `moved`. */
        pendingCreate: { arrivalMs: number } | null
        pendingWaypoint: { cueId: string; index: number; wps: PathPoint[] } | null }
    | { kind: 'waypoint'; pointId: string; index: number; planeY: number; lastSent: number; cueId: string }
    | { kind: 'handle'; pointId: string; anchor: 'start' | 'target' | number; side: 'in' | 'out'; planeY: number; lastSent: number; cueId: string }

  const dragRef = useRef<SceneDrag | null>(null)
  // Drag actif DANS SelectionTransform (boîte de transfo multi-sélection) :
  // ce composant gère son propre geste avec un dragRef qui lui est privé,
  // donc invisible pour le lasso ci-dessous. `e.stopPropagation()` sur un
  // onPointerDown r3f n'empêche PAS les listeners natifs posés directement
  // sur le même canvas (lassoStart/lassoMove/lassoEnd) de recevoir le même
  // événement — ce ne sont pas le même mécanisme de propagation. Sans ce
  // partage, cliquer-glisser sur la boîte armait AUSSI un lasso, et son
  // relâchement remplaçait la sélection par ce qui se trouvait (souvent
  // rien) sous le rectangle de lasso tracé par mégarde pendant le geste —
  // "la sélection disparaît au lâcher" (signalé 2026-07-31).
  const boxDragActiveRef = useRef(false)
  // Un acteur/ghost/waypoint/poignée a été touché par CE pointerdown, même
  // si aucun drag ne s'arme (pas de bloc actif -> les handlers ci-dessous
  // "return" avant de poser dragRef, cf. leur garde `if (!selectedCueId)`).
  // lassoStart s'exécute AVANT le routage r3f (voir son commentaire) : au
  // moment où il lit dragRef, un simple clic sur un acteur SANS bloc actif
  // n'a encore rien posé dedans, donc le lasso s'arme quand même. Sans ce
  // second repère, lassoEnd le traitait comme "clic sur le vide" et
  // désélectionnait l'acteur qu'on venait tout juste de sélectionner —
  // "la transformbox disparaît aussitôt" (signalé 2026-08-03).
  const hitObjectRef = useRef(false)
  // Sélection d'un waypoint du tracé (Suppr le retire, voir keydown).
  const [selectedWaypoint, setSelectedWaypoint] = useState<{ pointId: string; index: number } | null>(null)
  // Sélection d'un waypoint depuis les losanges de la timeline
  // (waypoints.tsx, 2026-08-07) : sélectionne l'acteur ET son waypoint —
  // les poignées d'édition apparaissent sur le terrain.
  useEffect(() => {
    const onSelect = (e: Event) => {
      const { pointId, index } = (e as CustomEvent<{ pointId: string; index: number }>).detail
      onSelectPoint(pointId)
      setSelectedWaypoint({ pointId, index })
    }
    window.addEventListener(SELECT_WAYPOINT_EVENT, onSelect)
    return () => window.removeEventListener(SELECT_WAYPOINT_EVENT, onSelect)
  }, [onSelectPoint])
  // Lus par le onMove global au moment de l'évènement (l'effet ne dépend
  // pas du project : il se ré-abonnerait à chaque écho sinon).
  const liveRef = useRef<{ project: Project; entries: Record<string, BlockContextEntry> | null }>({ project, entries: null })
  // Lasso : rectangle écran en cours (px, repère du canvas).
  const lassoRef = useRef<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null)
  const selectedIdsRef = useRef(selectedPointIds)
  selectedIdsRef.current = selectedPointIds
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const tMsRef = useRef(tMs)
  tMsRef.current = tMs
  // Un geste d'édition dans la scène (glisser un acteur, gizmo de la boîte
  // de transformation) SANS bloc actif crée un bloc "Entrée" au playhead et
  // le sélectionne — même comportement que le dépôt depuis le roster
  // (placeActorsAt). Avant (fix 2026-08-05, "je n'arrive pas à déplacer le
  // groupe sélectionné avec le gizmo") : le geste était silencieusement
  // ignoré — la boîte s'affichait, le gizmo se saisissait, mais rien ne
  // bougeait, sans aucun retour.
  const resolveGestureCue = (pointIds: string[]): string => {
    if (selectedCueId) return selectedCueId
    // Bloc GOUVERNANT au playhead d'abord (fix 2026-08-06, "il crée un
    // nouveau bloc au lieu d'éditer l'actuel") : même règle LTP que le
    // geste libre — le premier membre gouverné désigne le bloc.
    const t = tMsRef.current
    const proj = liveRef.current.project
    for (const id of pointIds) {
      let best: { cueId: string; effStart: number } | null = null
      for (const cue of proj.cues) {
        const act = cue.activations[id]
        if (!act || (act.targetXCm === null && act.targetYCm === null)) continue
        const effStart = cue.startMs + act.startOffsetMs
        if (effStart <= t && (!best || effStart >= best.effStart)) {
          best = { cueId: cue.id, effStart }
        }
      }
      if (best) { onSelectCue(best.cueId); return best.cueId }
    }
    const cueId = crypto.randomUUID()
    sidecar.addCue('Entrée', t, 2000, '#4FF5E0', 0, cueId)
    onSelectCue(cueId)
    return cueId
  }
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
    // Logique de centre (2026-08-06) : lx/lz sont mesurés depuis le CENTRE
    // du rectangle, comme dans StageGroup et OutputTransform.
    const toWorldX = (lx: number, lz: number) => project.stageMapOriginXM + lx * cos + lz * sin
    const toWorldZ = (lx: number, lz: number) => project.stageMapOriginZM + (-lx * sin + lz * cos)
    const hw = widthM / 2, hh = heightM / 2
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
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

  // ---- Zoom molette fluide, ancré au curseur ----
  // Le `zoomToCursor` natif de three.js calcule sa correction d'ancre UNE
  // fois par cran de molette ; avec `enableDamping`, le zoom réel s'étale
  // ensuite sur plusieurs frames et l'ancre dérive → les à-coups constatés.
  // On reprend la technique des apps cartographiques (MapLibre/Google
  // Maps) et de camera-controls : la molette ne zoome jamais directement,
  // elle pousse une CIBLE + mémorise le point-MONDE sous le curseur ; une
  // boucle par frame fait converger cam.zoom exponentiellement puis
  // re-projette le curseur et translate caméra + target pour que ce
  // point-monde reste exactement sous le pointeur À CHAQUE frame.
  // L'ancre est re-verrouillée par frame, jamais par évènement.
  const zoomAnimRef = useRef<{ target: number; ndc: THREE.Vector2; anchor: THREE.Vector3 } | null>(null)
  const cameraLockedRef = useRef(cameraLocked)
  cameraLockedRef.current = cameraLocked

  const startZoom = useCallback((factor: number, ndc: THREE.Vector2) => {
    const cam = camera as THREE.OrthographicCamera
    const anim = zoomAnimRef.current
    const base = anim ? anim.target : cam.zoom
    const target = Math.min(MAX_SCENE_ZOOM, Math.max(MIN_SCENE_ZOOM, base * factor))
    // Point-monde actuellement sous le curseur : c'est LUI qui doit rester
    // immobile pendant toute la convergence.
    raycaster.setFromCamera(ndc, cam)
    if (!raycaster.ray.intersectPlane(ZOOM_GROUND_PLANE, ZOOM_HIT)) return
    if (anim) {
      anim.target = target
      anim.ndc.copy(ndc)
      anim.anchor.copy(ZOOM_HIT)
    } else {
      zoomAnimRef.current = { target, ndc: ndc.clone(), anchor: ZOOM_HIT.clone() }
    }
  }, [camera, raycaster])

  useEffect(() => {
    const dom = gl.domElement
    // Écouteur en phase CAPTURE sur le parent du canvas : il passe avant
    // celui des MapControls (posé sur le canvas lui-même), et le
    // stopPropagation garantit qu'ils ne voient jamais la molette — leur
    // zoom (enableZoom) ne sert plus qu'au pincement tactile.
    const holder = dom.parentElement ?? dom
    const onWheel = (e: WheelEvent) => {
      if (cameraLockedRef.current) return
      e.preventDefault()
      e.stopPropagation()
      // deltaMode 1 = lignes (Firefox), 2 = pages → ramené en pixels.
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY
      const rect = dom.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      startZoom(Math.pow(WHEEL_ZOOM_BASE, dy), ndc)
    }
    holder.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => holder.removeEventListener('wheel', onWheel, true)
  }, [gl, startZoom])

  // Convergence + verrouillage d'ancre. Tourne APRÈS l'update des
  // MapControls (drei l'enregistre en priorité -1) : le pan amorti est déjà
  // appliqué quand on recale la caméra.
  useFrame((_, delta) => {
    const anim = zoomAnimRef.current
    if (!anim) return
    const cam = camera as THREE.OrthographicCamera
    const gap = Math.log(anim.target / cam.zoom)
    const done = Math.abs(gap) < 0.002
    if (done) {
      cam.zoom = anim.target
    } else {
      const k = 1 - Math.exp(-ZOOM_CONVERGE_RATE * Math.min(delta, 0.05))
      cam.zoom = cam.zoom * Math.exp(gap * k)
    }
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    // Verrouillage : après CE pas de zoom, le point-monde mémorisé doit se
    // retrouver sous le curseur — on translate d'exactement la dérive.
    raycaster.setFromCamera(anim.ndc, cam)
    if (raycaster.ray.intersectPlane(ZOOM_GROUND_PLANE, ZOOM_HIT)) {
      const dx = anim.anchor.x - ZOOM_HIT.x
      const dz = anim.anchor.z - ZOOM_HIT.z
      cam.position.x += dx
      cam.position.z += dz
      const ctl = controlsRef.current
      if (ctl) {
        ctl.target.x += dx
        ctl.target.z += dz
      }
    }
    if (done) zoomAnimRef.current = null
  })

  // Boutons +/- du viewport : même animation, ancrée au centre de la vue.
  const zoomActionTokenRef = useRef(-1)
  useEffect(() => {
    if (zoomAction.token === zoomActionTokenRef.current) return
    zoomActionTokenRef.current = zoomAction.token
    if (cameraLocked) return
    startZoom(zoomAction.factor, new THREE.Vector2(0, 0))
  }, [zoomAction, cameraLocked, startZoom])

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

    // Dernieres ecritures du geste en cours (rejouees non-preview au
    // relachement) — hors SceneDrag pour ne pas toucher l'union de types.
    const lastWriteRef = { current: null as null | {
      cueId: string
      cuePatch?: { startMs: number; durationMs: number }
      entries?: Array<Record<string, unknown> & { pointId: string }>
      pointId?: string
      patch?: Record<string, unknown>
    } }

    const endDrag = () => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      clearDragOverrides()
      // Rejeu FINAL des dernieres ecritures du geste (mode apercu,
      // 2026-08-07) : les echantillons sont partis en preview (aucune
      // rediffusion) — la version non-preview du dernier etat paie
      // auto-duration/anti-superposition/rediffusion UNE fois.
      const fin = lastWriteRef.current
      lastWriteRef.current = null
      if (fin) {
        if (fin.cuePatch) sidecar.updateCue(fin.cueId, fin.cuePatch)
        if (fin.entries) sidecar.setActivations(fin.cueId, fin.entries)
        else if (fin.pointId && fin.patch) sidecar.setActivation(fin.cueId, fin.pointId, fin.patch)
      }
      // Clic SEC (aucun mouvement) sur un membre d'une selection multiple :
      // le geste n'a rien ecrit — c'etait une re-selection, la selection
      // se reduit a cet acteur au relachement (demande 2026-08-07 :
      // "contextualiser deplacement du groupe vs nouvelle selection").
      if (drag.kind === 'target' && !drag.moved && drag.clickSelect) {
        onSelectPoint(drag.clickSelect)
      }
      // Restore to the *locked* state, not unconditionally true — otherwise
      // finishing an actor drag would silently re-enable a locked camera.
      if (controlsRef.current) controlsRef.current.enabled = !cameraLocked
    }

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      // Contextualisation clic/glisser (2026-08-07) : tant que le curseur
      // n'a pas bouge de 4 px, le geste 'target' reste MUET — un clic sec
      // sur un membre d'une selection multiple ne doit rien ecrire (il
      // re-selectionnera l'acteur au pointerup), et un micro-tremblement
      // de clic ne cree pas d'edition fantome.
      if (drag.kind === 'target') {
        if (!drag.moved) {
          if (Math.hypot(e.clientX - drag.startClient.x, e.clientY - drag.startClient.y) < 4) return
          drag.moved = true
          // Écritures différées du pointerdown (2026-08-07) : c'est un
          // VRAI geste, on peut maintenant créer/insérer.
          if (drag.pendingWaypoint) {
            const pw = drag.pendingWaypoint
            sidecar.setActivation(pw.cueId, drag.pointId, { pathPoints: pw.wps })
            setSelectedWaypoint({ pointId: drag.pointId, index: pw.index })
            dragRef.current = { kind: 'waypoint', pointId: drag.pointId, index: pw.index, planeY: drag.planeY, lastSent: 0, cueId: pw.cueId }
            return
          }
          if (drag.pendingCreate) {
            sidecar.addCue('Entrée', Math.max(0, drag.pendingCreate.arrivalMs - 200), 200, '#4FF5E0', 0, drag.cueId)
            onSelectCue(drag.cueId)
            drag.pendingCreate = null
          }
        }
      }
      // Chaque geste porte SON cue (bloc actif, bloc gouvernant du geste
      // libre, ou bloc créé au pointerdown) — ne pas dépendre du
      // selectedCueId de la closure, qui ne se met à jour qu'au re-render.
      const gestureCueId = drag.cueId
      if (!gestureCueId) return
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
        // Retour visuel immediat (non throttle) : le(s) marqueur(s)
        // suivent la souris a chaque pointermove.
        if (drag.group) {
          if (drag.baseCursor) {
            const dxV = xCm - drag.baseCursor.x
            const dyV = yCm - drag.baseCursor.y
            const ov: Record<string, [number, number]> = {}
            for (const m of drag.group) ov[m.pointId] = [m.baseX + dxV, m.baseY + dyV]
            setDragOverrides(ov)
          }
        } else {
          setDragOverrides({ [drag.pointId]: [xCm, yCm] })
        }
        // Geste libre dans un trou : le bloc s'étire pour que la durée
        // colle à distance/vitesse de référence, arrivée figée au playhead
        // du pointerdown (spec point 3). update_cue resynchronise
        // lui-même le fade des activations sur la nouvelle durée.
        if (drag.freeCreate) {
          const dist = Math.hypot(xCm - drag.freeCreate.originX, yCm - drag.freeCreate.originY)
          const vref = proj.referenceSpeedCms || 220
          const fade = Math.max(200, (dist / vref) * 1000)
          const startMs = Math.max(0, drag.freeCreate.arrivalMs - fade)
          const cuePatch = {
            startMs, durationMs: Math.max(200, drag.freeCreate.arrivalMs - startMs),
          }
          sidecar.updateCuePreview(gestureCueId, cuePatch)
          lastWriteRef.current = { ...(lastWriteRef.current ?? { cueId: gestureCueId }), cueId: gestureCueId, cuePatch }
        }
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
          // UN message groupé pour tout le groupe (optimisation
          // 2026-08-06) — N set_activation = N rediffusions du projet.
          const entries = drag.group.map((m) => ({
            pointId: m.pointId, targetXCm: m.baseX + dx, targetYCm: m.baseY + dy,
          }))
          sidecar.setActivationsPreview(gestureCueId, entries)
          lastWriteRef.current = { ...(lastWriteRef.current ?? { cueId: gestureCueId }), cueId: gestureCueId, entries }
        } else {
          const patch = { targetXCm: xCm, targetYCm: yCm }
          sidecar.setActivationPreview(gestureCueId, drag.pointId, patch)
          lastWriteRef.current = { ...(lastWriteRef.current ?? { cueId: gestureCueId }), cueId: gestureCueId, pointId: drag.pointId, patch }
        }
        return
      }

      const cue = proj.cues.find((c) => c.id === gestureCueId)
      const act = cue?.activations[drag.pointId]
      if (!act) return

      if (drag.kind === 'waypoint') {
        const wps = (act.pathPoints ?? []).map((wp) => ({ ...wp }))
        if (!wps[drag.index]) return
        wps[drag.index] = { ...wps[drag.index], xCm, yCm }
        sidecar.setActivationPreview(gestureCueId, drag.pointId, { pathPoints: wps })
        lastWriteRef.current = { cueId: gestureCueId, pointId: drag.pointId, patch: { pathPoints: wps } }
        return
      }

      // Poignée : offset relatif à son ancre. Alt = casser la symétrie
      // (waypoints seulement — départ/cible n'ont qu'un côté).
      const entry = entries?.[drag.pointId]
      if (!entry) return
      if (drag.anchor === 'start') {
        if (!entry.startPose) return
        const patch = { startHandle: { dxCm: xCm - entry.startPose[0], dyCm: yCm - entry.startPose[1] } }
        sidecar.setActivationPreview(gestureCueId, drag.pointId, patch)
        lastWriteRef.current = { cueId: gestureCueId, pointId: drag.pointId, patch }
      } else if (drag.anchor === 'target') {
        if (!entry.targetPose) return
        const patch = { targetHandle: { dxCm: xCm - entry.targetPose[0], dyCm: yCm - entry.targetPose[1] } }
        sidecar.setActivationPreview(gestureCueId, drag.pointId, patch)
        lastWriteRef.current = { cueId: gestureCueId, pointId: drag.pointId, patch }
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
        sidecar.setActivationPreview(gestureCueId, drag.pointId, { pathPoints: wps })
        lastWriteRef.current = { cueId: gestureCueId, pointId: drag.pointId, patch: { pathPoints: wps } }
      }
    }

    // ---- lasso (clic gauche sur le vide) + pan gauche+droit ----
    const lassoStart = (e: PointerEvent) => {
      // Remis à zéro à CHAQUE pointerdown, avant le routage r3f (voir plus
      // bas) : hitObjectRef ne doit jamais porter l'état d'un geste précédent.
      hitObjectRef.current = false
      // r3f a déjà traité le pointerdown : si un acteur/ghost/waypoint a
      // armé un drag, pas de lasso. Pas de lasso non plus en édition de
      // zone, ni au clic droit seul (pan MapControls), ni si la boîte de
      // transformation multi-sélection a déjà pris le geste (son propre
      // dragRef est privé à SelectionTransform, d'où ce ref partagé).
      if (e.button !== 0 || dragRef.current || editingZone || boxDragActiveRef.current) return
      // Hit-test 2D maison : un acteur sous le curseur prend le geste
      // (les acteurs ne sont plus des objets interactifs R3F).
      const hitActor = actorAtCursorRef.current(e)
      if (hitActor) {
        hitObjectRef.current = true
        actorDownRef.current(e, hitActor)
        return
      }
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
      if (boxDragActiveRef.current || dragRef.current) {
        // lassoStart s'exécute AVANT le routage pointerdown de r3f (ordre
        // d'enregistrement des listeners natifs sur le même canvas, cf.
        // son commentaire) : au moment où lassoStart lit dragRef/
        // boxDragActiveRef, le onPointerDown r3f de l'acteur/poignée/boîte
        // n'a pas encore eu la main pour les poser, donc un lasso peut
        // s'armer par erreur au tout début de N'IMPORTE QUEL drag dans la
        // scène — pas seulement la boîte de transformation (2026-08-01 :
        // "la main de Mickey + un lasso qui s'active plutôt qu'un drag").
        // Sans ce garde-fou, le relâchement traitait ce lasso fantôme
        // comme une vraie sélection au lasso — souvent vide vu le
        // rectangle resté collé au point de départ — et vidait la
        // sélection. Un vrai drag génère toujours au moins un pointermove
        // avant le relâchement, donc ce garde-fou arrive toujours à temps.
        lassoRef.current = null
        onLassoRect(null)
        return
      }
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
      if (w < 6 && h < 6) {
        // Simple clic (pas un vrai lasso) : désélectionne SEULEMENT si rien
        // n'a été touché (acteur/ghost/waypoint/poignée) — sinon un simple
        // clic de sélection sur un acteur sans bloc actif se faisait
        // immédiatement défaire ici, la lasso s'étant armée par erreur
        // avant que r3f route le pointerdown à l'acteur (voir hitObjectRef
        // et le commentaire de lassoStart) : "la transformbox disparaît
        // aussitôt" (signalé 2026-08-03). Sauf aussi en ajout (Ctrl/Cmd) où
        // l'intention est de garder la sélection en cours.
        if (!l.additive && !hitObjectRef.current) onSelectPoints([])
        return
      }
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
    // Curseur 'grab' au survol d'un acteur (hit-test 2D, throttle rAF,
    // ecriture du curseur uniquement sur CHANGEMENT pour ne pas ecraser
    // les curseurs poses par les elements R3F restants).
    let hoverRaf = 0
    let hoverOn = false
    const onHoverMove = (e: PointerEvent) => {
      if (hoverRaf || dragRef.current || boxDragActiveRef.current) return
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0
        const over = actorAtCursorRef.current(e) !== null
        if (over && !hoverOn) { hoverOn = true; document.body.style.cursor = 'grab' }
        else if (!over && hoverOn) { hoverOn = false; document.body.style.cursor = 'auto' }
      })
    }
    dom.addEventListener('pointermove', onHoverMove, { passive: true })
    dom.addEventListener('pointerdown', lassoStart)
    dom.addEventListener('pointermove', lassoMove)
    dom.addEventListener('pointerup', lassoEnd)
    dom.addEventListener('pointerleave', lassoEnd)
    dom.addEventListener('contextmenu', onContextMenu)
    return () => {
      dom.removeEventListener('pointermove', onMove)
      dom.removeEventListener('pointerup', endDrag)
      dom.removeEventListener('pointerleave', endDrag)
      dom.removeEventListener('pointermove', onHoverMove)
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
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
    hitObjectRef.current = true
    onSelectPoint(pointId)
    setSelectedWaypoint({ pointId, index })
    if (!selectedCueId) return
    dragRef.current = { kind: 'waypoint', pointId, index, planeY: zCm * CM_TO_M, lastSent: 0, cueId: selectedCueId }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  const handlePathHandleDown = (e: ThreeEvent<PointerEvent>, pointId: string,
                                anchor: 'start' | 'target' | number, side: 'in' | 'out', zCm: number) => {
    e.stopPropagation()
    hitObjectRef.current = true
    if (typeof anchor === 'number') setSelectedWaypoint({ pointId, index: anchor })
    if (!selectedCueId) return
    dragRef.current = { kind: 'handle', pointId, anchor, side, planeY: zCm * CM_TO_M, lastSent: 0, cueId: selectedCueId }
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

  // Dépôt du roster vers la scène (mission backstage) : dépôt sur le sol =
  // activer l'acteur dans le bloc sélectionné à cet endroit — ou dans un
  // bloc créé au playhead s'il n'y en a pas (arbitrage Florian). Dépôt avec
  // Alt sur une zone backstage = changer la zone d'ATTACHE de l'acteur
  // (sans créer de mouvement).
  //
  // Exposé en méthode impérative (pas des listeners dragover/drop HTML5,
  // voir dropHandleRef) : le drag-and-drop HTML5 natif s'est avéré ne
  // produire STRICTEMENT AUCUN événement dragover/dragenter/drop/dragend
  // après le dragstart pour un élément DOM classique dans cette WebView
  // (2026-07-31, diagnostiqué avec des logs + une vidéo de Florian —
  // seul le dragstart se déclenchait, jamais la suite, jusqu'au niveau
  // window en phase de capture). Le roster utilise le même mécanisme
  // (pointerdown/pointermove/pointerup) pour déclencher ce dépôt.
  useImperativeHandle(dropHandleRef, () => ({
    placeActorsAt: (pointIds: string[], clientX: number, clientY: number, altKey: boolean): boolean => {
      if (pointIds.length === 0) return false
      const dom = gl.domElement
      const rect = dom.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
      const hit = new THREE.Vector3()
      raycaster.setFromCamera(new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ), camera)
      if (!raycaster.ray.intersectPlane(plane, hit) || !stageGroupRef.current) return false
      const local = stageGroupRef.current.worldToLocal(hit.clone())
      const xCm = local.x / CM_TO_M
      const yCm = local.z / CM_TO_M
      const proj = liveRef.current.project
      const zone = (proj.backstageZones ?? []).find((z) =>
        xCm >= z.xCm && xCm <= z.xCm + z.widthCm && yCm >= z.yCm && yCm <= z.yCm + z.heightCm)
      if (zone && altKey) {
        // Alt+dépôt sur une zone : changer l'attache (position de repos).
        for (const pointId of pointIds) sidecar.updatePoint(pointId, { homeZoneId: zone.id })
        return true
      }
      // Dépôt MULTIPLE (sélection ou groupe entier glissé par son en-tête) :
      // grille compacte centrée sur le point de dépôt plutôt que tous les
      // acteurs empilés sur la même coordonnée (illisible, et il faudrait
      // les re-séparer un par un à la main). Espacement basé sur le
      // diamètre d'acteur du projet, plancher 60 cm (même constante que la
      // grille backstage).
      const spacing = Math.max((proj.actorDiameterCm ?? 60) * 1.25, 60)
      const cols = Math.ceil(Math.sqrt(pointIds.length))
      const rows = Math.ceil(pointIds.length / cols)
      const slotOf = (i: number): [number, number] => [
        xCm + ((i % cols) - (cols - 1) / 2) * spacing,
        yCm + (Math.floor(i / cols) - (rows - 1) / 2) * spacing,
      ]
      // Un POINT DE FOCUS déposé sur le terrain (2026-08-04, "il n'a pas de
      // position") ne passe pas par le bloc sélectionné : sa position vit
      // dans un cue dédié de durée nulle à t=0 (même mécanique que la
      // migration des anciens projets en mode focus) — le repère existe
      // ainsi pour TOUT le spectacle, pas seulement à partir d'un bloc. Un
      // nouveau dépôt du même point met à jour ce cue au lieu d'en empiler
      // un deuxième.
      const focusIdSet = new Set(
        proj.points.filter((p) => p.isFocusPoint && pointIds.includes(p.id)).map((p) => p.id))
      pointIds.forEach((pointId, i) => {
        if (!focusIdSet.has(pointId)) return
        const [sx, sy] = slotOf(i)
        const existing = proj.cues.find((c) => c.activations[pointId])
        if (existing) {
          sidecar.setActivation(existing.id, pointId, { targetXCm: sx, targetYCm: sy })
        } else {
          const name = proj.points.find((p) => p.id === pointId)?.name ?? 'Focus'
          const focusCueId = crypto.randomUUID()
          sidecar.addCue(`${name} (position)`, 0, 0, '#D8D8E2', 0, focusCueId)
          sidecar.setActivation(focusCueId, pointId, { targetXCm: sx, targetYCm: sy, fadeMs: 0 })
        }
      })
      const actorIds = pointIds.filter((id) => !focusIdSet.has(id))
      if (actorIds.length > 0) {
        let cueId = selectedCueId
        if (!cueId) {
          cueId = crypto.randomUUID()
          sidecar.addCue('Entrée', tMsRef.current, 2000, '#4FF5E0', 0, cueId)
        }
        // Écriture groupée : un dépôt de groupe (8+ acteurs) en un message.
        sidecar.setActivations(cueId, pointIds
          .map((pointId, i) => ({ pointId, i }))
          .filter(({ pointId }) => !focusIdSet.has(pointId))
          .map(({ pointId, i }) => {
            const [sx, sy] = slotOf(i)
            return { pointId, targetXCm: sx, targetYCm: sy }
          }))
      }
      if (pointIds.length === 1) onSelectPoint(pointIds[0])
      else onSelectPoints(pointIds)
      return true
    },
    handleTerrainContextMenu: (e: MouseEvent) => {
      // `onPointerMissed` du Canvas se déclenche pour TOUT clic qui ne
      // touche aucun objet interactif, gauche compris (la désélection sur
      // clic gauche vide reste gérée par lassoStart/lassoEnd, un mécanisme
      // séparé et déjà en place — ne rien faire ici pour ce cas).
      if (e.type !== 'contextmenu') return
      e.preventDefault()
      // Les acteurs ne sont plus interactifs R3F : le clic droit sur l'un
      // d'eux atterrit ici — router vers SON menu (hit-test 2D).
      const hitActor = actorAtCursorRef.current(e)
      if (hitActor) {
        const point = project.points.find((p) => p.id === hitActor)
        if (point) {
          onSelectPoint(hitActor)
          openContextMenu(e.clientX, e.clientY, buildActorContextMenuSections(point, project))
          return
        }
      }
      // Tranche D (2026-08-07) : "Ajouter un point (keyframe) au playhead"
      // sur les acteurs selectionnes — pour chaque acteur dont le playhead
      // tombe dans le FADE de son bloc gouvernant (LTP), insere un
      // waypoint a sa position RESOLUE actuelle, a la fraction temporelle
      // du playhead (meme mecanique que le geste libre). Groupe par bloc,
      // UN setActivations par bloc concerne.
      const selIds = selectedIdsRef.current
      if (selIds.length > 0) {
        const t = tMsRef.current
        const inserts: { cueId: string; pointId: string; pathPoints: PathPoint[] }[] = []
        for (const pid of selIds) {
          const gov = governingActivationFor(pid, t)
          const pose = positionsRef.current[pid]
          if (!gov || !pose || t >= gov.fadeEnd || gov.fadeEnd <= gov.effStart) continue
          const act = gov.cue.activations[pid]
          const wps = (act.pathPoints ?? []).map((wp: PathPoint) => ({ ...wp }))
          const segCount = wps.length + 1
          const f = (t - gov.effStart) / (gov.fadeEnd - gov.effStart)
          const segIdx = Math.min(segCount - 1, Math.max(0, Math.floor(f * segCount)))
          wps.splice(segIdx, 0, { xCm: pose[0], yCm: pose[1], inDxCm: null, inDyCm: null, outDxCm: null, outDyCm: null })
          inserts.push({ cueId: gov.cue.id, pointId: pid, pathPoints: wps })
        }
        const addKeyframe = () => {
          const byCue = new Map<string, { pointId: string; pathPoints: PathPoint[] }[]>()
          for (const ins of inserts) {
            const arr = byCue.get(ins.cueId) ?? []
            arr.push({ pointId: ins.pointId, pathPoints: ins.pathPoints })
            byCue.set(ins.cueId, arr)
          }
          for (const [cueId, entries] of byCue) {
            sidecar.setActivations(cueId, entries.map((en) => ({ pointId: en.pointId, pathPoints: en.pathPoints })))
          }
        }
        openContextMenu(e.clientX, e.clientY, [
          [{
            label: t2('contextMenu.addKeyframeAtPlayhead', { n: inserts.length, m: selIds.length }),
            onClick: addKeyframe,
            disabled: inserts.length === 0,
          }],
          [
            { label: gridOpacity > 0 ? t2('contextMenu.gridOff') : t2('contextMenu.gridOn'), onClick: onToggleGrid },
            { label: t2('contextMenu.fitToWindow'), onClick: onFitToWindow },
          ],
        ])
        return
      }
      openContextMenu(e.clientX, e.clientY, [
        [
          { label: gridOpacity > 0 ? t('contextMenu.gridOff') : t('contextMenu.gridOn'), onClick: onToggleGrid },
          { label: t('contextMenu.fitToWindow'), onClick: onFitToWindow },
        ],
      ])
    },
  }), [gl, camera, raycaster, selectedCueId, onSelectPoint, onSelectPoints, gridOpacity, onToggleGrid, onFitToWindow])

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

  /** Activation GOUVERNANT la position x/y de cet acteur à l'instant t —
   * même règle LTP que la lecture (dernier bloc démarré à-ou-avant t qui
   * touche x/y). Pure logique d'ÉDITION (savoir OÙ écrire un geste),
   * aucune position n'est résolue ici (§13.1.7 respecté). */
  const governingActivationFor = (pointId: string, t: number) => {
    const proj = liveRef.current.project
    let best: { cue: Cue; effStart: number; fadeEnd: number } | null = null
    for (const cue of proj.cues) {
      const act = cue.activations[pointId]
      if (!act || (act.targetXCm === null && act.targetYCm === null)) continue
      const effStart = cue.startMs + act.startOffsetMs
      if (effStart <= t && (!best || effStart >= best.effStart)) {
        best = { cue, effStart, fadeEnd: effStart + act.fadeMs }
      }
    }
    return best
  }

  const handleActorPointerDown = (e: ThreeEvent<PointerEvent>, pointId: string) => {
    e.stopPropagation()
    hitObjectRef.current = true
    const inSelection = selectedIdsRef.current.includes(pointId)
    // Ctrl/Cmd-clic AJOUTE/RETIRE cet acteur de la sélection au lieu de la
    // remplacer (même geste que le roster, cf. selectRange dans App.tsx) —
    // jamais câblé ici jusqu'ici : cliquer un deuxième acteur dans la scène
    // remplaçait TOUJOURS la sélection par lui seul, même Ctrl enfoncé
    // ("la sélection multiple dans un bloc ne fonctionne toujours pas",
    // signalé 2026-08-03). Un clic-modificateur ne démarre jamais de drag
    // (ambigu de savoir lequel des membres on voudrait déplacer).
    if (e.ctrlKey || e.metaKey) {
      onSelectPoints(inSelection
        ? selectedIdsRef.current.filter((id) => id !== pointId)
        : [...selectedIdsRef.current, pointId])
      return
    }
    // Glisser un acteur DÉJÀ dans la sélection multiple ne la casse pas :
    // c'est le geste "transformer la sélection". Hors sélection : simple.
    if (!inSelection) onSelectPoint(pointId)
    const pose = positionsRef.current[pointId]
    if (!pose) return
    // Actor height only depends on the group's Y-axis rotation, which never
    // touches Y — so local height == world height regardless of the
    // stage's placement (position/rotation) inside the terrain.
    const planeY = pose[2] * CM_TO_M
    const members = inSelection && selectedIdsRef.current.length > 1
      ? selectedIdsRef.current : [pointId]

    // GESTE LIBRE (point 3, 2026-08-05) : avec un bloc actif, comportement
    // historique (le geste édite CE bloc). Sans bloc actif, le geste se
    // route selon la position du playhead par rapport au bloc GOUVERNANT
    // cet acteur (LTP) :
    //   - plein fade  -> insère un waypoint dans le tracé à cet instant ;
    //   - maintien    -> déplace la cible du bloc gouvernant ;
    //   - trou        -> crée un bloc, arrivée = playhead, durée étirée en
    //                    direct à distance/vitesse de référence (onMove).
    let gestureCueId: string
    let freeCreate: { originX: number; originY: number; arrivalMs: number } | null = null
    if (selectedCueId) {
      gestureCueId = selectedCueId
    } else {
      const t = tMsRef.current
      const gov = governingActivationFor(pointId, t)
      if (gov && t < gov.fadeEnd && gov.fadeEnd > gov.effStart && members.length === 1) {
        // Plein fade : insertion d'un waypoint à la fraction TEMPORELLE du
        // playhead — DIFFÉRÉE au premier mouvement réel (un clic sec ne
        // doit pas laisser de waypoint fantôme dans le tracé). Au seuil,
        // onMove envoie le splice et convertit le geste en drag waypoint.
        const act = gov.cue.activations[pointId]
        const wps = (act.pathPoints ?? []).map((wp: PathPoint) => ({ ...wp }))
        const segCount = wps.length + 1
        const f = (t - gov.effStart) / (gov.fadeEnd - gov.effStart)
        const segIdx = Math.min(segCount - 1, Math.max(0, Math.floor(f * segCount)))
        wps.splice(segIdx, 0, { xCm: pose[0], yCm: pose[1], inDxCm: null, inDyCm: null, outDxCm: null, outDyCm: null })
        onSelectCue(gov.cue.id)
        dragRef.current = {
          kind: 'target', pointId, planeY, lastSent: 0, cueId: gov.cue.id,
          freeCreate: null, group: null, baseCursor: null,
          startClient: { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY },
          moved: false, clickSelect: null,
          pendingCreate: null,
          pendingWaypoint: { cueId: gov.cue.id, index: segIdx, wps },
        }
        if (controlsRef.current) controlsRef.current.enabled = false
        return
      }
      if (gov) {
        // Maintien : la cible du bloc gouvernant est LA chose qu'on tient.
        gestureCueId = gov.cue.id
        onSelectCue(gov.cue.id)
      } else {
        // Trou : nouveau bloc, arrivée figée au playhead — la CRÉATION est
        // différée au premier mouvement réel (un clic sec de sélection
        // créait un bloc vide "Entrée (0)" à chaque clic, signalé
        // 2026-08-07). L'id est figé ici, addCue part dans onMove.
        gestureCueId = crypto.randomUUID()
        freeCreate = { originX: pose[0], originY: pose[1], arrivalMs: tMsRef.current }
      }
    }

    dragRef.current = {
      kind: 'target', pointId, planeY, lastSent: 0, cueId: gestureCueId,
      freeCreate,
      group: members.length > 1 ? groupBases(members) : null,
      baseCursor: null,
      startClient: { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY },
      moved: false,
      clickSelect: inSelection && selectedIdsRef.current.length > 1 ? pointId : null,
      pendingCreate: freeCreate ? { arrivalMs: freeCreate.arrivalMs } : null,
      pendingWaypoint: null,
    }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  // Grabbing a target ghost drags the same thing an actor drag edits — the
  // block's target — through the same dragRef/onMove path; only the raycast
  // plane height comes from the target pose instead of the live pose.
  const handleGhostPointerDown = (e: ThreeEvent<PointerEvent>, pointId: string, targetZCm: number) => {
    e.stopPropagation()
    hitObjectRef.current = true
    const inSelection = selectedIdsRef.current.includes(pointId)
    // Même geste d'ajout/retrait que handleActorPointerDown ci-dessus.
    if (e.ctrlKey || e.metaKey) {
      onSelectPoints(inSelection
        ? selectedIdsRef.current.filter((id) => id !== pointId)
        : [...selectedIdsRef.current, pointId])
      return
    }
    onSelectPoint(pointId)
    // Un ghost n'existe qu'avec un bloc actif — pas de création ici.
    if (!selectedCueId) return
    const members = inSelection && selectedIdsRef.current.length > 1
      ? selectedIdsRef.current : [pointId]
    dragRef.current = {
      kind: 'target', pointId, planeY: targetZCm * CM_TO_M, lastSent: 0, cueId: selectedCueId,
      freeCreate: null,
      group: members.length > 1 ? groupBases(members) : null,
      baseCursor: null,
      startClient: { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY },
      moved: false,
      clickSelect: null,
      pendingCreate: null,
      pendingWaypoint: null,
    }
    if (controlsRef.current) controlsRef.current.enabled = false
  }

  // ---- Hit-test 2D maison des acteurs (audit fluidite 2026-08-07) ----
  // En vue orthographique du dessus, "quel acteur est sous le curseur" est
  // un simple test de distance en cm — pas besoin du raycast triangle par
  // triangle de R3F sur ~300 meshes a chaque pointermove (LE cout du drop
  // pendant les deplacements sur petite machine). Les fantomes/waypoints/
  // poignees (peu nombreux, montes seulement en edition) restent en R3F.
  const actorAtCursor = (e: { clientX: number; clientY: number }): string | null => {
    if (!stageGroupRef.current) return null
    const rect = gl.domElement.getBoundingClientRect()
    PICK_NDC.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    PICK_RAYCASTER.setFromCamera(PICK_NDC, camera)
    if (!PICK_RAYCASTER.ray.intersectPlane(PICK_PLANE, PICK_HIT)) return null
    const local = stageGroupRef.current.worldToLocal(PICK_HIT.clone())
    const cx = local.x / CM_TO_M
    const cy = local.z / CM_TO_M
    const zoom = (camera as THREE.OrthographicCamera).zoom || 1
    const minPickCm = (12 / zoom) / CM_TO_M   // rayon de saisie plancher ~12 px
    const pickR = Math.max(project.actorDiameterCm / 2 + 10, minPickCm)
    let best: string | null = null
    let bestD = Infinity
    for (const p of project.points) {
      if (p.isFocusPoint) continue           // les focus gardent leur marqueur R3F
      const pose = positionsRef.current[p.id]
      if (!pose) continue
      const d = Math.hypot(pose[0] - cx, pose[1] - cy)
      if (d < pickR && d < bestD) { bestD = d; best = p.id }
    }
    return best
  }
  const actorAtCursorRef = useRef(actorAtCursor)
  actorAtCursorRef.current = actorAtCursor
  const actorDownRef = useRef<(native: PointerEvent, pointId: string) => void>(() => {})
  actorDownRef.current = (native, pointId) => {
    handleActorPointerDown({
      stopPropagation: () => {},
      ctrlKey: native.ctrlKey,
      metaKey: native.metaKey,
      nativeEvent: native,
    } as unknown as ThreeEvent<PointerEvent>, pointId)
  }

  const handleFocusPointContextMenu = (e: ThreeEvent<MouseEvent>, pointId: string) => {
    e.stopPropagation()
    e.nativeEvent.preventDefault()
    const point = project.points.find((p) => p.id === pointId)
    if (!point) return
    onSelectPoint(pointId)
    openContextMenu(e.clientX, e.clientY, buildFocusPointContextMenuSections(point))
  }

  const emphasisFor = (pointId: string): Emphasis => {
    // Un acteur sélectionné qui n'est PAS activé dans le bloc ne doit pas
    // tout atténuer (verdict Mission 1, point c) : sans rien à mettre en
    // avant, l'atténuation générale ressemble à un état désactivé. On
    // traite ce cas comme "aucune sélection" : tout en normal.
    if (!selectedPointId || !editEntries?.[selectedPointId]) return 'normal'
    return pointId === selectedPointId ? 'highlight' : 'dim'
  }

  return (
    <>
      <OrthographicCamera makeDefault near={0.1} far={span * 20} />
      {/* Souris 2026 : clic gauche = lasso/sélection (plus jamais la
          caméra), clic droit OU gauche+droit = pan. La molette est gérée
          par NOTRE zoom fluide (capture ci-dessus) — les MapControls ne la
          voient jamais ; leur zoomToCursor ne sert plus qu'au pincement
          tactile (1 doigt = sélection/drag, 2 doigts = pincer + déplacer,
          type iPad). */}
      <MapControls
        ref={controlsRef}
        enabled={!cameraLocked}
        enableRotate={false}
        screenSpacePanning
        zoomToCursor
        enableDamping
        dampingFactor={0.12}
        mouseButtons={MOUSE_MAPPING}
        touches={TOUCH_MAPPING}
      />
      <ambientLight intensity={editingZone ? 0.7 : 1.1} />
      <directionalLight position={[fit.centerX, span * 3, fit.centerZ]} intensity={editingZone ? 0.4 : 0.6} />

      {/* ErrorBoundary (2026-08-04) : un GLB introuvable/illisible (chemin
          disque disparu, dev navigateur sans asset Tauri...) faisait
          exploser useGLTF et démontait TOUT le Canvas — écran noir. La
          scène continue désormais sans terrain (sol générique). */}
      <ErrorBoundary fallback={<GenericFloor widthM={widthM} heightM={heightM} />}>
        <Suspense fallback={<GenericFloor widthM={widthM} heightM={heightM} />}>
          {project.terrainGltfPath
            ? <Terrain path={project.terrainGltfPath} rotationDeg={project.terrainRotationDeg ?? 0} onBounds={onTerrainBounds} onSnapPoints={onSnapPoints} />
            : null}
        </Suspense>
      </ErrorBoundary>

      <StageGroup project={project} groupRef={stageGroupRef}>
        {!project.terrainGltfPath && <GenericFloor widthM={widthM} heightM={heightM} />}

        <GridOverlay
          widthM={widthM}
          heightM={heightM}
          cellM={project.gridSizeCm * CM_TO_M}
          shade={gridShade}
          opacity={gridOpacity}
        />

        <ZoneOutline widthM={widthM} heightM={heightM} editing={editingZone} />

        {/* Zones backstage : points d'entrée/sortie des acteurs (mission
            backstage). Éditables en mode « Éditer la zone de jeu ». */}
        {(project.backstageZones ?? []).map((zone) => (
          <BackstageZoneOverlay
            key={zone.id}
            zone={zone}
            editing={editingZone}
            stageGroupRef={stageGroupRef}
            controlsRef={controlsRef}
            allZones={project.backstageZones}
          />
        ))}

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
          const pose = displayPositions[point.id]
          if (!pose) return null
          const opacity = editEntries === null ? 1
            : editEntries[point.id] ? EDIT_ACTIVATED_OPACITY : EDIT_BYSTANDER_OPACITY
          // Un acteur "au repos" dans sa zone backstage rend son badge tout
          // petit (nombreux acteurs, espacement réel serré — voir le
          // commentaire de ActorLabel) : réduit pour limiter le
          // chevauchement, sans le supprimer (rester identifiable au survol
          // du roster reste possible même très serré).
          const inBackstage = (project.backstageZones ?? []).some((z) =>
            pose[0] >= z.xCm && pose[0] <= z.xCm + z.widthCm
            && pose[1] >= z.yCm && pose[1] <= z.yCm + z.heightCm)
          if (point.isFocusPoint) {
            return (
              <group key={point.id}>
                <PathMarker
                  xCm={pose[0]} yCm={pose[1]} zCm={pose[2]} px={FOCUS_MARKER_PX}
                  color={point.color} shape="diamond"
                  selected={selectedPointIds.includes(point.id)}
                  onPointerDown={(e) => handleActorPointerDown(e, point.id)}
                  onContextMenu={(e) => handleFocusPointContextMenu(e, point.id)}
                />
                <ActorLabel text={focusPointLabelText(point)} xCm={pose[0]} yCm={pose[1]} zCm={pose[2]} opacity={opacity} />
              </group>
            )
          }
          return (
            <group key={point.id}>
              {/* Purement affichage (hit-test 2D maison, 2026-08-07) : la
                  saisie/le clic droit passent par le pointerdown DOM +
                  actorAtCursor — 79 groupes sortis du raycast R3F qui
                  tournait a CHAQUE pointermove. */}
              <Actor
                pose={pose}
                color={point.color}
                selected={selectedPointIds.includes(point.id)}
                opacity={opacity}
                radiusM={(project.actorDiameterCm / 2) * CM_TO_M}
              />
              <ActorLabel text={actorLabelText(point)} xCm={pose[0]} yCm={pose[1]} zCm={pose[2]} opacity={opacity}
                scale={inBackstage ? 0.55 : 1} />
            </group>
          )
        })}

        {/* Block-edit overlay (§12.6): every activation of the selected
            block shows its target ghost and static trajectory. By default
            all of them; selecting an actor highlights its own and dims the
            rest (context stays visible). */}
        {/* La boîte s'affiche dès qu'un acteur est sélectionné, MÊME sans
            bloc actif (signalé 2026-08-02 : "4 acteurs sélectionnés" dans
            l'inspecteur mais aucune boîte visible après un lasso, tant
            qu'aucun bloc n'était déjà ouvert) — membersNow() retombe déjà
            sur la position vivante sans cue ; seul le geste d'écriture reste
            gardé par selectedCueId (voir handleDragStart) pour ne jamais
            écrire sur un id de bloc vide. */}
        {selectedPointIds.length >= 1 && (
          <TransformBox
            project={project}
            positions={positions}
            selectedCueId={selectedCueId ?? ''}
            selectedPointIds={selectedPointIds}
            controlsRef={controlsRef}
            snapToGrid={snapToGrid}
            gridSizeCm={project.gridSizeCm}
            dragActiveRef={boxDragActiveRef}
            resolveGestureCue={resolveGestureCue}
            blockEntries={liveRef.current.entries}
          />
        )}

        {editEntries && project.points.map((point) => {
          const entry = editEntries[point.id]
          if (!entry) return null
          const emphasis = emphasisFor(point.id)
          return (
            <group key={`edit-${point.id}`}>
              {entry.startPose && emphasis !== 'dim' && (
                <StartGhost
                  pose={[entry.startPose[0], entry.startPose[1], entry.startPose[2]]}
                  color={point.color}
                  opacity={EMPHASIS_OPACITY[emphasis]}
                />
              )}
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
              {entry.targetPose && (() => {
                // Ghost superpose a l'acteur (cible = position vivante au
                // playhead, cas de toute selection a l'arret) : ne rien
                // dessiner — l'acteur et son anneau de selection suffisent,
                // et sa hitbox normale n'est plus concurrencee (retour
                // 2026-08-07, 'on perd trop facilement la selection').
                const livePose = positions[point.id]
                if (livePose && Math.hypot(entry.targetPose[0] - livePose[0], entry.targetPose[1] - livePose[1]) < 15) {
                  return null
                }
                return (
                  <>
                    <TargetGhost
                      pose={entry.targetPose}
                      color={point.color}
                      emphasis={emphasis}
                      radiusM={(project.actorDiameterCm / 2) * CM_TO_M}
                      onPointerDown={(e) => handleGhostPointerDown(e, point.id, entry.targetPose![2])}
                    />
                    <ActorLabel
                      text={actorLabelText(point)}
                      xCm={entry.targetPose[0]} yCm={entry.targetPose[1]} zCm={entry.targetPose[2]}
                      opacity={EMPHASIS_OPACITY[emphasis]}
                    />
                  </>
                )
              })()}
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

/** Dépôt d'acteur(s) depuis le roster, appelé directement (pas de drag-and-
 * drop HTML5, voir le commentaire près de useImperativeHandle plus haut).
 * `clientX/clientY` en coordonnées écran ; retourne false si le point
 * tombe hors du canvas (l'appelant sait alors qu'il doit chercher une
 * autre cible, ex. le roster lui-même). */
export interface SceneHandle {
  placeActorsAt: (pointIds: string[], clientX: number, clientY: number, altKey: boolean) => boolean
  /** Menu contextuel "terrain/scène vide" (DIRECTIVES.md point 8) — appelé
   * via `onPointerMissed` du Canvas (aucun objet interactif sous le clic
   * droit), pas via un nouveau câblage pointerdown natif comme le lasso :
   * `onPointerMissed` est le mécanisme r3f prévu pour ce cas précis, sans
   * toucher à l'ordre fragile pointerdown/routage déjà documenté ailleurs
   * dans ce fichier (hitObjectRef). */
  handleTerrainContextMenu: (e: MouseEvent) => void
}

export const Scene = forwardRef<SceneHandle, {
  project: Project
  selectedPointId: string | null
  selectedPointIds: string[]
  selectedCueId: string | null
  blockContext: BlockContextMessage | null
  onSelectPoint: (pointId: string) => void
  onSelectPoints: (ids: string[]) => void
  onSelectCue: (cueId: string) => void
  cameraLocked: boolean
  fitToken: number
  editingZone: boolean
  gridOpacity: number
  gridShade: number
  snapToGrid: boolean
  zoomAction: { token: number; factor: number }
  onToggleGrid: () => void
  onFitToWindow: () => void
}>(function Scene(props, ref) {
  // Tick consomme ICI (refactor fluidite 2026-08-07) — App ne re-rend
  // plus a chaque tick, seule la scene (qui en a besoin) s'y abonne.
  const tick = useTick()
  const positions = tick?.positions ?? EMPTY_POSITIONS
  const tMs = tick?.tMs ?? 0
  // Rectangle du lasso : dessiné en HTML au-dessus du canvas (le canvas ne
  // peut pas rendre de DOM) — SceneContent pilote, ce wrapper affiche.
  const [lassoRect, setLassoRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const dropHandleRef = useRef<SceneHandle | null>(null)
  useImperativeHandle(ref, () => ({
    placeActorsAt: (pointIds, clientX, clientY, altKey) =>
      dropHandleRef.current?.placeActorsAt(pointIds, clientX, clientY, altKey) ?? false,
    handleTerrainContextMenu: (e) => dropHandleRef.current?.handleTerrainContextMenu(e),
  }), [])
  return (
    <div className="scene-canvas-wrap">
      <Canvas
        onPointerMissed={(e) => dropHandleRef.current?.handleTerrainContextMenu(e)}
        // Audit fluidite 2026-08-07 : DPR plafonne a 1.5 (un ecran 4K a
        // DPR 2 quadruple les pixels a dessiner pour un gain visuel nul
        // sur une vue technique) + high-performance force le vrai GPU sur
        // les laptops double-carte (WebView2 prend l'iGPU par defaut).
        // Cible : machine modeste (2026-08-07) — DPR 1.25 max et PAS de
        // MSAA plein ecran (les elements sont des aplats 2D nets ; le
        // terrain cuit a son propre anti-crenelage 4x dans sa texture).
        dpr={[1, 1.25]}
        gl={{ powerPreference: 'high-performance', antialias: false }}
      >
        <RendererProbe />
        <SceneContent {...props} positions={positions} tMs={tMs} onLassoRect={setLassoRect} dropHandleRef={dropHandleRef} />
      </Canvas>
      <GestureHud
        project={props.project}
        selectedPointIds={props.selectedPointIds}
        selectedCueId={props.selectedCueId}
      />
      {lassoRect && (
        <div
          className="scene-lasso"
          style={{ left: lassoRect.x, top: lassoRect.y, width: lassoRect.w, height: lassoRect.h }}
        />
      )}
    </div>
  )
})
