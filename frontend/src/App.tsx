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
import { maxSpeedMs, msToKmh, pointSpeedMs, requiredFadeMsPerPointFromContext, speedCategory, SPEED_PRESETS } from './timeline/speed'
import { PsnPanel } from './ui/PsnPanel'
import { BundleHistoryPanel } from './ui/BundleHistoryPanel'
import { AddActorsPanel } from './ui/AddActorsPanel'
import { BlockDetailPanel } from './ui/BlockDetailPanel'
import { ContextMenu } from './ui/ContextMenu'
import { showContextMenu } from './ui/contextMenuStore'
import { buildActorContextMenuSections, buildFocusPointContextMenuSections } from './ui/actorContextMenu'
import { CompassPicker } from './ui/CompassPicker'
import { FocusPointSelect } from './ui/FocusPointSelect'
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, rectIntersection,
  useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { setLocale, t, useLocale, useT } from './i18n'

function lumitrackFilter() {
  return [{ name: t('common.lumitrackProjectFilter'), extensions: ['lumitrack'] }]
}

/** La cible d'un drop est là où POINTE le curseur — pas là où traîne le
 * rectangle translaté de l'élément saisi (décalé du point de saisie, même
 * problème déjà corrigé pour isInsertingAfter ci-dessous). pointerWithin
 * d'abord (le curseur est DANS une cible — la sémantique que l'utilisateur
 * perçoit, et celle que placeActorsAt applique déjà en raycastant aux
 * coordonnées du pointeur), rectIntersection en repli (pointeur entre deux
 * lignes du roster, geste sans coordonnées de pointeur). */
const dropCollisionDetection: CollisionDetection = (args) => {
  const withPointer = pointerWithin(args)
  return withPointer.length > 0 ? withPointer : rectIntersection(args)
}

/** Zone de dépôt 'scene' de dnd-kit — DOIT être déclarée par un composant
 * rendu À L'INTÉRIEUR de <DndContext> : useDroppable appelé directement
 * dans App (le composant qui rend le DndContext lui-même) lisait le
 * contexte par défaut (vide) et ne s'enregistrait JAMAIS dans le vrai
 * contexte — la zone 'scene' n'existait pour aucun geste, `over` restait
 * null au relâchement, et le drop roster→scène ne faisait rien du tout.
 * Cause racine du bug "drag and drop des acteurs sur le terrain ne marche
 * plus" (signalé 2026-08-04, présent depuis la migration dnd-kit du
 * 07-31), reproduit et diagnostiqué en navigateur : le registre des
 * droppables listait les 80 lignes du roster mais pas 'scene'. */
function SceneDropZone({ children }: { children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: 'scene' })
  return <main className="scene-view" ref={setNodeRef}>{children}</main>
}

/** Position RÉELLE du pointeur, suivie par un listener global (fix
 * 2026-08-04, "le point de focus n'a pas de position") : reconstruire le
 * point de drop avec `activatorEvent.clientX/Y + event.delta` donnait des
 * coordonnées fausses dès que le roster était SCROLLÉ au moment de saisir
 * la ligne (dnd-kit intègre la compensation de scroll dans `delta` —
 * clientY sortait NÉGATIF de ~la hauteur scrollée, le drop échouait au
 * test de bornes du canvas sans rien faire). Le pointeur, lui, ne ment
 * jamais. */
const lastPointer = { x: 0, y: 0 }
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e) => {
    lastPointer.x = e.clientX
    lastPointer.y = e.clientY
  }, { capture: true, passive: true })
}

/** Le curseur au-dessus de la moitié basse d'une ligne = insertion APRÈS
 * elle, moitié haute = AVANT — même convention que la plupart des listes
 * triables (Trello, Notion, etc.). `active.rect.current` n'a de valeur
 * `translated` qu'une fois le geste commencé ; `initial` sert de repli. */
function isInsertingAfter(event: DragOverEvent | DragEndEvent): boolean {
  const overRect = event.over?.rect
  if (!overRect) return false
  // Position Y RÉELLE du curseur (lastPointer, listener global) — ni le
  // rectangle "translaté" de l'élément actif (traîne derrière le curseur
  // d'un décalage fixe égal au point de saisie — "il faut dépasser et
  // revenir en arrière", signalé par Florian), ni activatorEvent + delta
  // (faussé par le scroll du roster, voir lastPointer).
  return lastPointer.y > overRect.top + overRect.height / 2
}

/** Dialogue "Enregistrer sous…" : toujours affiché, crée/écrase un fichier
 * .lumitrack au chemin choisi (dossier créé si besoin côté backend). */
async function pickSaveAsPath(projectName: string): Promise<string | null> {
  const path = await saveDialog({
    title: t('menu.file.saveAsDialogTitle'),
    defaultPath: `${projectName || t('common.defaultProjectName')}.lumitrack`,
    filters: lumitrackFilter(),
  })
  return typeof path === 'string' ? path : null
}
import type { Activation, BackstageZone, BlockContextMessage, Cue, FixtureMountPreset, Point, Project, RosterGroup } from './types'

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
  | { numeric: true; label: string; value: number; step: number; title?: string; onCommit: (v: number | null) => void }

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
                  : 'numeric' in item
                    ? (
                      <label key={j} className="menu-item-numeric" title={item.title}>
                        <span>{item.label}</span>
                        <NumericInput value={item.value} step={item.step} onCommit={item.onCommit} />
                      </label>
                    )
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
function RosterPointRow({ point, project, selected, moving, offstage, onSelect, dropLine }: {
  point: Point
  project: Project
  selected: boolean
  moving: boolean
  offstage: boolean
  onSelect: (e: React.MouseEvent) => void
  /** Trait indiquant où l'élément glissé tomberait s'il était lâché ici —
   * seul moyen fiable de viser la toute dernière place d'une liste
   * (demande de Florian). null = pas la cible actuelle du survol. */
  dropLine: 'before' | 'after' | null
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
  const t = useT()
  const dropLineClass = dropLine ? ` roster-drop-line-${dropLine}` : ''
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`${selected ? 'selected' : ''}${dropLineClass}`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        // Ne sélectionne QUE si l'acteur n'est pas déjà la sélection unique —
        // `onSelect` bascule une sélection déjà unique en désélection, ce qui
        // viderait la sélection juste avant d'ouvrir un menu qui la concerne.
        if (!selected) onSelect(e)
        showContextMenu(e, buildActorContextMenuSections(point, project))
      }}
      {...attributes}
      {...listeners}
    >
      <span
        className={`status-dot ${moving ? 'moving' : 'idle'}`}
        title={moving ? t('roster.statusMoving') : t('roster.statusIdle')}
      />
      <span className="swatch" style={{ background: point.color }} />
      {point.number !== null && <span className="point-number">{point.number}</span>}
      <span className="point-name">{point.name}</span>
      {offstage && <span className="offstage" title={t('roster.offstage')}>•</span>}
    </li>
  )
}

