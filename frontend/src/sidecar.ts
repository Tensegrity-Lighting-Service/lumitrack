// WebSocket client for the Python sidecar (src/lumitrack/sidecar.py).
//
// Backend-autoritaire (CONCEPTION.md §12.11/§13.1.7): this client never
// computes playback time or interpolated positions itself. It only ever
// holds the latest `project` and `tick` snapshots pushed by the sidecar and
// re-renders from them — every edit is sent as a command and only takes
// effect once the sidecar echoes back a fresh `project` snapshot.
import { useSyncExternalStore } from 'react'
import type { BackstageZone, BlockContextMessage, IfacesMessage, Project, PsnPreviewMessage, ServerMessage, TickMessage } from './types'

const SIDECAR_PORT = 17845
const RECONNECT_DELAY_MS = 1000

class SidecarClient {
  project: Project | null = null
  tick: TickMessage | null = null
  blockContext: BlockContextMessage | null = null
  connected = false
  psnRunning = false
  lastError: string | null = null
  ifaces: IfacesMessage | null = null
  psnPreview: PsnPreviewMessage | null = null

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
      } else if (msg.type === 'tick') {
        this.tick = msg
      } else if (msg.type === 'block_context') {
        this.blockContext = msg
      } else if (msg.type === 'ifaces') {
        this.ifaces = msg
      } else if (msg.type === 'psn_preview') {
        this.psnPreview = msg
      } else if (msg.type === 'error') {
        this.lastError = msg.message
        console.error('[sidecar]', msg.message)
      } else {
        // 'ack' / 'saved': no exposed state changed, skip the re-render.
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
    homeZoneId?: string | null
  }) {
    this.send({ type: 'update_point', pointId, ...patch })
  }

  // ---- editing ----
  addPoint(name: string, number?: number) {
    this.send({ type: 'add_point', name, number })
  }
  updateStageMap(patch: { originXM?: number; originZM?: number; rotationDeg?: number; widthCm?: number; heightCm?: number; gridSizeCm?: number; terrainRotationDeg?: number }) {
    this.send({ type: 'update_stage_map', ...patch })
  }
  addCue(name: string, startMs: number, durationMs: number, color?: string, lane?: number, id?: string) {
    this.send({ type: 'add_cue', name, startMs, durationMs, color, lane, id })
  }
  /** État complet des zones backstage (création/édition/suppression). */
  setBackstageZones(zones: BackstageZone[]) {
    this.send({ type: 'set_backstage_zones', zones })
  }
  updateCue(cueId: string, patch: { name?: string; startMs?: number; durationMs?: number; color?: string; lane?: number }) {
    this.send({ type: 'update_cue', cueId, ...patch })
  }
  deleteCue(cueId: string) {
    this.send({ type: 'delete_cue', cueId })
  }
  // null sur un axe = le "détoucher" : le sidecar écrit None et l'axe
  // repasse en tracking (§12.1). undefined = champ non modifié.
  // `curves`: dict {axe: nœuds} fusionné par le backend — un axe portant
  // [] est retiré (retour à l'easing nommé), null efface tout.
  setActivation(cueId: string, pointId: string, patch: {
    targetXCm?: number | null; targetYCm?: number | null
    targetZCm?: number | null; targetYawDeg?: number | null
    fadeMs?: number; easing?: string
    curves?: Partial<Record<'x' | 'y' | 'z' | 'yaw', unknown[]>> | null
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
  applyGroupTransform(cueId: string, pointIds: string[], opts: {
    pivot?: [number, number]; translate?: [number, number]; rotateDeg?: number
    fadeMs?: number; easing?: string
  }) {
    this.send({ type: 'apply_group_transform', cueId, pointIds, ...opts })
  }

  // ---- project lifecycle ----
  newProject(name = 'Untitled') { this.send({ type: 'new_project', name }) }
  importStancz(path: string) { this.send({ type: 'import_stancz', path }) }
  saveBundle(path: string) { this.send({ type: 'save_bundle', path }) }
  loadBundle(path: string, version?: number) { this.send({ type: 'load_bundle', path, version }) }
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
