import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Scene, type SceneHandle } from './scene/Scene'
import { CueTimeline } from './timeline/CueTimeline'
import {
  sidecar, useBlockContext, useBundlePath, useConnected, useProject, usePsnRunning,
  useRedoAvailable, useTick, useUndoAvailable,
} from './sidecar'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { NumericInput } from './ui/NumericInput'
import { PsnPanel } from './ui/PsnPanel'
import { BundleHistoryPanel } from './ui/BundleHistoryPanel'
import {
  DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const LUMITRACK_FILTER = [{ name: 'Projet Lumitrack', extensions: ['lumitrack'] }]

/** Dialogue "Enregistrer sous…" : toujours affiché, crée/écrase un fichier
 * .lumitrack au chemin choisi (dossier créé si besoin côté backend). */
async function pickSaveAsPath(projectName: string): Promise<string | null> {
  const path = await saveDialog({
    title: 'Enregistrer sous…',
    defaultPath: `${projectName || 'Projet'}.lumitrack`,
    filters: LUMITRACK_FILTER,
  })
  return typeof path === 'string' ? path : null
}
import type { Activation, BackstageZone, Cue, Point, Project, RosterGroup } from './types'

// Payload porté par chaque item dnd-kit du roster (acteur ou dossier) —
// lu dans App.handleDragStart/handleDragEnd pour savoir quoi déplacer et
// où, et par les lignes elles-mêmes pour s'enregistrer sous le bon id.
type RosterDragData = { type: 'point'; pointId: string } | { type: 'group'; groupId: string }

const ROSTER_MIN = 160
const ROSTER_MAX = 420
const INSPECTOR_MIN = 220
const INSPECTOR_MAX = 480
const TIMELINE_MIN = 120
const TIMELINE_MAX = 560

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// "Zoom to fit" icon: a square with its edge midpoints cut away, leaving
// just the 4 corner brackets — the requested "petit carré coupé à ses
// médianes pour ne garder que ses 4 coins".
function FitIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path
        d="M1 4V1H4 M9 1H12V4 M12 9V12H9 M4 12H1V9"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      />
    </svg>
  )
}

/** Panel-resize dividers (window/timeline sizing was previously fixed).
 * Plain pointer-capture drag, no library: drag deltas are applied directly
 * to the caller's setter, clamped to sane min/max there isn't a natural
 * bound from otherwise. */
// Pointer capture (not just a window listener) matters here: the scene
// panel's <Canvas> sits right next to every one of these handles, and
// MapControls attaches its own pointer listeners directly on the canvas
// and calls stopPropagation() on them. Without capture, the drag's very
// first pointermove that crosses onto the canvas has its propagation
// killed before it reaches a window-level listener, so the handle looked
// draggable but silently did nothing (observed 2026-07-28). Capturing the
// pointer on the handle itself routes every subsequent event straight to
// it regardless of what's physically under the cursor.
function VerticalResizer({ area, onDeltaX }: { area: string; onDeltaX: (dx: number) => void }) {
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let lastX = e.clientX
    const onMove = (ev: PointerEvent) => {
      onDeltaX(ev.clientX - lastX)
      lastX = ev.clientX
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [onDeltaX])
  return <div className="resizer resizer-v" style={{ gridArea: area }} onPointerDown={onPointerDown} />
}

function HorizontalResizer({ area, onDeltaY }: { area: string; onDeltaY: (dy: number) => void }) {
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let lastY = e.clientY
    const onMove = (ev: PointerEvent) => {
      onDeltaY(ev.clientY - lastY)
      lastY = ev.clientY
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [onDeltaY])
  return <div className="resizer resizer-h" style={{ gridArea: area }} onPointerDown={onPointerDown} />
}

// Classic Windows-style dropdown menu bar (File/View/...), replacing the
// earlier ad hoc <details> dropdown and loose buttons per user feedback:
// "un bandeau de menu déroulant... truc classique à la Windows".
type MenuItemDef =
  | { label: string; onClick: () => void; checked?: boolean; disabled?: boolean }
  | { separator: true }