/** Prochaine lettre libre (A, B, C…) pour nommer un nouveau point de focus
 * — compteur SÉPARÉ du numéro des acteurs (mission "modes d'orientation",
 * 2026-08-04) : un point de focus n'a pas de `number` du tout, juste un nom
 * "Focus X" dont on scanne la lettre. Au-delà de Z (26 points de focus,
 * improbable en pratique), passe à AA/AB… */
function firstFreeLetter(existingNames: string[]): string {
  const used = new Set(
    existingNames
      .map((n) => /^Focus ([A-Z]+)$/.exec(n)?.[1])
      .filter((x): x is string => Boolean(x)),
  )
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (const letter of alphabet) if (!used.has(letter)) return letter
  for (const a of alphabet) for (const b of alphabet) {
    const letters = a + b
    if (!used.has(letters)) return letters
  }
  return 'X'
}

/** Ligne de point de focus du roster — version allégée de RosterPointRow :
 * pas de statut mouvant/offstage (un repère de visée n'a pas de "vie"
 * propre au sens acteur), pas de tri/dossiers. GLISSABLE vers la scène
 * (2026-08-04, "le point de focus ne marche pas, il n'a pas de position") :
 * un point de focus fraîchement créé n'a AUCUNE position (jamais
 * d'activation, exclu du backstage) — invisible dans la scène et donc
 * invisible pour le mode focus. Le déposer sur le terrain lui en donne une
 * (placeActorsAt : cue dédié à t=0, même mécanique que la migration). */
function FocusPointRow({ point, selected, onSelect }: {
  point: Point
  selected: boolean
  onSelect: (e: React.MouseEvent) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `point:${point.id}`,
    data: { type: 'point', pointId: point.id } satisfies RosterDragData,
  })
  return (
    <li
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : undefined }}
      className={selected ? 'selected' : ''}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!selected) onSelect(e)
        showContextMenu(e, buildFocusPointContextMenuSections(point))
      }}
      {...attributes}
      {...listeners}
    >
      <span className="swatch focus-point-swatch" style={{ background: point.color }} />
      <span className="point-name">{point.name}</span>
    </li>
  )
}

/** En-tête de dossier — glissable (réordonner les dossiers entre eux) ET
 * cible de dépôt (recevoir des acteurs, de n'importe quel autre conteneur :
 * useSortable enregistre le droppable indépendamment du SortableContext
 * d'où vient l'élément actif). Les contrôles internes (caret, renommage,
 * suppression) coupent la propagation du pointerdown en plus du clic, sinon
 * les utiliser pourrait être lu comme le tout début d'un glisser de dossier. */
function RosterGroupHead({ group, memberCount, collapsed, renaming, onToggleCollapse, onStartRename, onCommitRename, onCancelRename, onDelete, onSelectAll, dropLine }: {
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
  dropLine: 'before' | 'after' | null
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
  const t = useT()
  const dropLineClass = dropLine ? ` roster-drop-line-${dropLine}` : ''
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`roster-group-head${dropLineClass}`}
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
        /* PAS de stopPropagation sur le pointerdown du nom (retiré
           2026-08-04) : il rendait l'en-tête quasi inglissable — le nom
           est LA zone de saisie naturelle pour glisser un groupe (vers la
           scène pour placer tous ses acteurs, ou pour réordonner). Le
           double-clic de renommage ne risque rien : le PointerSensor de
           dnd-kit exige 4 px de mouvement avant d'activer un glisser, un
           double-clic immobile n'en déclenche jamais un. */
        <span
          className="roster-group-name"
          onDoubleClick={(e) => { e.stopPropagation(); onStartRename() }}
          title={t('roster.renameFolderHint')}
        >
          {group.name}
        </span>
      )}
      <span className="roster-group-count">{memberCount}</span>
      <button
        className="roster-group-delete"
        title={t('roster.deleteFolder')}
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
  const t = useT()
  return (
    <li ref={setNodeRef} className={`roster-ungrouped-zone${isOver ? ' roster-drop-over' : ''}`}>
      {t('roster.ungrouped')}
    </li>
  )
}

