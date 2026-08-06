// WebSocket client for the Python sidecar (src/lumitrack/sidecar.py).
//
// Backend-autoritaire (CONCEPTION.md §12.11/§13.1.7): this client never
// computes playback time or interpolated positions itself. It only ever
// holds the latest `project` and `tick` snapshots pushed by the sidecar and
// re-renders from them — every edit is sent as a command and only takes
// effect once the sidecar echoes back a fresh `project` snapshot.
import { useSyncExternalStore } from 'react'
import type { BackstageZone, BlockContextMessage, BundleArchiveMessage, FixtureMountPreset, IfacesMessage, Project, PsnPreviewMessage, RosterGroup, ServerMessage, TickMessage, TrajectoriesMessage } from './types'

const SIDECAR_PORT = 17845
const RECONNECT_DELAY_MS = 1000

class SidecarClient {
  project: Project | null = null
  tick: TickMessage | null = null
  blockContext: BlockContextMessage | null = null
  trajectories: TrajectoriesMessage | null = null
  connected = false
  psnRunning = false
  undoAvailable = false
  redoAvailable = false
  lastError: string | null = null
  ifaces: IfacesMessage | null = null
  psnPreview: PsnPreviewMessage | null = null
  bundleArchive: BundleArchiveMessage | null = null
  /** Chemin du fichier .lumitrack courant (format 2026-07-31), une fois
   * ouvert ou sauvegardé une première fois — pilote "Enregistrer" (pas de
   * dialogue) vs "Enregistrer sous…" (dialogue toujours). Posé de façon
   * optimiste dès l'envoi de saveBundle/loadBundle (retour instantané dans
   * l'UI), puis CORRIGÉ à la confirmation "saved" — save_bundle peut
   * rediriger vers un dossier dédié créé automatiquement (voir
   * core/project.py::_ensure_own_folder), le chemin optimiste n'est donc
   * pas garanti être le chemin final. load_bundle, lui, n'a pas de signal
   * de confirmation distinct (juste une rediffusion du projet) : son
   * chemin reste optimiste sans correction ultérieure. */
  bundlePath: string | null = null

  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()

  constructor() {
    this.connect()
  }