function MenuBar({ menus }: { menus: { label: string; items: MenuItemDef[] }[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  useEffect(() => {
    if (openIndex === null) return
    const close = () => setOpenIndex(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [openIndex])

  return (
    <nav className="menu-bar">
      {menus.map((menu, i) => (
        <div key={menu.label} className="menu">
          <button
            type="button"
            className={`menu-label${openIndex === i ? ' open' : ''}`}
            onClick={(e) => { e.stopPropagation(); setOpenIndex(openIndex === i ? null : i) }}
            onMouseEnter={() => { if (openIndex !== null) setOpenIndex(i) }}
          >
            {menu.label}
          </button>
          {openIndex === i && (
            <div className="menu-dropdown" onClick={(e) => e.stopPropagation()}>
              {menu.items.map((item, j) => (
                'separator' in item
                  ? <div key={j} className="menu-separator" />
                  : (
                    <button
                      key={j}
                      type="button"
                      className="menu-item"
                      disabled={item.disabled}
                      onClick={() => { item.onClick(); setOpenIndex(null) }}
                    >
                      <span className="menu-item-check">{item.checked ? '✓' : ''}</span>
                      <span>{item.label}</span>
                    </button>
                  )
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  )
}

/** Ligne d'acteur du roster — glissable ET cible de dépôt (dnd-kit fusionne
 * les deux via useSortable) pour ranger/réordonner. onSelect reste un plain
 * onClick (Ctrl/Maj/clic simple) : le PointerSensor de dnd-kit n'intercepte
 * le geste qu'au-delà d'un seuil de mouvement, un simple clic remonte donc
 * normalement (voir activationConstraint dans App). */
function RosterPointRow({ point, selected, moving, offstage, onSelect }: {
  point: Point
  selected: boolean
  moving: boolean
  offstage: boolean
  onSelect: (e: React.MouseEvent) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `point:${point.id}`,
    data: { type: 'point', pointId: point.id } satisfies RosterDragData,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : undefined,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={selected ? 'selected' : ''}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      <span
        className={`status-dot ${moving ? 'moving' : 'idle'}`}
        title={moving ? 'En mouvement' : 'Immobile'}
      />
      <span className="swatch" style={{ background: point.color }} />
      {point.number !== null && <span className="point-number">{point.number}</span>}
      <span className="point-name">{point.name}</span>
      {offstage && <span className="offstage" title="Hors scène">•</span>}
    </li>
  )
}

/** En-tête de dossier — glissable (réordonner les dossiers entre eux) ET
 * cible de dépôt (recevoir des acteurs, de n'importe quel autre conteneur :
 * useSortable enregistre le droppable indépendamment du SortableContext
 * d'où vient l'élément actif). Les contrôles internes (caret, renommage,
 * suppression) coupent la propagation du pointerdown en plus du clic, sinon
 * les utiliser pourrait être lu comme le tout début d'un glisser de dossier. */
function RosterGroupHead({ group, memberCount, collapsed, renaming, onToggleCollapse, onStartRename, onCommitRename, onCancelRename, onDelete, onSelectAll }: {
  group: RosterGroup
  memberCount: number
  collapsed: boolean
  renaming: boolean
  onToggleCollapse: () => void
  onStartRename: () => void
  onCommitRename: (name: string) => void
  onCancelRename: () => void
  onDelete: () => void
  onSelectAll: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `group:${group.id}`,
    data: { type: 'group', groupId: group.id } satisfies RosterDragData,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="roster-group-head"
      onClick={onSelectAll}
      {...attributes}
      {...listeners}
    >
      <span
        className={`roster-group-caret ${collapsed ? 'collapsed' : ''}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onToggleCollapse() }}
      >▾</span>
      {renaming ? (
        <input
          className="roster-group-rename"
          autoFocus
          defaultValue={group.name}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => onCommitRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') onCancelRename()
          }}
        />
      ) : (
        <span
          className="roster-group-name"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => { e.stopPropagation(); onStartRename() }}
          title="Double-clic pour renommer"
        >
          {group.name}
        </span>
      )}
      <span className="roster-group-count">{memberCount}</span>
      <button
        className="roster-group-delete"
        title="Supprimer ce sous-groupe (les acteurs deviennent sans groupe)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onDelete() }}
      >
        ✕
      </button>
    </div>
  )
}

/** Zone "Sans groupe" : cible de dépôt pure (jamais glissée elle-même) pour
 * sortir un acteur d'un dossier. */
function RosterUngroupedZone() {
  const { setNodeRef, isOver } = useDroppable({ id: 'ungrouped' })
  return (
    <li ref={setNodeRef} className={`roster-ungrouped-zone${isOver ? ' roster-drop-over' : ''}`}>
      Sans groupe
    </li>
  )
}

function App() {
  const project = useProject()
  const tick = useTick()
  const connected = useConnected()
  const psnRunning = usePsnRunning()
  const blockContext = useBlockContext()
  const undoAvailable = useUndoAvailable()
  const redoAvailable = useRedoAvailable()

  const [selectedCueId, setSelectedCueId] = useState<string | null>(null)
  // Sélection multiple d'acteurs (Ctrl/Shift-clic au roster). Ordonnée :
  // le DERNIER cliqué est l'acteur "principal" (inspecteur, graph editor,
  // mise en avant scène) ; les autres suivent pour les éditions groupées.
  const [selectedPointIds, setSelectedPointIds] = useState<string[]>([])
  const selectedPointId = selectedPointIds.length ? selectedPointIds[selectedPointIds.length - 1] : null
  const setSelectedPointId = useCallback((id: string | null) => {
    setSelectedPointIds(id === null ? [] : [id])
  }, [])

  const [rosterWidth, setRosterWidth] = useState(220)
  // Sous-groupes du roster repliés (purement local à cette session — pas
  // besoin de le persister dans le projet, juste un confort d'affichage).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // Dossier en cours de renommage (double-clic sur son nom), style
  // navigateur de fichiers (mission "roster explorateur", 2026-07-31).
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [inspectorWidth, setInspectorWidth] = useState(300)
  const [timelineHeight, setTimelineHeight] = useState(220)
  const [cameraLocked, setCameraLocked] = useState(false)
  const [fitToken, setFitToken] = useState(0)
  const [editingZone, setEditingZone] = useState(false)
  const [gridOpacity, setGridOpacity] = useState(0.5)
  const [snapToGrid, setSnapToGrid] = useState(false)
  const [zoomAction, setZoomAction] = useState({ token: 0, factor: 1 })
  const [showGridSettings, setShowGridSettings] = useState(false)
  const [showPsnPanel, setShowPsnPanel] = useState(false)
  const [showBundleHistory, setShowBundleHistory] = useState(false)
  const bundlePath = useBundlePath()

  // "Enregistrer" : réutilise le chemin connu sans dialogue ; sans chemin
  // connu (jamais sauvegardé/ouvert), se comporte comme "Enregistrer sous".
  const saveOrSaveAs = useCallback(async (projectName: string) => {
    if (bundlePath) { sidecar.saveBundle(bundlePath); return }
    const path = await pickSaveAsPath(projectName)
    if (path) sidecar.saveBundle(path)
  }, [bundlePath])

  const zoomIn = () => setZoomAction((a) => ({ token: a.token + 1, factor: 1.2 }))
  const zoomOut = () => setZoomAction((a) => ({ token: a.token + 1, factor: 1 / 1.2 }))

  // Fermeture au clic extérieur — sur POINTERDOWN avec test d'appartenance
  // (ref.contains), pas sur `click` global : le clic d'ouverture sur ⚙
  // continuait de remonter jusqu'à window où l'écouteur fraîchement posé
  // (React flushe les effets synchronement sur les événements discrets) le
  // refermait dans la même frame — le popover semblait « ne pas marcher ».
  const gridSettingsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showGridSettings) return
    const close = (e: PointerEvent) => {
      if (gridSettingsRef.current?.contains(e.target as Node)) return
      setShowGridSettings(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [showGridSettings])

  // Drag & drop de fichiers sur la fenêtre : routage par extension — audio
  // -> piste audio, .stancz -> import, .lumitrack/.bundle -> ouvrir.
  // (Événement natif Tauri : contrairement au drop HTML5, il porte les
  // vrais chemins disque, que le sidecar peut ouvrir.) Retiré puis remis le
  // 2026-07-31 : désactivé un temps le temps de soupçonner un conflit avec
  // le glisser-déposer interne (roster/scène), qui repose maintenant sur
  // dnd-kit (pointer-events en interne, pas l'API HTML5) — dragDropEnabled
  // peut donc rester à sa valeur par défaut (true) sans rien casser.
  useEffect(() => {
    const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']
    let unlisten: (() => void) | null = null
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return
      for (const path of event.payload.paths) {
        const ext = path.split('.').pop()?.toLowerCase() ?? ''
        if (AUDIO_EXT.includes(ext)) sidecar.setAudio({ path })
        else if (ext === 'stancz') sidecar.importStancz(path)
        // .lumitrack = fichier (format courant) ; .bundle = ancien dossier
        // (lecture seule, voir core/project.py::load_bundle) — les deux
        // passent par la même commande, le backend distingue fichier/dossier.
        else if (ext === 'lumitrack' || ext === 'bundle') sidecar.loadBundle(path)
      }
    }).then((fn) => { unlisten = fn }).catch(() => { /* hors Tauri (dev navigateur) */ })
    return () => { if (unlisten) unlisten() }
  }, [])

  // Explorateur du roster (mission "roster explorateur", 2026-07-31) — après
  // trois tentatives ratées de réimplémenter le glisser-déposer à la main
  // (HTML5 natif, puis pointer-events maison : dragstart se déclenchait
  // mais plus rien ne suivait dans cette WebView, et une course avec le
  // lasso de la scène s'ajoutait par-dessus), Florian a demandé de passer
  // à une librairie éprouvée plutôt que de continuer à fabriquer —
  // dnd-kit, qui gère lui-même les subtilités de capture de pointeur, de
  // seuil de mouvement (clic vs glisser) et l'animation "les autres
  // éléments se décalent" que du code maison n'aurait pas donnée aussi
  // proprement. `rosterProjectRef` évite de recréer les callbacks à
  // chaque écho de projet.
  const rosterProjectRef = useRef(project)
  rosterProjectRef.current = project
  const sceneRef = useRef<SceneHandle>(null)
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  // Alt au moment du relâchement (dnd-kit n'expose pas l'event natif du
  // drop, seulement celui qui a déclenché le geste) — attache de zone
  // backstage vs déplacement normal, voir handleDragEnd/branche 'scene'.
  const altHeldRef = useRef(false)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Alt') altHeldRef.current = true }
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Alt') altHeldRef.current = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const activeDragIdsRef = useRef<string[]>([])
  const [activeDragLabel, setActiveDragLabel] = useState<string | null>(null)

  // Déplace des acteurs vers `targetGroupId` (null = sans groupe), insérés
  // juste avant `beforeId` dans l'ordre global (null = à la fin) — un seul
  // geste fait à la fois le classement ET le rangement, comme glisser un
  // fichier dans un dossier à un endroit précis.
  const moveDroppedIds = useCallback((draggedIds: string[], targetGroupId: string | null, beforeId: string | null) => {
    const proj = rosterProjectRef.current
    if (!proj) return
    const rest = proj.points.map((p) => p.id).filter((id) => !draggedIds.includes(id))
    let at = beforeId ? rest.indexOf(beforeId) : -1
    if (at < 0) at = rest.length
    sidecar.reorderPoints([...rest.slice(0, at), ...draggedIds, ...rest.slice(at)])
    for (const id of draggedIds) {
      const p = proj.points.find((pp) => pp.id === id)
      if (p && p.rosterGroupId !== targetGroupId) sidecar.updatePoint(id, { rosterGroupId: targetGroupId })
    }
  }, [])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as RosterDragData | undefined
    const proj = rosterProjectRef.current
    if (!data || !proj) return
    if (data.type === 'point') {
      // Glisser un acteur qui fait déjà partie de la sélection courante
      // embarque toute la sélection (comme dans un explorateur de fichiers).
      const alreadySelected = selectedPointIds.includes(data.pointId)
      const ids = alreadySelected && selectedPointIds.length > 1 ? selectedPointIds : [data.pointId]
      activeDragIdsRef.current = ids
      const point = proj.points.find((p) => p.id === data.pointId)
      setActiveDragLabel(ids.length > 1 ? `${ids.length} acteurs` : (point?.name ?? ''))
    } else {
      const members = proj.points.filter((p) => p.rosterGroupId === data.groupId)
      activeDragIdsRef.current = members.map((m) => m.id)
      const group = proj.rosterGroups.find((g) => g.id === data.groupId)
      setActiveDragLabel(group?.name ?? '')
    }
  }, [selectedPointIds])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const ids = activeDragIdsRef.current
    activeDragIdsRef.current = []
    setActiveDragLabel(null)
    const activeData = event.active.data.current as RosterDragData | undefined
    const overId = event.over ? String(event.over.id) : null
    if (!overId || !activeData) return

    if (overId === 'scene') {
      if (ids.length === 0) return
      const activator = event.activatorEvent as (PointerEvent | MouseEvent) | undefined
      const clientX = (activator?.clientX ?? 0) + event.delta.x
      const clientY = (activator?.clientY ?? 0) + event.delta.y
      sceneRef.current?.placeActorsAt(ids, clientX, clientY, altHeldRef.current)
      return
    }
    if (overId === 'ungrouped') {
      moveDroppedIds(ids, null, null)
      return
    }
    if (overId.startsWith('group:')) {
      const targetGroupId = overId.slice('group:'.length)
      if (activeData.type === 'group') {
        if (activeData.groupId !== targetGroupId) {
          // Réordonner les dossiers : place le dossier glissé juste avant celui-ci.
          const proj = rosterProjectRef.current
          if (!proj) return
          const order = proj.rosterGroups.map((g) => g.id).filter((id) => id !== activeData.groupId)
          const at = order.indexOf(targetGroupId)
          order.splice(at, 0, activeData.groupId)
          sidecar.setRosterGroups(order.map((id) => proj.rosterGroups.find((g) => g.id === id)!))
        }
        return
      }
      moveDroppedIds(ids, targetGroupId, null)
      return
    }
    if (overId.startsWith('point:')) {
      const targetPointId = overId.slice('point:'.length)
      const proj = rosterProjectRef.current
      const targetPoint = proj?.points.find((p) => p.id === targetPointId)
      if (activeData.type === 'point') {
        if (!ids.includes(targetPointId)) moveDroppedIds(ids, targetPoint?.rosterGroupId ?? null, targetPointId)
      } else {
        // Un dossier déposé sur une ligne précise : rejoint le groupe de
        // cette ligne (comme sur son en-tête), sans viser une position
        // exacte — les dossiers eux-mêmes n'ont pas d'ordre au sein d'un
        // acteur.
        moveDroppedIds(ids, targetPoint?.rosterGroupId ?? null, null)
      }
    }
  }, [moveDroppedIds])

  // La scène 3D est une simple zone de dépôt dnd-kit — le point d'impact
  // exact (raycasting) est recalculé dans handleDragEnd via placeActorsAt,
  // ce hook ne sert qu'à faire reconnaître le canvas comme cible valide.
  const { setNodeRef: setSceneDropRef } = useDroppable({ id: 'scene' })

  const tMs = tick?.tMs ?? 0
  const playing = tick?.playing ?? false
  const durationMs = tick?.durationMs ?? 1000
  const positions = tick?.positions ?? {}

  const movingPointIds = useMemo(() => {
    const moving = new Set<string>()
    if (!project) return moving
    for (const cue of project.cues) {
      for (const [pointId, act] of Object.entries(cue.activations)) {
        if (tMs >= cue.startMs && tMs < cue.startMs + act.fadeMs) moving.add(pointId)
      }
    }
    return moving
  }, [project, tMs])

  const selectedCue = project?.cues.find((c) => c.id === selectedCueId) ?? null

  // Selecting a block puts the scene in that block's edit mode (§12.6):
  // fetch its context (targets + trajectories) and keep it fresh across
  // every project snapshot, since any edit can move a target or change
  // which cue a start position tracks from. Depends on `project` (the
  // snapshot object), not on individual fields, so a set_activation echo
  // triggers a re-request too.
  useEffect(() => {
    if (selectedCue) sidecar.resolveBlockContext(selectedCue.id)
    else sidecar.clearBlockContext()
  }, [selectedCue, project])

  // Global shortcuts. Skipped while typing in an input/select/color-picker
  // so Space/Delete keep their normal text-editing meaning there.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      if (e.code === 'Space') {
        e.preventDefault()
        if (playing) sidecar.pause()
        else sidecar.play()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        // Ctrl+Z / Ctrl+Maj+Z (§13.1.10) : historique côté sidecar, ce
        // raccourci n'envoie qu'une intention — un undo/redo sans rien à
        // faire est un no-op silencieux côté serveur (test_undo.py).
        e.preventDefault()
        if (e.shiftKey) sidecar.redo()
        else sidecar.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveOrSaveAs(project?.name ?? 'Projet')
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedCueId) {
          e.preventDefault()
          sidecar.deleteCue(selectedCueId)
          setSelectedCueId(null)
        } else if (selectedPointIds.length > 0) {
          // Suppression d'acteur(s) sélectionnés dans le roster — geste
          // "Suppr" façon navigateur de fichiers (mission "roster
          // explorateur", remplace l'ancien popup de gestion en lot).
          e.preventDefault()
          const count = selectedPointIds.length
          if (window.confirm(`Supprimer ${count} acteur${count > 1 ? 's' : ''} ? Leurs activations dans tous les blocs partent aussi.`)) {
            for (const id of selectedPointIds) sidecar.deletePoint(id)
            setSelectedPointIds([])
          }
        }
      } else if (e.key === 'Escape') {
        setSelectedCueId(null)
        setSelectedPointIds([])
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [playing, selectedCueId, selectedPointIds, project, saveOrSaveAs])

  if (!project) {
    return (
      <div className="app-loading">
        {connected ? 'Connexion au sidecar…' : 'En attente du sidecar Python (ws://127.0.0.1:17845)…'}
      </div>
    )
  }

  const menus = [
    {
      label: 'Fichier',
      items: [
        { label: 'Nouveau', onClick: () => {
          const name = window.prompt('Nom du nouveau projet ?', 'Untitled')
          if (name) sidecar.newProject(name)
        } },
        { label: 'Importer .stancz…', onClick: async () => {
          const path = await openDialog({
            title: 'Importer un projet Stancz',
            filters: [{ name: 'Projet Stancz', extensions: ['stancz'] }],
          })
          if (typeof path === 'string') sidecar.importStancz(path)
        } },
        { separator: true } as const,
        { label: 'Importer un audio…', onClick: async () => {
          const path = await openDialog({
            title: 'Importer un fichier audio',
            filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'] }],
          })
          if (typeof path === 'string') sidecar.setAudio({ path })
        } },
        { label: 'Retirer l’audio', disabled: !project.audioPath, onClick: () => {
          sidecar.setAudio({ path: null })
        } },
        { separator: true } as const,
        { label: 'Enregistrer (Ctrl+S)', onClick: () => saveOrSaveAs(project.name) },
        { label: 'Enregistrer sous…', onClick: async () => {
          const path = await pickSaveAsPath(project.name)
          if (path) sidecar.saveBundle(path)
        } },
        { label: 'Ouvrir…', onClick: async () => {
          const path = await openDialog({
            title: 'Ouvrir un projet',
            filters: LUMITRACK_FILTER,
          })
          if (typeof path === 'string') sidecar.loadBundle(path)
        } },
        { label: 'Historique des versions…', disabled: !bundlePath, onClick: () => setShowBundleHistory(true) },
      ],
    },
    {
      label: 'Édition',
      items: [
        { label: 'Annuler (Ctrl+Z)', disabled: !undoAvailable, onClick: () => sidecar.undo() },
        { label: 'Rétablir (Ctrl+Maj+Z)', disabled: !redoAvailable, onClick: () => sidecar.redo() },
      ],
    },
    {
      label: 'Affichage',
      items: [
        { label: 'Ajuster la vue 3D à la fenêtre', onClick: () => setFitToken((t) => t + 1) },
        { separator: true } as const,
        { label: 'Verrouiller la caméra 3D', checked: cameraLocked, onClick: () => setCameraLocked((v) => !v) },
        { label: 'Éditer la zone de jeu', checked: editingZone, onClick: () => setEditingZone((v) => !v) },
      ],
    },
    {
      label: 'Sortie',
      items: [
        {
          label: psnRunning ? 'Arrêter PSN' : 'Démarrer PSN',
          checked: psnRunning,
          onClick: () => (psnRunning ? sidecar.psnStop() : sidecar.psnStart()),
        },
        { separator: true } as const,
        { label: 'Réglages PSN…', onClick: () => setShowPsnPanel(true) },
      ],
    },
  ]

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${rosterWidth}px 6px 1fr 6px ${inspectorWidth}px`,
        gridTemplateRows: `26px 1fr 6px ${timelineHeight}px`,
      }}
    >
      <DndContext sensors={dndSensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <MenuBar menus={menus} />

      <aside className="roster">
        <div className="roster-head">
          <h2>Roster</h2>
          <span className="roster-spacer" />
          <button
            title="Nouveau sous-dossier"
            onClick={() => {
              const id = crypto.randomUUID()
              sidecar.setRosterGroups([...project.rosterGroups, { id, name: 'Nouveau groupe' }])
              setRenamingGroupId(id)
            }}
          >
            + Dossier
          </button>
          <button
            title="Ajouter un acteur (sans groupe)"
            onClick={() => {
              const base = project.points.length
              sidecar.addPoint(`Acteur ${base + 1}`, base + 1, null)
            }}
          >
            + Acteur
          </button>
        </div>
        <ul>
          {(() => {
            // Explorateur de fichiers (mission "roster explorateur",
            // 2026-07-31) : dossiers = sous-groupes organisationnels,
            // dnd-kit gère le glisser-déposer pour ranger ET réordonner
            // (voir DndContext/handleDragStart/handleDragEnd plus haut). Un
            // acteur porte au plus un dossier (`rosterGroupId`), l'ordre à
            // l'intérieur d'un dossier suit l'ordre relatif dans
            // `project.points` (reorderPoints).
            const byId = new Map(project.points.map((p, i) => [p.id, i] as const))
            const selectRange = (point: Point) => (e: React.MouseEvent) => {
              const index = byId.get(point.id) ?? -1
              if (e.ctrlKey || e.metaKey) {
                setSelectedPointIds((prev) => prev.includes(point.id)
                  ? prev.filter((id) => id !== point.id)
                  : [...prev, point.id])
              } else if (e.shiftKey && selectedPointId) {
                const anchorIdx = byId.get(selectedPointId) ?? -1
                if (anchorIdx >= 0 && index >= 0) {
                  const [lo, hi] = anchorIdx < index ? [anchorIdx, index] : [index, anchorIdx]
                  const range = project.points.slice(lo, hi + 1).map((p) => p.id)
                  // Le point cliqué devient le principal (dernier).
                  setSelectedPointIds([...range.filter((id) => id !== point.id), point.id])
                }
              } else {
                setSelectedPointIds(selectedPointIds.length === 1 && selectedPointId === point.id
                  ? [] : [point.id])
              }
            }

            // Groupes (dans leur ordre défini) d'abord, acteurs sans groupe
            // ensuite — purement pour ordonner la vue.
            const grouped = project.rosterGroups.map((g) => ({
              group: g,
              members: project.points.filter((p) => p.rosterGroupId === g.id),
            }))
            const ungrouped = project.points.filter((p) =>
              !project.rosterGroups.some((g) => g.id === p.rosterGroupId))

            return (
              <SortableContext
                items={project.rosterGroups.map((g) => `group:${g.id}`)}
                strategy={verticalListSortingStrategy}
              >
                {grouped.map(({ group, members }) => {
                  const collapsed = collapsedGroups.has(group.id)
                  return (
                    <li key={group.id} className="roster-group">
                      <RosterGroupHead
                        group={group}
                        memberCount={members.length}
                        collapsed={collapsed}
                        renaming={renamingGroupId === group.id}
                        onToggleCollapse={() => setCollapsedGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(group.id)) next.delete(group.id)
                          else next.add(group.id)
                          return next
                        })}
                        onStartRename={() => setRenamingGroupId(group.id)}
                        onCommitRename={(name) => {
                          const trimmed = name.trim()
                          if (trimmed) {
                            sidecar.setRosterGroups(project.rosterGroups.map((g) =>
                              g.id === group.id ? { ...g, name: trimmed } : g))
                          }
                          setRenamingGroupId(null)
                        }}
                        onCancelRename={() => setRenamingGroupId(null)}
                        onDelete={() => {
                          if (window.confirm('Supprimer ce sous-groupe ? Les acteurs qu’il contient redeviennent « sans groupe ».')) {
                            sidecar.setRosterGroups(project.rosterGroups.filter((g) => g.id !== group.id))
                          }
                        }}
                        onSelectAll={() => setSelectedPointIds(members.map((m) => m.id))}
                      />
                      {!collapsed && (
                        <SortableContext
                          items={members.map((m) => `point:${m.id}`)}
                          strategy={verticalListSortingStrategy}
                        >
                          <ul className="roster-group-members">
                            {members.map((p) => (
                              <RosterPointRow
                                key={p.id}
                                point={p}
                                selected={selectedPointIds.includes(p.id)}
                                moving={movingPointIds.has(p.id)}
                                offstage={!positions[p.id]}
                                onSelect={selectRange(p)}
                              />
                            ))}
                          </ul>
                        </SortableContext>
                      )}
                    </li>
                  )
                })}
                {project.rosterGroups.length > 0 && <RosterUngroupedZone />}
                <SortableContext
                  items={ungrouped.map((p) => `point:${p.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {ungrouped.map((p) => (
                    <RosterPointRow
                      key={p.id}
                      point={p}
                      selected={selectedPointIds.includes(p.id)}
                      moving={movingPointIds.has(p.id)}
                      offstage={!positions[p.id]}
                      onSelect={selectRange(p)}
                    />
                  ))}
                </SortableContext>
              </SortableContext>
            )
          })()}
        </ul>
      </aside>

      <VerticalResizer area="vhandle1" onDeltaX={(dx) => setRosterWidth((w) => clamp(w + dx, ROSTER_MIN, ROSTER_MAX))} />

      <main className="scene-view" ref={setSceneDropRef}>
        <Scene
          ref={sceneRef}
          project={project}
          positions={positions}
          tMs={tMs}
          selectedPointId={selectedPointId}
          selectedPointIds={selectedPointIds}
          onSelectPoints={setSelectedPointIds}
          selectedCueId={selectedCueId}
          blockContext={blockContext}
          onSelectPoint={setSelectedPointId}
          cameraLocked={cameraLocked}
          fitToken={fitToken}
          editingZone={editingZone}
          gridOpacity={gridOpacity}
          snapToGrid={snapToGrid}
          zoomAction={zoomAction}
        />

        <div className="viewport-toolbar">
          <button title="Zoom avant" onClick={zoomIn}>+</button>
          <button title="Zoom arrière" onClick={zoomOut}>−</button>
          <button title="Ajuster à la fenêtre" onClick={() => setFitToken((t) => t + 1)}>
            <FitIcon />
          </button>
          <button
            title="Aligner sur la grille"
            className={snapToGrid ? 'active' : ''}
            onClick={() => setSnapToGrid((v) => !v)}
          >
            #
          </button>
          <div className="viewport-toolbar-settings" ref={gridSettingsRef}>
            <button title="Réglages de la grille" onClick={() => setShowGridSettings((v) => !v)}>⚙</button>
            {showGridSettings && (
              <div className="viewport-popover" onClick={(e) => e.stopPropagation()}>
                <label>
                  Opacité de la grille
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={gridOpacity}
                    onChange={(e) => setGridOpacity(Number(e.target.value))}
                  />
                </label>
                <label>
                  Rotation du modèle 3D (°)
                  <NumericInput
                    value={project.terrainRotationDeg ?? 0} step={15}
                    onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ terrainRotationDeg: v }) }}
                  />
                </label>
                <label>
                  Taille de la grille (m)
                  <NumericInput
                    value={project.gridSizeCm / 100} step={0.1}
                    onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ gridSizeCm: v * 100 }) }}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </main>

      <VerticalResizer area="vhandle2" onDeltaX={(dx) => setInspectorWidth((w) => clamp(w - dx, INSPECTOR_MIN, INSPECTOR_MAX))} />

      <aside className="inspector">
        <h2>Inspecteur</h2>
        {editingZone && <StagePlacementPanel project={project} />}
        {editingZone && <BackstagePanel project={project} />}
        {!editingZone && (
          <ActorInspector project={project} selectedPointIds={selectedPointIds} />
        )}
        {selectedCue && selectedPointIds.length > 1 && (
          <GroupTimingPanel
            cue={selectedCue}
            selectedPointIds={selectedPointIds}
            projectPoints={project.points}
          />
        )}
        {selectedCue ? (
          <CueInspector
            cue={selectedCue}
            projectPoints={project.points}
            selectedPointId={selectedPointId}
            onSelectPoint={setSelectedPointId}
          />
        ) : (
          !editingZone && selectedPointIds.length === 0 && (
            <p className="hint">Sélectionne un acteur ou un bloc.</p>
          )
        )}
      </aside>

      <HorizontalResizer area="hhandle" onDeltaY={(dy) => setTimelineHeight((h) => clamp(h - dy, TIMELINE_MIN, TIMELINE_MAX))} />

      {showPsnPanel && <PsnPanel project={project} onClose={() => setShowPsnPanel(false)} />}
      {showBundleHistory && bundlePath && (
        <BundleHistoryPanel path={bundlePath} onClose={() => setShowBundleHistory(false)} />
      )}
      <footer className="timeline-dock">
        <CueTimeline
          project={project}
          tMs={tMs}
          playing={playing}
          durationMs={durationMs}
          connected={connected}
          selectedCueId={selectedCueId}
          selectedPointId={selectedPointId}
          onSelectCue={setSelectedCueId}
        />
      </footer>

      <DragOverlay>
        {activeDragLabel && <div className="roster-drag-ghost">{activeDragLabel}</div>}
      </DragOverlay>
      </DndContext>
    </div>
  )
}

// Numeric mirror of the drag handles in Scene.tsx (move/resize/rotate) —
// same underlying sidecar.updateStageMap() calls, for precise values or a
// mouse-free adjustment. Only shown while "Éditer la zone de jeu" is on.
/** Inspecteur de la sélection d'acteurs (mission « inspecteur dynamique ») :
 * un acteur -> toutes ses propriétés éditables ; plusieurs -> aperçu et
 * rappel des outils de groupe. Toujours affiché dès qu'une sélection
 * existe, bloc ou pas. */
function ActorInspector({ project, selectedPointIds }: {
  project: Project
  selectedPointIds: string[]
}) {
  const zones = project.backstageZones ?? []
  if (selectedPointIds.length === 0) return null
  if (selectedPointIds.length > 1) {
    const names = selectedPointIds
      .map((id) => project.points.find((p) => p.id === id)?.name ?? id)
    return (
      <div className="actor-inspector">
        <h3>{selectedPointIds.length} acteurs sélectionnés</h3>
        <p className="group-timing-names" title={names.join(', ')}>{names.join(', ')}</p>
        <p className="hint">Boîte de transformation dans la scène · timing groupé ci-dessous avec un bloc actif.</p>
      </div>
    )
  }
  const point = project.points.find((p) => p.id === selectedPointIds[0])
  if (!point) return null
  return (
    <div className="actor-inspector">
      <h3>
        <span className="swatch" style={{ background: point.color }} />
        Acteur
      </h3>
      <div className="actor-grid">
        <label>Nom
          <input
            key={point.id + point.name}
            defaultValue={point.name}
            onBlur={(e) => { if (e.target.value !== point.name) sidecar.updatePoint(point.id, { name: e.target.value }) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        </label>
        <label>Couleur
          <input
            type="color"
            value={point.color}
            onChange={(e) => sidecar.updatePoint(point.id, { color: e.target.value })}
          />
        </label>
        <label>Numéro
          <NumericInput value={point.number} step={1} nullable
            onCommit={(v) => sidecar.updatePoint(point.id, { number: v })} />
        </label>
        <label>ID PSN
          <NumericInput value={point.psnTrackerId} step={1} nullable
            onCommit={(v) => sidecar.updatePoint(point.id, { psnTrackerId: v })} />
        </label>
        <label>Hauteur (m)
          <NumericInput value={point.defaultHeightCm / 100} step={0.1}
            onCommit={(v) => { if (v !== null && v >= 0) sidecar.updatePoint(point.id, { defaultHeightCm: v * 100 }) }} />
        </label>
        <label>Coulisse d’attache
          <select
            value={point.homeZoneId ?? zones[0]?.id ?? ''}
            onChange={(e) => sidecar.updatePoint(point.id, { homeZoneId: e.target.value })}
          >
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}

function BackstagePanel({ project }: { project: Project }) {
  const zones = project.backstageZones ?? []
  const update = (id: string, patch: Partial<BackstageZone>) => {
    sidecar.setBackstageZones(zones.map((z) => (z.id === id ? { ...z, ...patch } : z)))
  }
  return (
    <div className="stage-placement">
      <h3>Zones backstage</h3>
      {zones.map((zone) => (
        <div key={zone.id} className="backstage-block">
          <div className="backstage-row">
            <input
              value={zone.name}
              onChange={(e) => update(zone.id, { name: e.target.value })}
              title="Nom de la zone"
            />
            <button
              title="Supprimer la zone"
              disabled={zones.length <= 1}
              onClick={() => sidecar.setBackstageZones(zones.filter((z) => z.id !== zone.id))}
            >
              ✕
            </button>
          </div>
          <div className="backstage-grid">
            <label>X (m)
              <NumericInput value={zone.xCm / 100} step={0.5}
                onCommit={(v) => { if (v !== null) update(zone.id, { xCm: v * 100 }) }} />
            </label>
            <label>Y (m)
              <NumericInput value={zone.yCm / 100} step={0.5}
                onCommit={(v) => { if (v !== null) update(zone.id, { yCm: v * 100 }) }} />
            </label>
            <label>L (m)
              <NumericInput value={zone.widthCm / 100} step={0.5}
                onCommit={(v) => { if (v !== null && v >= 0.6) update(zone.id, { widthCm: v * 100 }) }} />
            </label>
            <label>P (m)
              <NumericInput value={zone.heightCm / 100} step={0.5}
                onCommit={(v) => { if (v !== null && v >= 0.6) update(zone.id, { heightCm: v * 100 }) }} />
            </label>
          </div>
        </div>
      ))}
      <button
        className="backstage-add"
        onClick={() => sidecar.setBackstageZones([...zones, {
          id: `backstage-${Date.now()}`,
          name: `Backstage ${zones.length + 1}`,
          xCm: project.stageWidthCm + 100,
          yCm: 0,
          widthCm: 400,
          heightCm: Math.min(1200, project.stageHeightCm),
        }])}
      >
        + Zone backstage
      </button>
      <p className="hint">Glisse un acteur du roster sur une zone avec Alt pour l’y attacher. Les zones se déplacent/redimensionnent dans la scène.</p>
    </div>
  )
}

function StagePlacementPanel({ project }: { project: Project }) {
  return (
    <div className="stage-placement">
      <h3>Zone de jeu</h3>
      <div className="stage-placement-grid">
        <label>Origine X (m)
          <NumericInput value={project.stageMapOriginXM} step={0.1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ originXM: v }) }} />
        </label>
        <label>Origine Z (m)
          <NumericInput value={project.stageMapOriginZM} step={0.1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ originZM: v }) }} />
        </label>
        <label>Rotation (°)
          <NumericInput value={project.stageMapRotationDeg} step={1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ rotationDeg: v }) }} />
        </label>
        <label>Largeur (m)
          <NumericInput value={project.stageWidthCm / 100} step={0.5}
            onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ widthCm: v * 100 }) }} />
        </label>
        <label>Profondeur (m)
          <NumericInput value={project.stageHeightCm / 100} step={0.5}
            onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ heightCm: v * 100 }) }} />
        </label>
      </div>
      <p className="hint">Ou fais glisser directement dans la vue 3D : centre = déplacer, coin orange = redimensionner, poignée verte = pivoter.</p>
    </div>
  )
}

function CueInspector({ cue, projectPoints, selectedPointId, onSelectPoint }: {
  cue: Cue
  projectPoints: Point[]
  selectedPointId: string | null
  onSelectPoint: (id: string | null) => void
}) {
  const activatedIds = new Set(Object.keys(cue.activations))
  const availablePoints = projectPoints.filter((p) => !activatedIds.has(p.id))

  return (
    <div className="cue-inspector">
      <div className="cue-inspector-title">
        <input
          type="color"
          value={cue.color}
          onChange={(e) => sidecar.updateCue(cue.id, { color: e.target.value })}
          title="Couleur du bloc"
        />
        <h3>{cue.name}</h3>
      </div>
      <div className="activation-list">
        {Object.entries(cue.activations).map(([pointId, act]) => {
          const point = projectPoints.find((p) => p.id === pointId)
          return (
            <ActivationCard
              key={pointId}
              cueId={cue.id}
              pointId={pointId}
              point={point}
              activation={act}
              selected={pointId === selectedPointId}
              onSelect={() => onSelectPoint(pointId === selectedPointId ? null : pointId)}
            />
          )
        })}
      </div>
      {availablePoints.length > 0 && (
        <select
          defaultValue=""
          onChange={(e) => {
            if (!e.target.value) return
            sidecar.setActivation(cue.id, e.target.value, { fadeMs: 1000, easing: 'linear' })
            e.target.value = ''
          }}
        >
          <option value="" disabled>+ Activer un point…</option>
          {availablePoints.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
    </div>
  )
}

// Mirror of core/timeline.py EASING_NAMES — keep in sync by hand (same
// caveat as types.ts: no shared schema yet).
const EASING_NAMES = ['linear', 'smooth', 'ease-in', 'ease-out', 'bounce', 'spring', 'exponential']

/** One activation of the selected cue: every field the model supports
 * (X/Y/Z/lacet/fade/courbe, mission 2), each through NumericInput so a
 * mid-typing backend echo can never rewrite the field (constat n°1). A
 * cleared X/Y/Z/lacet commits null = axe détouché, il repasse en tracking
 * (§12.1) ; le fade, lui, est toujours défini. */
/** Édition groupée du timing (mission multi-sélection) : applique fade et
 * easing d'un coup à toutes les activations des acteurs sélectionnés dans
 * le bloc. Valeur affichée = commune si partagée, sinon vide (« mixte »).
 * Chaque changement écrit N set_activation — le backend reste la seule
 * source de vérité, comme partout. */
function GroupTimingPanel({ cue, selectedPointIds, projectPoints }: {
  cue: Cue
  selectedPointIds: string[]
  projectPoints: Point[]
}) {
  const activated = selectedPointIds.filter((id) => cue.activations[id])
  const acts = activated.map((id) => cue.activations[id])
  const shared = <T,>(get: (a: Activation) => T): T | null =>
    acts.length && acts.every((a) => get(a) === get(acts[0])) ? get(acts[0]) : null
  const sharedFade = shared((a) => a.fadeMs)
  const sharedEasing = shared((a) => a.easing)

  const applyAll = (patch: { fadeMs?: number; easing?: string }) => {
    for (const id of activated) sidecar.setActivation(cue.id, id, patch)
  }

  const names = selectedPointIds
    .map((id) => projectPoints.find((p) => p.id === id)?.name ?? id)

  return (
    <div className="group-timing">
      <h3>Timing groupé — {selectedPointIds.length} acteurs</h3>
      <p className="group-timing-names" title={names.join(', ')}>{names.join(', ')}</p>
      {activated.length === 0 ? (
        <p className="hint">Aucun des acteurs sélectionnés n’est activé dans ce bloc.</p>
      ) : (
        <>
          {activated.length < selectedPointIds.length && (
            <p className="hint">{activated.length} activé{activated.length > 1 ? 's' : ''} sur {selectedPointIds.length} — les autres ne sont pas touchés.</p>
          )}
          <div className="group-timing-grid">
            <label>Fade (s)
              <NumericInput
                value={sharedFade === null ? null : sharedFade / 1000} step={0.1} nullable
                onCommit={(v) => { if (v !== null && v >= 0) applyAll({ fadeMs: v * 1000 }) }}
              />
            </label>
            <label>Courbe
              <select
                value={sharedEasing ?? ''}
                onChange={(e) => { if (e.target.value) applyAll({ easing: e.target.value }) }}
              >
                {sharedEasing === null && <option value="">(mixte)</option>}
                {['linear', 'smooth', 'ease-in', 'ease-out', 'bounce', 'spring', 'exponential'].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  )
}

function ActivationCard({ cueId, pointId, point, activation, selected, onSelect }: {
  cueId: string
  pointId: string
  point: Point | undefined
  activation: Activation
  selected: boolean
  onSelect: () => void
}) {
  const set = (patch: Partial<{
    targetXCm: number | null; targetYCm: number | null; targetZCm: number | null
    targetYawDeg: number | null; fadeMs: number; easing: string
  }>) => sidecar.setActivation(cueId, pointId, patch)

  return (
    <div className={`activation-card${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="activation-card-head">
        <span className="swatch" style={{ background: point?.color ?? '#666' }} />
        <span className="activation-card-name">{point?.name ?? pointId}</span>
      </div>
      {/* stopPropagation : cliquer dans un champ ne doit pas basculer la
          sélection de l'acteur portée par la carte entière. */}
      <div className="activation-grid" onClick={(e) => e.stopPropagation()}>
        <label>X (m)
          <NumericInput value={activation.targetXCm === null ? null : activation.targetXCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetXCm: v === null ? null : v * 100 })} />
        </label>
        <label>Y (m)
          <NumericInput value={activation.targetYCm === null ? null : activation.targetYCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetYCm: v === null ? null : v * 100 })} />
        </label>
        <label>Z (m)
          <NumericInput value={activation.targetZCm === null ? null : activation.targetZCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetZCm: v === null ? null : v * 100 })} />
        </label>
        <label>Lacet (°)
          <NumericInput value={activation.targetYawDeg} step={5} nullable
            onCommit={(v) => set({ targetYawDeg: v })} />
        </label>
        <label>Fade (s)
          <NumericInput value={activation.fadeMs / 1000} step={0.1}
            onCommit={(v) => { if (v !== null && v >= 0) set({ fadeMs: v * 1000 }) }} />
        </label>
        <label>Courbe
          {(activation.pathPoints?.length || activation.startHandle || activation.targetHandle) ? (
            <button
              className="inspector-clear-path"
              title="Supprimer les waypoints et poignées : retour à la ligne droite"
              onClick={() => sidecar.setActivation(cueId, pointId, { pathPoints: null, startHandle: null, targetHandle: null })}
            >
              Tracé droit
            </button>
          ) : null}
          <select value={activation.easing} onChange={(e) => set({ easing: e.target.value })}>
            {EASING_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}

export default App