function App() {
  const t = useT()
  const locale = useLocale()
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
  // "Grille on/off" (menu contextuel terrain vide) : bascule à 0, garde la
  // dernière opacité non nulle pour la retrouver telle quelle en rallumant
  // plutôt que de retomber sur un défaut arbitraire.
  const lastGridOpacityRef = useRef(0.5)
  useEffect(() => { if (gridOpacity > 0) lastGridOpacityRef.current = gridOpacity }, [gridOpacity])
  const toggleGrid = useCallback(() => {
    setGridOpacity((v) => (v > 0 ? 0 : lastGridOpacityRef.current))
  }, [])
  const [snapToGrid, setSnapToGrid] = useState(false)
  const [zoomAction, setZoomAction] = useState({ token: 0, factor: 1 })
  const [showGridSettings, setShowGridSettings] = useState(false)
  const [showPsnPanel, setShowPsnPanel] = useState(false)
  const [showBundleHistory, setShowBundleHistory] = useState(false)
  const [showAddActors, setShowAddActors] = useState(false)
  const [showBlockDetail, setShowBlockDetail] = useState(false)
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
    // try/catch SYNCHRONE en plus du .catch : hors Tauri (dev navigateur),
    // getCurrentWebview() LANCE une exception synchrone (lecture de
    // __TAURI_INTERNALS__ absent) avant même de retourner une promesse —
    // le .catch seul ne suffisait pas, et l'exception non rattrapée dans
    // cet effet démontait TOUTE l'app (écran blanc, aucun error boundary),
    // constaté le 2026-08-04 en reproduisant le bug "l'app ne se lance
    // plus" dans un navigateur.
    try {
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
    } catch {
      /* hors Tauri (dev navigateur) : pas de drag-drop de fichiers natif */
    }
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
  // Ligne indiquant où l'élément tombera (demande de Florian : sans repère
  // visuel explicite, difficile de viser la toute dernière place d'un
  // dossier). Recalculée à chaque survol — seul un id + un booléen sont
  // conservés, chaque ligne compare juste son propre id pour savoir si
  // elle doit afficher un trait.
  const [dropIndicator, setDropIndicator] = useState<{ overId: string; after: boolean } | null>(null)
  const handleDragOver = useCallback((event: DragOverEvent) => {
    setDropIndicator(event.over ? { overId: String(event.over.id), after: isInsertingAfter(event) } : null)
  }, [])

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
      setActiveDragLabel(ids.length > 1 ? t('roster.dragMultiple', { count: ids.length }) : (point?.name ?? ''))
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
    setDropIndicator(null)
    const activeData = event.active.data.current as RosterDragData | undefined
    const overId = event.over ? String(event.over.id) : null
    if (!overId || !activeData) return

    if (overId === 'scene') {
      if (ids.length === 0) return
      // Position réelle du pointeur au relâchement (voir lastPointer) —
      // jamais activatorEvent + delta, faussé par le scroll du roster.
      sceneRef.current?.placeActorsAt(ids, lastPointer.x, lastPointer.y, altHeldRef.current)
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
          // Réordonner les dossiers : moitié basse de l'en-tête visé =
          // après lui, moitié haute = avant (même convention que les lignes).
          const proj = rosterProjectRef.current
          if (!proj) return
          const order = proj.rosterGroups.map((g) => g.id).filter((id) => id !== activeData.groupId)
          const targetIdx = order.indexOf(targetGroupId)
          const at = isInsertingAfter(event) ? targetIdx + 1 : targetIdx
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
        if (ids.includes(targetPointId)) return
        const targetGroupId = targetPoint?.rosterGroupId ?? null
        // Position exacte au sein du MÊME conteneur (dossier ou sans
        // groupe) que la ligne visée : moitié basse = après elle (donc
        // avant le membre suivant, ou en toute fin s'il n'y en a pas —
        // seul moyen de "tomber en dernière place" dans un groupe), moitié
        // haute = avant elle.
        const containerMembers = (proj?.points ?? []).filter((p) => p.rosterGroupId === targetGroupId)
        const targetIdx = containerMembers.findIndex((p) => p.id === targetPointId)
        const beforeId = isInsertingAfter(event)
          ? (containerMembers[targetIdx + 1]?.id ?? null)
          : targetPointId
        moveDroppedIds(ids, targetGroupId, beforeId)
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
  // exact (raycasting) est recalculé dans handleDragEnd via placeActorsAt.
  // L'enregistrement du droppable vit dans SceneDropZone (voir sa doc :
  // useDroppable ICI, hors du DndContext rendu plus bas, ne s'enregistrait
  // jamais).

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

  // Le panneau "détail du bloc" est une action explicite par bloc, pas un
  // état qui doit survivre à un changement de sélection — sinon rouvrir un
  // autre bloc plus tard le ferait réapparaître sans que Florian ne l'ait
  // redemandé.
  useEffect(() => { setShowBlockDetail(false) }, [selectedCueId])

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

  // "ouvre automatiquement le bloc dans lequel il se trouve" (Florian,
  // 2026-08-01) : sélectionner UN acteur ouvre directement le bloc qui
  // couvre l'instant courant du playhead pour cet acteur, sans étape
  // manuelle en plus — seulement au moment où la sélection change (pas à
  // chaque tick pendant que l'acteur reste sélectionné, ça ferait sauter
  // l'inspecteur pendant la lecture). Pas de généralisation en multi-
  // sélection : des acteurs différents peuvent être dans des blocs
  // différents, ambigu.
  useEffect(() => {
    if (selectedPointIds.length !== 1 || !project) return
    const pointId = selectedPointIds[0]
    let match: Cue | null = null
    for (const cue of project.cues) {
      if (tMs < cue.startMs || tMs >= cue.startMs + cue.durationMs) continue
      if (!cue.activations[pointId]) continue
      if (!match || cue.startMs > match.startMs) match = cue
    }
    if (match) setSelectedCueId(match.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPointIds])

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
          if (window.confirm(t('roster.deleteActorsConfirm', { count, plural: count > 1 ? 's' : '' }))) {
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
        {connected ? t('common.loadingConnecting') : t('common.loadingWaiting')}
      </div>
    )
  }

  const menus = [
    {
      label: t('menu.file'),
      items: [
        { label: t('menu.file.new'), onClick: () => {
          const name = window.prompt(t('menu.file.newProjectPrompt'), t('menu.file.newProjectDefault'))
          if (name) sidecar.newProject(name)
        } },
        { label: t('menu.file.importStancz'), onClick: async () => {
          const path = await openDialog({
            title: t('menu.file.importStanczDialogTitle'),
            filters: [{ name: 'Stancz', extensions: ['stancz'] }],
          })
          if (typeof path === 'string') sidecar.importStancz(path)
        } },
        { separator: true } as const,
        { label: t('menu.file.importAudio'), onClick: async () => {
          const path = await openDialog({
            title: t('menu.file.importAudioDialogTitle'),
            filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'] }],
          })
          if (typeof path === 'string') sidecar.setAudio({ path })
        } },
        { label: t('menu.file.removeAudio'), disabled: !project.audioPath, onClick: () => {
          sidecar.setAudio({ path: null })
        } },
        { separator: true } as const,
        { label: t('menu.file.save'), onClick: () => saveOrSaveAs(project.name) },
        { label: t('menu.file.saveAs'), onClick: async () => {
          const path = await pickSaveAsPath(project.name)
          if (path) sidecar.saveBundle(path)
        } },
        { label: t('menu.file.open'), onClick: async () => {
          const path = await openDialog({
            title: t('menu.file.openDialogTitle'),
            filters: lumitrackFilter(),
          })
          if (typeof path === 'string') sidecar.loadBundle(path)
        } },
        { label: t('menu.file.bundleHistory'), disabled: !bundlePath, onClick: () => setShowBundleHistory(true) },
      ],
    },
    {
      label: t('menu.edit'),
      items: [
        { label: t('menu.edit.undo'), disabled: !undoAvailable, onClick: () => sidecar.undo() },
        { label: t('menu.edit.redo'), disabled: !redoAvailable, onClick: () => sidecar.redo() },
      ],
    },
    {
      label: t('menu.view'),
      items: [
        { label: t('menu.view.fit3d'), onClick: () => setFitToken((prev) => prev + 1) },
        { separator: true } as const,
        { label: t('menu.view.lockCamera'), checked: cameraLocked, onClick: () => setCameraLocked((v) => !v) },
        { label: t('menu.view.editZone'), checked: editingZone, onClick: () => setEditingZone((v) => !v) },
      ],
    },
    {
      label: t('menu.output'),
      items: [
        {
          label: psnRunning ? t('menu.output.stopPsn') : t('menu.output.startPsn'),
          checked: psnRunning,
          onClick: () => (psnRunning ? sidecar.psnStop() : sidecar.psnStart()),
        },
        { separator: true } as const,
        { label: t('menu.output.psnSettings'), onClick: () => setShowPsnPanel(true) },
      ],
    },
    {
      label: t('menu.settings'),
      items: [
        { label: t('menu.settings.language.fr'), checked: locale === 'fr', onClick: () => setLocale('fr') },
        { label: t('menu.settings.language.en'), checked: locale === 'en', onClick: () => setLocale('en') },
        { separator: true } as const,
        {
          numeric: true, label: t('menu.settings.actorDiameter'), title: t('menu.settings.actorDiameterHint'),
          value: project.actorDiameterCm / 100, step: 0.05,
          onCommit: (v: number | null) => { if (v !== null && v > 0) sidecar.updateProjectSettings({ actorDiameterCm: v * 100 }) },
        } as const,
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
      <DndContext sensors={dndSensors} collisionDetection={dropCollisionDetection} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
      <MenuBar menus={menus} />

      <aside className="roster">
        <div className="roster-head">
          <h2>{t('roster.title')}</h2>
          <span className="roster-spacer" />
          <button
            title={t('roster.newFolder')}
            onClick={() => {
              const id = crypto.randomUUID()
              sidecar.setRosterGroups([...project.rosterGroups, { id, name: t('roster.newFolderDefaultName') }])
              setRenamingGroupId(id)
            }}
          >
            {t('roster.newFolderBtn')}
          </button>
          <button
            title={t('roster.addActor')}
            onClick={() => setShowAddActors(true)}
          >
            {t('roster.addActorBtn')}
          </button>
          <button
            title={t('roster.addFocusPointHint')}
            onClick={() => {
              const letter = firstFreeLetter(project.points.filter((p) => p.isFocusPoint).map((p) => p.name))
              sidecar.addFocusPoint(`Focus ${letter}`, '#D8D8E2', crypto.randomUUID())
            }}
          >
            {t('roster.addFocusPointBtn')}
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
            // ensuite — purement pour ordonner la vue. Les points de focus
            // (simples repères de visée, pas des acteurs) vivent dans leur
            // propre section plus bas, jamais mélangés aux dossiers.
            const grouped = project.rosterGroups.map((g) => ({
              group: g,
              members: project.points.filter((p) => p.rosterGroupId === g.id && !p.isFocusPoint),
            }))
            const ungrouped = project.points.filter((p) =>
              !p.isFocusPoint && !project.rosterGroups.some((g) => g.id === p.rosterGroupId))
            const focusPoints = project.points.filter((p) => p.isFocusPoint)

            return (
              <>
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
                          if (window.confirm(t('roster.deleteFolderConfirm'))) {
                            sidecar.setRosterGroups(project.rosterGroups.filter((g) => g.id !== group.id))
                          }
                        }}
                        onSelectAll={() => setSelectedPointIds(members.map((m) => m.id))}
                        dropLine={dropIndicator?.overId === `group:${group.id}` ? (dropIndicator.after ? 'after' : 'before') : null}
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
                                project={project}
                                selected={selectedPointIds.includes(p.id)}
                                moving={movingPointIds.has(p.id)}
                                offstage={!positions[p.id]}
                                onSelect={selectRange(p)}
                                dropLine={dropIndicator?.overId === `point:${p.id}` ? (dropIndicator.after ? 'after' : 'before') : null}
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
                      project={project}
                      selected={selectedPointIds.includes(p.id)}
                      moving={movingPointIds.has(p.id)}
                      offstage={!positions[p.id]}
                      onSelect={selectRange(p)}
                      dropLine={dropIndicator?.overId === `point:${p.id}` ? (dropIndicator.after ? 'after' : 'before') : null}
                    />
                  ))}
                </SortableContext>
              </SortableContext>
              {focusPoints.length > 0 && (
                <>
                  <li className="roster-section-label">{t('roster.focusPointsSection')}</li>
                  {focusPoints.map((p) => (
                    <FocusPointRow
                      key={p.id}
                      point={p}
                      selected={selectedPointIds.includes(p.id)}
                      onSelect={selectRange(p)}
                    />
                  ))}
                </>
              )}
              </>
            )
          })()}
        </ul>
      </aside>

      <VerticalResizer area="vhandle1" onDeltaX={(dx) => setRosterWidth((w) => clamp(w + dx, ROSTER_MIN, ROSTER_MAX))} />

      <SceneDropZone>
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
          onToggleGrid={toggleGrid}
          onFitToWindow={() => setFitToken((v) => v + 1)}
        />

        <div className="viewport-toolbar">
          <button title={t('viewport.zoomIn')} onClick={zoomIn}>+</button>
          <button title={t('viewport.zoomOut')} onClick={zoomOut}>−</button>
          <button title={t('viewport.fit')} onClick={() => setFitToken((prev) => prev + 1)}>
            <FitIcon />
          </button>
          <button
            title={t('viewport.snapToGrid')}
            className={snapToGrid ? 'active' : ''}
            onClick={() => setSnapToGrid((v) => !v)}
          >
            #
          </button>
          <div className="viewport-toolbar-settings" ref={gridSettingsRef}>
            <button title={t('viewport.gridSettings')} onClick={() => setShowGridSettings((v) => !v)}>⚙</button>
            {showGridSettings && (
              <div className="viewport-popover" onClick={(e) => e.stopPropagation()}>
                <label>
                  {t('viewport.gridOpacity')}
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={gridOpacity}
                    onChange={(e) => setGridOpacity(Number(e.target.value))}
                  />
                </label>
                <label>
                  {t('viewport.terrainRotation')}
                  <NumericInput
                    value={project.terrainRotationDeg ?? 0} step={15}
                    onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ terrainRotationDeg: v }) }}
                  />
                </label>
                <label>
                  {t('viewport.gridSize')}
                  <NumericInput
                    value={project.gridSizeCm / 100} step={0.1}
                    onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ gridSizeCm: v * 100 }) }}
                  />
                </label>
                <label title={t('viewport.referenceSpeedHint')}>
                  {t('viewport.referenceSpeed')}
                  <NumericInput
                    value={project.referenceSpeedCms * 0.036} step={0.5}
                    onCommit={(v) => { if (v !== null && v >= 0.5) sidecar.updateProjectSettings({ referenceSpeedCms: v / 0.036 }) }}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </SceneDropZone>

      <VerticalResizer area="vhandle2" onDeltaX={(dx) => setInspectorWidth((w) => clamp(w - dx, INSPECTOR_MIN, INSPECTOR_MAX))} />

      <aside className="inspector">
        <h2>{t('inspector.title')}</h2>
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
            mountPresets={project.fixtureMountPresets}
            selectedPointId={selectedPointId}
            onSelectPoint={setSelectedPointId}
            blockContext={blockContext}
            onOpenBlockDetail={() => setShowBlockDetail(true)}
          />
        ) : (
          !editingZone && selectedPointIds.length === 0 && (
            <p className="hint">{t('inspector.emptyHint')}</p>
          )
        )}
      </aside>

      <HorizontalResizer area="hhandle" onDeltaY={(dy) => setTimelineHeight((h) => clamp(h - dy, TIMELINE_MIN, TIMELINE_MAX))} />

      {showPsnPanel && <PsnPanel project={project} onClose={() => setShowPsnPanel(false)} />}
      {showBundleHistory && bundlePath && (
        <BundleHistoryPanel path={bundlePath} onClose={() => setShowBundleHistory(false)} />
      )}
      {showAddActors && <AddActorsPanel project={project} onClose={() => setShowAddActors(false)} />}
      <ContextMenu />
      <footer className="timeline-dock">
        {showBlockDetail && selectedCue && (
          <BlockDetailPanel
            cue={selectedCue}
            projectPoints={project.points}
            tMs={tMs}
            audioPath={project.audioPath}
            onClose={() => setShowBlockDetail(false)}
          />
        )}
        <CueTimeline
          project={project}
          tMs={tMs}
          playing={playing}
          durationMs={durationMs}
          connected={connected}
          selectedCueId={selectedCueId}
          selectedPointId={selectedPointId}
          onSelectCue={setSelectedCueId}
          blockContext={blockContext}
          positions={positions}
          onOpenBlockDetail={() => setShowBlockDetail(true)}
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
  const t = useT()
  const zones = project.backstageZones ?? []
  if (selectedPointIds.length === 0) return null
  if (selectedPointIds.length > 1) {
    const names = selectedPointIds
      .map((id) => project.points.find((p) => p.id === id)?.name ?? id)
    return (
      <div className="actor-inspector">
        <h3>{t('inspector.actorsSelected', { count: selectedPointIds.length })}</h3>
        <p className="group-timing-names" title={names.join(', ')}>{names.join(', ')}</p>
        <p className="hint">{t('inspector.multiSelectHint')}</p>
      </div>
    )
  }
  const point = project.points.find((p) => p.id === selectedPointIds[0])
  if (!point) return null
  return (
    <div className="actor-inspector">
      <h3>
        <span className="swatch" style={{ background: point.color }} />
        {t('inspector.actor')}
      </h3>
      <div className="actor-grid">
        <label>{t('inspector.name')}
          <input
            key={point.id + point.name}
            defaultValue={point.name}
            onBlur={(e) => { if (e.target.value !== point.name) sidecar.updatePoint(point.id, { name: e.target.value }) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        </label>
        <label>{t('inspector.color')}
          <input
            type="color"
            value={point.color}
            onChange={(e) => sidecar.updatePoint(point.id, { color: e.target.value })}
          />
        </label>
        <label>{t('inspector.number')}
          <NumericInput value={point.number} step={1} nullable
            onCommit={(v) => sidecar.updatePoint(point.id, { number: v })} />
        </label>
        <label>{t('inspector.psnId')}
          <NumericInput value={point.psnTrackerId} step={1} nullable
            onCommit={(v) => sidecar.updatePoint(point.id, { psnTrackerId: v })} />
        </label>
        <label>{t('inspector.height')}
          <NumericInput value={point.defaultHeightCm / 100} step={0.1}
            onCommit={(v) => { if (v !== null && v >= 0) sidecar.updatePoint(point.id, { defaultHeightCm: v * 100 }) }} />
        </label>
        <label>{t('inspector.homeZone')}
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
  const t = useT()
  const zones = project.backstageZones ?? []
  const update = (id: string, patch: Partial<BackstageZone>) => {
    sidecar.setBackstageZones(zones.map((z) => (z.id === id ? { ...z, ...patch } : z)))
  }
  return (
    <div className="stage-placement">
      <h3>{t('backstage.title')}</h3>
      {zones.map((zone) => (
        <div key={zone.id} className="backstage-block">
          <div className="backstage-row">
            <input
              value={zone.name}
              onChange={(e) => update(zone.id, { name: e.target.value })}
              title={t('backstage.zoneName')}
            />
            <button
              title={t('backstage.deleteZone')}
              disabled={zones.length <= 1}
              onClick={() => sidecar.setBackstageZones(zones.filter((z) => z.id !== zone.id))}
            >
              ✕
            </button>
          </div>
          <div className="backstage-grid">
            <label>{t('backstage.x')}
              <NumericInput value={zone.xCm / 100} step={0.5}
                onCommit={(v) => { if (v !== null) update(zone.id, { xCm: v * 100 }) }} />
            </label>
            <label>{t('backstage.y')}
              <NumericInput value={zone.yCm / 100} step={0.5}
                onCommit={(v) => { if (v !== null) update(zone.id, { yCm: v * 100 }) }} />
            </label>
            <label>{t('backstage.width')}
              <NumericInput value={zone.widthCm / 100} step={0.5}
                onCommit={(v) => { if (v !== null && v >= 0.6) update(zone.id, { widthCm: v * 100 }) }} />
            </label>
            <label>{t('backstage.height')}
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
          name: t('backstage.addZoneDefaultName', { n: zones.length + 1 }),
          xCm: project.stageWidthCm + 100,
          yCm: 0,
          widthCm: 400,
          heightCm: Math.min(1200, project.stageHeightCm),
        }])}
      >
        {t('backstage.addZone')}
      </button>
      <p className="hint">{t('backstage.hint')}</p>
    </div>
  )
}

function StagePlacementPanel({ project }: { project: Project }) {
  const t = useT()
  return (
    <div className="stage-placement">
      <h3>{t('stagePlacement.title')}</h3>
      <div className="stage-placement-grid">
        <label>{t('stagePlacement.originX')}
          <NumericInput value={project.stageMapOriginXM} step={0.1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ originXM: v }) }} />
        </label>
        <label>{t('stagePlacement.originZ')}
          <NumericInput value={project.stageMapOriginZM} step={0.1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ originZM: v }) }} />
        </label>
        <label>{t('stagePlacement.rotation')}
          <NumericInput value={project.stageMapRotationDeg} step={1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ rotationDeg: v }) }} />
        </label>
        <label>{t('stagePlacement.width')}
          <NumericInput value={project.stageWidthCm / 100} step={0.5}
            onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ widthCm: v * 100 }) }} />
        </label>
        <label>{t('stagePlacement.height')}
          <NumericInput value={project.stageHeightCm / 100} step={0.5}
            onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ heightCm: v * 100 }) }} />
        </label>
      </div>
      <p className="hint">{t('stagePlacement.hint')}</p>
    </div>
  )
}

