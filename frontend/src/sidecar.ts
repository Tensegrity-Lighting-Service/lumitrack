// WebSocket client for the Python sidecar (src/lumitrack/sidecar.py).
//
// Backend-autoritaire (CONCEPTION.md §12.11/§13.1.7): this client never
// computes playback time or interpolated positions itself. It only ever
// holds the latest `project` and `tick` snapshots pushed by the sidecar and
// re-renders from them — every edit is sent as a command and only takes
// effect once the sidecar echoes back a fresh `project` snapshot.
import { useSyncExternalStore } from 'react'
import type { Project, ServerMessage, TickMessage } from './types'

const SIDECAR_PORT = 17845
const RECONNECT_DELAY_MS = 1000

class SidecarClient {
  project: Project | null = null
  tick: TickMessage | null = null
  connected = false
  psnRunning = false
  lastError: string | null = null

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
      } else if (msg.type === 'error') {
        this.lastError = msg.message
        console.error('[sidecar]', msg.message)
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

  // ---- editing ----
  addPoint(name: string, number?: number) {
    this.send({ type: 'add_point', name, number })
  }
  addCue(name: string, startMs: number, durationMs: number) {
    this.send({ type: 'add_cue', name, startMs, durationMs })
  }
  updateCue(cueId: string, patch: { name?: string; startMs?: number; durationMs?: number }) {
    this.send({ type: 'update_cue', cueId, ...patch })
  }
  deleteCue(cueId: string) {
    this.send({ type: 'delete_cue', cueId })
  }
  setActivation(cueId: string, pointId: string, patch: {
    targetXCm?: number; targetYCm?: number; targetZCm?: number; targetYawDeg?: number
    fadeMs?: number; easing?: string
  }) {
    this.send({ type: 'set_activation', cueId, pointId, ...patch })
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

export function useConnected(): boolean {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.connected)
}

export function usePsnRunning(): boolean {
  return useSyncExternalStore(sidecar.subscribe, () => sidecar.psnRunning)
}