  private connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${SIDECAR_PORT}`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.emit()
    }
    ws.onclose = () => {
      this.connected = false
      this.emit()
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS)
    }
    ws.onerror = () => {
      ws.close()
    }
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage
      if (msg.type === 'project') {
        this.project = msg.project
        this.psnRunning = msg.psnRunning
        this.undoAvailable = msg.undoAvailable
        this.redoAvailable = msg.redoAvailable
      } else if (msg.type === 'tick') {
        this.tick = msg
      } else if (msg.type === 'block_context') {
        this.blockContext = msg
      } else if (msg.type === 'trajectories') {
        this.trajectories = msg
      } else if (msg.type === 'ifaces') {
        this.ifaces = msg
      } else if (msg.type === 'psn_preview') {
        this.psnPreview = msg
      } else if (msg.type === 'bundle_archive') {
        this.bundleArchive = msg
      } else if (msg.type === 'saved') {
        // save_bundle peut CORRIGER le chemin demandé (dossier dédié
        // inséré si l'utilisateur n'avait pas déjà navigué dans un dossier
        // à ce nom) — le chemin "courant" retenu doit être celui réellement
        // écrit, pas l'écho optimiste posé au moment de l'appel.
        this.bundlePath = msg.path
      } else if (msg.type === 'error') {
        this.lastError = msg.message
        console.error('[sidecar]', msg.message)
      } else {
        // 'ack': no exposed state changed, skip the re-render.
        return
      }
      this.emit()
    }
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  send(message: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  // ---- transport ----
  play() { this.send({ type: 'transport', action: 'play' }) }
  pause() { this.send({ type: 'transport', action: 'pause' }) }
  seek(tMs: number) { this.send({ type: 'transport', action: 'seek', tMs }) }

  // ---- undo/redo (§13.1.10, backend-autoritaire) : le sidecar seul garde
  // l'historique, ces méthodes n'envoient qu'une intention. ----
  undo() { this.send({ type: 'undo' }) }
  redo() { this.send({ type: 'redo' }) }

  // ---- PSN (§12.9: stays independent of edit vs. playback mode) ----
  psnStart() { this.send({ type: 'psn_start' }) }
  psnStop() { this.send({ type: 'psn_stop' }) }
  updatePsnConfig(patch: {
    mcastIp?: string; port?: number; systemName?: string
    ifaceIp?: string; rateHz?: number
    originXCm?: number; originYCm?: number
    invertX?: boolean; invertY?: boolean; swapXy?: boolean
    upAxis?: 'y' | 'z'
  }) {
    this.send({ type: 'update_psn_config', ...patch })
  }
  listIfaces() { this.send({ type: 'list_ifaces' }) }
  requestPsnPreview() { this.send({ type: 'psn_preview' }) }
  updatePoint(pointId: string, patch: {
    name?: string; number?: number | null; color?: string
    psnTrackerId?: number | null; defaultHeightCm?: number
    homeZoneId?: string | null; rosterGroupId?: string | null
    defaultTravelOrientationMode?: 'fixed' | 'path' | 'focus'
    isFocusPoint?: boolean
    isFocusTarget?: boolean
  }) {
    this.send({ type: 'update_point', pointId, ...patch })
  }

  // ---- editing ----
  addPoint(name: string, number?: number, rosterGroupId?: string | null, color?: string, id?: string) {
    this.send({ type: 'add_point', name, number, rosterGroupId, color, id })
  }
  /** Simple repère de visée, pas un acteur réel — bouton dédié plutôt que
   * le panneau d'ajout en lot (numéroté), qui ne s'applique pas ici : un
   * point de focus n'entre jamais dans le compteur numérique des acteurs
   * (mission "modes d'orientation", 2026-08-04). */
  addFocusPoint(name: string, color: string, id: string) {
    this.send({ type: 'add_point', name, color, id, isFocusPoint: true })
  }
  /** Jamais possible avant la mission "hiérarchie du roster" (2026-07-31) :
   * le roster ne savait qu'ajouter. */
  deletePoint(pointId: string) {
    this.send({ type: 'delete_point', pointId })
  }
  /** Nouvel ordre complet de project.points (glisser-déposer/réassignation
   * de sous-groupe dans le roster). */
  reorderPoints(pointIds: string[]) {
    this.send({ type: 'reorder_points', pointIds })
  }
  /** État complet des sous-groupes du roster (création/renommage/
   * suppression) — même principe que setBackstageZones. */
  setRosterGroups(groups: RosterGroup[]) {
    this.send({ type: 'set_roster_groups', groups })
  }
  /** Catalogue complet des presets de montage de fixture (mission "modes
   * d'orientation", phase D, 2026-08-04) — même principe que
   * setRosterGroups/setBackstageZones. */
  setFixtureMountPresets(presets: FixtureMountPreset[]) {
    this.send({ type: 'set_fixture_mount_presets', presets })
  }
  updateStageMap(patch: { originXM?: number; originZM?: number; rotationDeg?: number; widthCm?: number; heightCm?: number; gridSizeCm?: number; terrainRotationDeg?: number }) {
    this.send({ type: 'update_stage_map', ...patch })
  }
  /** Réglages projet transverses (pour l'instant : vitesse de référence des
   * blocs en "durée automatique", cm/s). */
  updateProjectSettings(patch: {
    referenceSpeedCms?: number; actorDiameterCm?: number
    gridOpacity?: number; gridShade?: number; snapToGrid?: boolean
    terrainGltfPath?: string | null
  }) {
    this.send({ type: 'update_project_settings', ...patch })
  }
  addCue(name: string, startMs: number, durationMs: number, color?: string, lane?: number, id?: string) {
    this.send({ type: 'add_cue', name, startMs, durationMs, color, lane, id })
  }
  /** État complet des zones backstage (création/édition/suppression). */
  setBackstageZones(zones: BackstageZone[]) {
    this.send({ type: 'set_backstage_zones', zones })
  }
  updateCue(cueId: string, patch: {
    name?: string; startMs?: number; durationMs?: number; color?: string; lane?: number; autoDuration?: boolean
    defaultTravelOrientationMode?: 'fixed' | 'path' | 'focus' | null
    defaultTravelFixedYawDeg?: number | null
    defaultTravelFocusPointId?: string | null
    defaultArrivalOrientationMode?: 'hold' | 'fixed' | 'focus' | null
    defaultArrivalFixedYawDeg?: number | null
    defaultArrivalFocusPointId?: string | null
    defaultMountPresetId?: string | null
    defaultYawTurnMs?: number | null
  }) {
    this.send({ type: 'update_cue', cueId, ...patch })
  }
  deleteCue(cueId: string) {
    this.send({ type: 'delete_cue', cueId })
  }
  // null sur un axe = le "détoucher" : le sidecar écrit None et l'axe
  // repasse en tracking (§12.1). undefined = champ non modifié.
  // `curves`: dict {axe: nœuds} fusionné par le backend — un axe portant
  // [] est retiré (retour à l'easing nommé), null efface tout.
  /** Écriture GROUPÉE de plusieurs activations d'un même bloc en UN
   * message (optimisation 2026-08-06) : un geste multi-acteurs envoyait N
   * set_activation par échantillon et le backend rediffusait le projet
   * entier N fois — d'où "le déplacement de plusieurs points fait ramer".
   * Une entrée = { pointId, ...patch de setActivation }. */
  setActivations(cueId: string, entries: Array<Record<string, unknown> & { pointId: string }>) {
    if (entries.length === 0) return
    this.send({ type: 'set_activations', cueId, entries })
  }
  setActivation(cueId: string, pointId: string, patch: {
    targetXCm?: number | null; targetYCm?: number | null
    targetZCm?: number | null
    fadeMs?: number; fadeOverridden?: boolean; startOffsetMs?: number; easing?: string
    orientationOverridden?: boolean
    travelOrientationMode?: 'fixed' | 'path' | 'focus'
    travelFixedYawDeg?: number
    travelFocusPointId?: string | null
    arrivalOrientationMode?: 'hold' | 'fixed' | 'focus'
    arrivalFixedYawDeg?: number
    arrivalFocusPointId?: string | null
    /** null = "ne rien changer", '' = "aucun preset", sinon id de preset. */
    mountPresetId?: string | null
    yawTurnMs?: number
    curves?: Partial<Record<'x' | 'y' | 'z', unknown[]>> | null
    pathPoints?: unknown[] | null
    startHandle?: { dxCm: number; dyCm: number } | null
    targetHandle?: { dxCm: number; dyCm: number } | null
  }) {
    this.send({ type: 'set_activation', cueId, pointId, ...patch })
  }
  // Piste audio : `path` charge/retire le fichier, `durationS` est envoyé
  // par le frontend une fois le fichier décodé — le backend intègre la
  // durée au transport (duration = max(cues, audio)) mais ne décode rien.
  setAudio(patch: { path?: string | null; durationS?: number | null }) {
    this.send({ type: 'set_audio', ...patch })
  }
  // Block-edit context (§12.6). Requested again after every fresh
  // `project` snapshot while a cue is selected (see App.tsx), so the
  // displayed trajectories always describe the current project state —
  // resolution itself stays entirely backend-side (§13.1.7).
  resolveBlockContext(cueId: string) {
    this.send({ type: 'resolve_block_context', cueId })
  }
  clearBlockContext() {
    if (this.blockContext === null) return
    this.blockContext = null
    this.emit()
  }
  // Overlay de trajectoire à la sélection — même principe que
  // resolveBlockContext : redemandé à chaque changement de sélection ET de
  // snapshot projet (voir App.tsx).
  resolveTrajectories(pointIds: string[]) {
    this.send({ type: 'resolve_trajectories', pointIds })
  }
  clearTrajectories() {
    if (this.trajectories === null) return
    this.trajectories = null
    this.emit()
  }
  applyGroupTransform(cueId: string, pointIds: string[], opts: {
    pivot?: [number, number]; translate?: [number, number]; rotateDeg?: number
    fadeMs?: number; easing?: string
  }) {
    this.send({ type: 'apply_group_transform', cueId, pointIds, ...opts })
  }

  // ---- project lifecycle ----
  newProject(name = 'Untitled') {
    this.bundlePath = null
    this.send({ type: 'new_project', name })
  }
  importStancz(path: string) {
    this.bundlePath = null
    this.send({ type: 'import_stancz', path })
  }
  saveBundle(path: string) {
    this.bundlePath = path
    this.emit()
    this.send({ type: 'save_bundle', path })
  }
  loadBundle(path: string, archivedName?: string) {
    // Restaurer une version archivée ne change PAS le fichier courant :
    // le prochain "Enregistrer" écrase toujours le .lumitrack principal
    // (en archivant d'abord ce qu'il contenait), pas l'entrée d'archive lue.
    // Un chemin qui n'est PAS un .lumitrack (dossier d'ancien format
    // ouvert en lecture seule) n'est pas non plus retenu comme "courant" :
    // le prochain Enregistrer redevient un Enregistrer sous, pour ne
    // jamais mélanger nouveau et ancien format dans le même dossier.
    if (archivedName === undefined && path.toLowerCase().endsWith('.lumitrack')) {
      this.bundlePath = path
      this.emit()
    }
    this.send({ type: 'load_bundle', path, archivedName })
  }
  listBundleArchive(path: string) { this.send({ type: 'list_bundle_archive', path }) }
}

export const sidecar = new SidecarClient()

export function useProject(): Project | null {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.project)
}

export function useTick(): TickMessage | null {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.tick)
}

export function useBlockContext(): BlockContextMessage | null {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.blockContext)
}

export function useTrajectories(): TrajectoriesMessage | null {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.trajectories)
}

export function useConnected(): boolean {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.connected)
}

export function useIfaces(): IfacesMessage | null {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.ifaces)
}

export function usePsnPreview(): PsnPreviewMessage | null {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.psnPreview)
}

export function usePsnRunning(): boolean {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.psnRunning)
}

export function useUndoAvailable(): boolean {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.undoAvailable)
}

export function useBundlePath(): string | null {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.bundlePath)
}

export function useBundleArchive(): BundleArchiveMessage | null {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.bundleArchive)
}

export function useRedoAvailable(): boolean {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.redoAvailable)
}