function CueInspector({ cue, projectPoints, mountPresets, selectedPointId, onSelectPoint, blockContext, onOpenBlockDetail }: {
  cue: Cue
  projectPoints: Point[]
  mountPresets: FixtureMountPreset[]
  selectedPointId: string | null
  onSelectPoint: (id: string | null) => void
  blockContext: BlockContextMessage | null
  onOpenBlockDetail: () => void
}) {
  const t = useT()
  const activatedIds = new Set(Object.keys(cue.activations))
  const availablePoints = projectPoints.filter((p) => !activatedIds.has(p.id))
  const speed = maxSpeedMs(cue, blockContext)

  return (
    <div className="cue-inspector">
      <div className="cue-inspector-title">
        <input
          type="color"
          value={cue.color}
          onChange={(e) => sidecar.updateCue(cue.id, { color: e.target.value })}
          title={t('cue.color')}
        />
        <h3>{cue.name}</h3>
        <span className="cue-inspector-title-spacer" />
        <button
          className="cue-open-block-detail"
          title={t('cue.openBlockDetailHint')}
          onClick={onOpenBlockDetail}
        >
          {t('cue.openBlockDetail')}
        </button>
      </div>
      <div className="cue-inspector-timing-row">
        <label className="cue-auto-duration" title={t('cue.autoDurationHint')}>
          <input
            type="checkbox"
            checked={cue.autoDuration}
            onChange={(e) => sidecar.updateCue(cue.id, { autoDuration: e.target.checked })}
          />
          {t('cue.autoDuration')}
        </label>
        {speed !== null && (() => {
          const [key, color] = speedCategory(speed)
          const kmh = msToKmh(speed)
          const label = t(`speed.${key}`)
          return (
            <span className="speed-thermometer" style={{ '--speed-color': color } as React.CSSProperties}
              title={t('cue.speedHint', { kmh: kmh.toFixed(1), label })}>
              {kmh.toFixed(1)} km/h · {label}
            </span>
          )
        })()}
      </div>
      <div className="speed-presets" title={t('cue.speedPresetsHint')}>
        {SPEED_PRESETS.map((preset) => (
          <button
            key={preset.key}
            className="speed-preset-btn"
            style={{ '--speed-color': preset.color } as React.CSSProperties}
            disabled={blockContext?.cueId !== cue.id}
            onClick={() => {
              // Chaque acteur reçoit SON fade (sa propre distance à cette
              // vitesse) — pas juste la largeur du bloc, sinon la boîte
              // change de vitesse affichée mais les acteurs continuent de
              // bouger à leur ancien fade_ms (signalé 2026-08-03).
              const perPoint = requiredFadeMsPerPointFromContext(cue, blockContext, preset.ms)
              if (!perPoint || Object.keys(perPoint).length === 0) return
              for (const [pointId, fadeMs] of Object.entries(perPoint)) {
                sidecar.setActivation(cue.id, pointId, { fadeMs })
              }
              const durationMs = Math.max(...Object.values(perPoint))
              sidecar.updateCue(cue.id, { durationMs, autoDuration: false })
            }}
          >
            {t(`speed.${preset.key}`)} ({msToKmh(preset.ms).toFixed(0)} km/h)
          </button>
        ))}
      </div>
      <CueOrientationDefaults cue={cue} projectPoints={projectPoints} />
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
              blockContext={blockContext}
              allPoints={projectPoints}
              mountPresets={mountPresets}
            />
          )
        })}
      </div>
      {availablePoints.length > 0 && (
        <select
          defaultValue=""
          onChange={(e) => {
            if (!e.target.value) return
            // Pas de fadeMs explicite : le backend applique le défaut du
            // bloc (sa durée) pour un nouvel acteur, pas une constante
            // arbitraire (voir set_activation, mission "global vs sélectif").
            sidecar.setActivation(cue.id, e.target.value, { easing: 'linear' })
            e.target.value = ''
          }}
        >
          <option value="" disabled>{t('cue.activatePoint')}</option>
          {availablePoints.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
    </div>
  )
}

/** Réglage par défaut du BLOC pour l'orientation (mission "modes
 * d'orientation", 2026-08-04, même esprit que le timing point 6) —
 * préremplit toute NOUVELLE activation du bloc et resynchronise
 * (backend : _apply_cue_orientation_defaults) toute activation existante
 * non personnalisée dès qu'on change un réglage ici. Repliée par défaut,
 * même logique que les cartes d'activation (peu utilisée au quotidien). */
function CueOrientationDefaults({ cue, projectPoints }: { cue: Cue; projectPoints: Point[] }) {
  const t = useT()
  const [collapsed, setCollapsed] = useState(true)
  return (
    <div className="cue-orientation-defaults">
      <button
        className="cue-orientation-defaults-toggle"
        onClick={() => setCollapsed((v) => !v)}
      >
        {collapsed ? '▸' : '▾'} {t('cue.blockOrientationDefaultsTitle')}
      </button>
      {!collapsed && (
        <div className="activation-orientation">
          <div className="activation-orientation-phase">
            <h4>{t('cue.travelPhase')}</h4>
            <OrientationPhaseFields
              phase="travel"
              mode={cue.defaultTravelOrientationMode ?? 'fixed'}
              fixedDeg={cue.defaultTravelFixedYawDeg ?? 0}
              focusId={cue.defaultTravelFocusPointId ?? null}
              points={projectPoints}
              onModeChange={(m) => sidecar.updateCue(cue.id, { defaultTravelOrientationMode: m as 'fixed' | 'path' | 'focus' })}
              onFixedDegChange={(d) => sidecar.updateCue(cue.id, { defaultTravelFixedYawDeg: d })}
              onFocusChange={(id) => sidecar.updateCue(cue.id, { defaultTravelFocusPointId: id })}
            />
          </div>
          <div className="activation-orientation-phase">
            <h4>{t('cue.arrivalPhase')}</h4>
            <OrientationPhaseFields
              phase="arrival"
              mode={cue.defaultArrivalOrientationMode ?? 'hold'}
              fixedDeg={cue.defaultArrivalFixedYawDeg ?? 0}
              focusId={cue.defaultArrivalFocusPointId ?? null}
              points={projectPoints}
              onModeChange={(m) => sidecar.updateCue(cue.id, { defaultArrivalOrientationMode: m as 'hold' | 'fixed' | 'focus' })}
              onFixedDegChange={(d) => sidecar.updateCue(cue.id, { defaultArrivalFixedYawDeg: d })}
              onFocusChange={(id) => sidecar.updateCue(cue.id, { defaultArrivalFocusPointId: id })}
            />
          </div>
        </div>
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
  const t = useT()
  const [staggerMs, setStaggerMs] = useState(100)
  const activated = selectedPointIds.filter((id) => cue.activations[id])
  const acts = activated.map((id) => cue.activations[id])
  const shared = <T,>(get: (a: Activation) => T): T | null =>
    acts.length && acts.every((a) => get(a) === get(acts[0])) ? get(acts[0]) : null
  const sharedFade = shared((a) => a.fadeMs)
  const sharedEasing = shared((a) => a.easing)

  const applyAll = (patch: { fadeMs?: number; easing?: string }) => {
    // Une édition groupée est aussi une personnalisation manuelle : sort du
    // recalcul de la durée automatique tant qu'elle reste personnalisée
    // (même logique que le champ individuel de ActivationCard).
    const withOverride = 'fadeMs' in patch ? { ...patch, fadeOverridden: true } : patch
    for (const id of activated) sidecar.setActivation(cue.id, id, withOverride)
  }

  // "Décalage en escalier" (DIRECTIVES.md point 6) : respecte l'ORDRE DE
  // SÉLECTION déjà suivi par `selectedPointIds` (donc `activated`, qui en
  // hérite) — le premier acteur cliqué part en premier, le suivant
  // `staggerMs` plus tard, etc. Effet vague/escalier sans nouveau suivi
  // d'ordre à écrire.
  const applyStagger = () => {
    activated.forEach((id, i) => sidecar.setActivation(cue.id, id, { startOffsetMs: i * staggerMs }))
  }

  const names = selectedPointIds
    .map((id) => projectPoints.find((p) => p.id === id)?.name ?? id)

  return (
    <div className="group-timing">
      <h3>{t('cue.groupTimingTitle', { count: selectedPointIds.length })}</h3>
      <p className="group-timing-names" title={names.join(', ')}>{names.join(', ')}</p>
      {activated.length === 0 ? (
        <p className="hint">{t('cue.groupTimingNone')}</p>
      ) : (
        <>
          {activated.length < selectedPointIds.length && (
            <p className="hint">{t('cue.groupTimingPartial', {
              activated: activated.length, activatedPlural: activated.length > 1 ? 's' : '',
              total: selectedPointIds.length,
            })}</p>
          )}
          <div className="group-timing-grid">
            <label>{t('cue.fade')}
              <NumericInput
                value={sharedFade === null ? null : sharedFade / 1000} step={0.1} nullable
                onCommit={(v) => { if (v !== null && v >= 0) applyAll({ fadeMs: v * 1000 }) }}
              />
            </label>
            <label>{t('cue.curve')}
              <select
                value={sharedEasing ?? ''}
                onChange={(e) => { if (e.target.value) applyAll({ easing: e.target.value }) }}
              >
                {sharedEasing === null && <option value="">{t('cue.curveMixed')}</option>}
                {['linear', 'smooth', 'ease-in', 'ease-out', 'bounce', 'spring', 'exponential'].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="group-timing-stagger" title={t('cue.staggerHint')}>
            <label>{t('cue.stagger')}
              <NumericInput value={staggerMs} step={10}
                onCommit={(v) => setStaggerMs(Math.max(0, v ?? 0))} />
            </label>
            <button onClick={applyStagger}>{t('cue.staggerApply')}</button>
          </div>
        </>
      )}
    </div>
  )
}

/** Champs d'une phase d'orientation (mission "modes d'orientation",
 * 2026-08-04) — partagé entre l'ActivationCard (par activation) et la
 * section "orientation par défaut du bloc" du CueInspector, pour ne pas
 * dupliquer la logique mode/angle/boussole/point de focus. */
function OrientationPhaseFields({ phase, mode, fixedDeg, focusId, points, onModeChange, onFixedDegChange, onFocusChange }: {
  phase: 'travel' | 'arrival'
  mode: string
  fixedDeg: number
  focusId: string | null
  points: Point[]
  onModeChange: (mode: string) => void
  onFixedDegChange: (deg: number) => void
  onFocusChange: (id: string | null) => void
}) {
  const t = useT()
  const modeOptions: Array<[string, string]> = phase === 'travel'
    ? [['fixed', t('cue.rotationFixed')], ['path', t('cue.rotationPath')], ['focus', t('cue.rotationFocus')]]
    : [['hold', t('cue.arrivalHold')], ['fixed', t('cue.rotationFixed')], ['focus', t('cue.rotationFocus')]]
  return (
    <>
      <label>{phase === 'travel' ? t('cue.travelMode') : t('cue.arrivalMode')}
        <select value={mode} onChange={(e) => onModeChange(e.target.value)} title={t('cue.rotationHint')}>
          {modeOptions.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
      {mode === 'fixed' && (
        <>
          <label>{t('cue.yaw')}
            <NumericInput value={fixedDeg} step={5} onCommit={(v) => onFixedDegChange(v ?? 0)} />
          </label>
          <CompassPicker valueDeg={fixedDeg} onPick={onFixedDegChange} />
        </>
      )}
      {mode === 'focus' && (
        <label>{t('cue.focusPoint')}
          <FocusPointSelect points={points} value={focusId} onChange={onFocusChange} />
        </label>
      )}
    </>
  )
}

function ActivationCard({ cueId, pointId, point, activation, selected, onSelect, blockContext, allPoints, mountPresets }: {
  cueId: string
  pointId: string
  point: Point | undefined
  activation: Activation
  selected: boolean
  onSelect: () => void
  blockContext: BlockContextMessage | null
  allPoints: Point[]
  mountPresets: FixtureMountPreset[]
}) {
  const t = useT()
  // Repliée par défaut (mission "replier les acteurs", 2026-08-03) : une
  // carte dépliée par acteur activé rendait l'inspecteur illisible dès 3-4
  // acteurs (cf. point 7 du DIRECTIVES.md, pas encore attaqué en entier).
  // Repliement PROPRE à chaque carte, indépendant de la sélection.
  const [collapsed, setCollapsed] = useState(true)
  const set = (patch: Partial<{
    targetXCm: number | null; targetYCm: number | null; targetZCm: number | null
    fadeMs: number; fadeOverridden: boolean
    startOffsetMs: number; easing: string
    orientationOverridden: boolean
    travelOrientationMode: 'fixed' | 'path' | 'focus'
    travelFixedYawDeg: number
    travelFocusPointId: string | null
    arrivalOrientationMode: 'hold' | 'fixed' | 'focus'
    arrivalFixedYawDeg: number
    arrivalFocusPointId: string | null
    mountPresetId: string | null
  }>) => sidecar.setActivation(cueId, pointId, patch)
  // Toute édition manuelle des champs d'orientation personnalise
  // l'activation (même principe que fadeOverridden pour le fade, mission
  // "global vs sélectif" étendue à l'orientation) — sort de la
  // resynchronisation depuis les défauts du bloc tant qu'elle le reste.
  const setOrientation = (patch: Parameters<typeof set>[0]) => set({ ...patch, orientationOverridden: true })
  const speed = pointSpeedMs(pointId, cueId, blockContext)

  return (
    <div className={`activation-card${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}`} onClick={onSelect}>
      <div className="activation-card-head">
        <button
          className="activation-collapse-toggle"
          title={collapsed ? t('cue.expandCard') : t('cue.collapseCard')}
          onClick={(e) => { e.stopPropagation(); setCollapsed((v) => !v) }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="swatch" style={{ background: point?.color ?? '#666' }} />
        <span className="activation-card-name">{point?.name ?? pointId}</span>
        {collapsed && speed !== null && (() => {
          const [key, color] = speedCategory(speed)
          return (
            <span className="activation-speed-badge" style={{ '--speed-color': color } as React.CSSProperties}
              title={t('cue.actorSpeedHint', { kmh: msToKmh(speed).toFixed(1), label: t(`speed.${key}`) })}>
              {msToKmh(speed).toFixed(1)} km/h
            </span>
          )
        })()}
      </div>
      {/* stopPropagation : cliquer dans un champ ne doit pas basculer la
          sélection de l'acteur portée par la carte entière. */}
      {!collapsed && <div className="activation-grid" onClick={(e) => e.stopPropagation()}>
        <label>{t('cue.x')}
          <NumericInput value={activation.targetXCm === null ? null : activation.targetXCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetXCm: v === null ? null : v * 100 })} />
        </label>
        <label>{t('cue.y')}
          <NumericInput value={activation.targetYCm === null ? null : activation.targetYCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetYCm: v === null ? null : v * 100 })} />
        </label>
        <label>{t('cue.z')}
          <NumericInput value={activation.targetZCm === null ? null : activation.targetZCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetZCm: v === null ? null : v * 100 })} />
        </label>
        <label>{t('cue.fade')}
          <NumericInput value={activation.fadeMs / 1000} step={0.1}
            onCommit={(v) => { if (v !== null && v >= 0) set({ fadeMs: v * 1000, fadeOverridden: true }) }} />
          {activation.fadeOverridden && (
            <button
              className="inspector-revert-fade"
              title={t('cue.revertFadeHint')}
              onClick={() => set({ fadeOverridden: false })}
            >
              {t('cue.revertFade')}
            </button>
          )}
        </label>
        <label>{t('cue.startOffset')}
          <NumericInput value={activation.startOffsetMs / 1000} step={0.05}
            title={t('cue.startOffsetHint')}
            onCommit={(v) => { if (v !== null && v >= 0) set({ startOffsetMs: v * 1000 }) }} />
        </label>
        <label>{t('cue.curve')}
          {(activation.pathPoints?.length || activation.startHandle || activation.targetHandle) ? (
            <button
              className="inspector-clear-path"
              title={t('cue.clearPath')}
              onClick={() => sidecar.setActivation(cueId, pointId, { pathPoints: null, startHandle: null, targetHandle: null })}
            >
              {t('cue.straightPath')}
            </button>
          ) : null}
          <select value={activation.easing} onChange={(e) => set({ easing: e.target.value })}>
            {EASING_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>}
      {!collapsed && <div className="activation-orientation" onClick={(e) => e.stopPropagation()}>
        <div className="activation-orientation-phase">
          <h4>{t('cue.travelPhase')}</h4>
          <OrientationPhaseFields
            phase="travel"
            mode={activation.travelOrientationMode ?? 'fixed'}
            fixedDeg={activation.travelFixedYawDeg ?? 0}
            focusId={activation.travelFocusPointId ?? null}
            points={allPoints}
            onModeChange={(m) => setOrientation({ travelOrientationMode: m as 'fixed' | 'path' | 'focus' })}
            onFixedDegChange={(d) => setOrientation({ travelFixedYawDeg: d })}
            onFocusChange={(id) => setOrientation({ travelFocusPointId: id })}
          />
        </div>
        <div className="activation-orientation-phase">
          <h4>{t('cue.arrivalPhase')}</h4>
          <OrientationPhaseFields
            phase="arrival"
            mode={activation.arrivalOrientationMode ?? 'hold'}
            fixedDeg={activation.arrivalFixedYawDeg ?? 0}
            focusId={activation.arrivalFocusPointId ?? null}
            points={allPoints}
            onModeChange={(m) => setOrientation({ arrivalOrientationMode: m as 'hold' | 'fixed' | 'focus' })}
            onFixedDegChange={(d) => setOrientation({ arrivalFixedYawDeg: d })}
            onFocusChange={(id) => setOrientation({ arrivalFocusPointId: id })}
          />
        </div>
        {/* Preset de montage PAR BLOC (recadrage 2026-08-04) : "Ne rien
            changer" = ce bloc ne touche pas le canal (le preset gouvernant
            précédent continue, LTP) ; "Aucun" = efface la correction. */}
        <div className="activation-orientation-phase">
          <h4>{t('cue.mountPreset')}</h4>
          <label>
            <select
              value={activation.mountPresetId === null || activation.mountPresetId === undefined
                ? '~nochange~'
                : (activation.mountPresetId === '' ? '~none~' : activation.mountPresetId)}
              onChange={(e) => set({
                mountPresetId: e.target.value === '~nochange~' ? null
                  : e.target.value === '~none~' ? '' : e.target.value,
              })}
            >
              <option value="~nochange~">{t('cue.mountPresetNoChange')}</option>
              <option value="~none~">{t('cue.mountPresetNone')}</option>
              {mountPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        {activation.orientationOverridden && (
          <button
            className="inspector-revert-fade"
            title={t('cue.revertOrientationHint')}
            onClick={() => set({ orientationOverridden: false })}
          >
            {t('cue.revertOrientation')}
          </button>
        )}
      </div>}
    </div>
  )
}

export default App
