// Panneau « Réglages PSN » (mission 2026-07-29) : tout ce qui concerne la
// sortie PosiStageNet en un seul endroit — réseau (interface, multicast,
// port, fréquence), repère de sortie (origine, inversions, swap, AXE
// VERTICAL), assignation des trackers par acteur, et moniteur live des
// données réellement émises (via psn_preview : le même build_trackers que
// le broadcaster, donc ce qui s'affiche EST ce qui part sur le réseau).
//
// Convention d'axes : la spec officielle 2.03 (p.8) impose « positive x is
// right, positive y is up, positive z is depth » — Y vertical (Capture la
// suit ; MA Lighting est co-auteur de la spec). Le choix Z vertical reste
// disponible pour les outils qui dévient.
import { useEffect, useState } from 'react'
import { sidecar, useIfaces, usePsnPreview, usePsnRunning } from '../sidecar'
import type { Project } from '../types'
import { NumericInput } from './NumericInput'
import { useT } from '../i18n'

const PREVIEW_POLL_MS = 500

export function PsnPanel({ project, onClose }: {
  project: Project
  onClose: () => void
}) {
  const t = useT()
  const running = usePsnRunning()
  const ifaces = useIfaces()
  const preview = usePsnPreview()
  const [mcastIp, setMcastIp] = useState(project.psnMcastIp)
  const [systemName, setSystemName] = useState(project.psnSystemName)

  // Interfaces au montage, moniteur en continu tant que le panneau est là.
  useEffect(() => {
    sidecar.listIfaces()
    sidecar.requestPsnPreview()
    const timer = setInterval(() => sidecar.requestPsnPreview(), PREVIEW_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => { setMcastIp(project.psnMcastIp) }, [project.psnMcastIp])
  useEffect(() => { setSystemName(project.psnSystemName) }, [project.psnSystemName])

  const addresses = ifaces?.addresses ?? ['0.0.0.0']
  const fmt = (v: number) => v.toFixed(3)

  // L'app n'émet plus qu'en convention OFFICIELLE (spec 2.03 : Y vertical).
  // Un vieux projet resté en "z" est ramené à "y" silencieusement.
  useEffect(() => {
    if (project.transformUpAxis === 'z') sidecar.updatePsnConfig({ upAxis: 'y' })
  }, [project.transformUpAxis])

  return (
    <div className="psn-overlay" onClick={onClose}>
      <div className="psn-panel" onClick={(e) => e.stopPropagation()}>
        <div className="psn-head">
          <h2>{t('psn.title')}</h2>
          <span className={`conn-dot ${running ? 'conn-ok' : 'conn-bad'}`} />
          <span className="psn-status">
            {running ? t('psn.statusEmitting', { dest: preview?.dest ?? '…' }) : t('psn.statusStopped')}
            {preview && running ? t('psn.statusPacketCount', { count: preview.packetsSent }) : ''}
          </span>
          <span className="psn-head-spacer" />
          <button onClick={() => (running ? sidecar.psnStop() : sidecar.psnStart())}>
            {running ? t('psn.stop') : t('psn.start')}
          </button>
          <button onClick={onClose} title={t('psn.close')}>✕</button>
        </div>
        {preview?.lastError && <p className="psn-error">{t('psn.socketError', { error: preview.lastError })}</p>}

        <div className="psn-columns">
          <section>
            <h3>{t('psn.network')}</h3>
            <label>{t('psn.networkInterface')}
              <select
                value={project.psnIfaceIp ?? '0.0.0.0'}
                onChange={(e) => sidecar.updatePsnConfig({ ifaceIp: e.target.value })}
              >
                {!addresses.includes(project.psnIfaceIp) && (
                  <option value={project.psnIfaceIp}>{project.psnIfaceIp}</option>
                )}
                {addresses.map((a) => (
                  <option key={a} value={a}>{a === '0.0.0.0' ? t('psn.networkAuto') : a}</option>
                ))}
              </select>
            </label>
            <label>{t('psn.multicastAddress')}
              <input
                value={mcastIp}
                onChange={(e) => setMcastIp(e.target.value)}
                onBlur={() => { if (mcastIp !== project.psnMcastIp) sidecar.updatePsnConfig({ mcastIp }) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </label>
            <label>{t('psn.port')}
              <NumericInput value={project.psnPort} step={1}
                onCommit={(v) => { if (v !== null && v > 0 && v < 65536) sidecar.updatePsnConfig({ port: v }) }} />
            </label>
            <label>{t('psn.systemName')}
              <input
                value={systemName}
                onChange={(e) => setSystemName(e.target.value)}
                onBlur={() => { if (systemName !== project.psnSystemName) sidecar.updatePsnConfig({ systemName }) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </label>
            <label>{t('psn.rate')}
              <NumericInput value={project.psnRateHz ?? 30} step={1}
                onCommit={(v) => { if (v !== null && v >= 1 && v <= 120) sidecar.updatePsnConfig({ rateHz: v }) }} />
            </label>
          </section>

          <section>
            <h3>{t('psn.outputFrame')}</h3>
            <p className="psn-note">{t('psn.outputFrameNote')}</p>
            <div className="psn-grid2">
              <label>{t('psn.originX')}
                <NumericInput value={project.transformOriginXCm / 100} step={0.1}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ originXCm: v * 100 }) }} />
              </label>
              <label>{t('psn.originY')}
                <NumericInput value={project.transformOriginYCm / 100} step={0.1}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ originYCm: v * 100 }) }} />
              </label>
            </div>
            <div className="psn-checks">
              <label className="psn-check">
                <input type="checkbox" checked={project.transformInvertX}
                  onChange={(e) => sidecar.updatePsnConfig({ invertX: e.target.checked })} />
                {t('psn.invertX')}
              </label>
              <label className="psn-check">
                <input type="checkbox" checked={project.transformInvertY}
                  onChange={(e) => sidecar.updatePsnConfig({ invertY: e.target.checked })} />
                {t('psn.invertY')}
              </label>
              <label className="psn-check">
                <input type="checkbox" checked={project.transformSwapXy}
                  onChange={(e) => sidecar.updatePsnConfig({ swapXy: e.target.checked })} />
                {t('psn.swapXy')}
              </label>
            </div>
          </section>
        </div>

        <section>
          <h3>{t('psn.trackers')}</h3>
          <table className="psn-table">
            <thead>
              <tr><th>{t('psn.tableActor')}</th><th>{t('psn.tableNumber')}</th><th>{t('psn.tablePsnId')}</th><th>{t('psn.tableEmittedId')}</th></tr>
            </thead>
            <tbody>
              {project.points.map((pt, index) => {
                const resolved = pt.psnTrackerId ?? pt.number ?? index
                return (
                  <tr key={pt.id}>
                    <td>
                      <span className="swatch" style={{ background: pt.color }} />
                      {pt.name}
                    </td>
                    <td>{pt.number ?? '—'}</td>
                    <td>
                      <NumericInput value={pt.psnTrackerId} step={1} nullable
                        onCommit={(v) => sidecar.updatePoint(pt.id, { psnTrackerId: v })} />
                    </td>
                    <td className="psn-mono">{resolved}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="psn-note">{t('psn.trackersNote')}</p>
        </section>

        <section>
          <h3>{t('psn.monitor')} {preview ? t('psn.monitorRateSuffix', { rateHz: preview.rateHz }) : ''}</h3>
          <table className="psn-table psn-mono">
            <thead>
              <tr>
                <th>ID</th><th>{t('inspector.name')}</th>
                <th>pos_x</th>
                <th className="psn-up">pos_y ↑</th>
                <th>pos_z</th>
                <th>ori (rad)</th>
              </tr>
            </thead>
            <tbody>
              {(preview?.trackers ?? []).map((trk) => (
                <tr key={trk.id}>
                  <td>{trk.id}</td>
                  <td>{trk.name}</td>
                  <td>{fmt(trk.posX)}</td>
                  <td className="psn-up">{fmt(trk.posY)}</td>
                  <td>{fmt(trk.posZ)}</td>
                  <td>{fmt(trk.oriX)}, {fmt(trk.oriY)}, {fmt(trk.oriZ)}</td>
                </tr>
              ))}
              {preview && preview.trackers.length === 0 && (
                <tr><td colSpan={6} className="psn-note">{t('psn.monitorEmpty')}</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
