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

        <details className="settings-section" open>
          <summary>{t('psn.mountPresetsTitle')}</summary>
        <section>
          <table className="psn-table">
            <thead>
              <tr>
                <th>{t('psn.mountPresetName')}</th>
                <th>{t('psn.mountPresetPitch')}</th>
                <th>{t('psn.mountPresetTracksYaw')}</th>
                <th>{t('psn.mountPresetRoll')}</th>
                <th>{t('psn.mountPresetTracksYaw')}</th>
                <th>{t('psn.mountPresetHeight')}</th>
                <th>{t('psn.mountPresetYawOffset')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {project.fixtureMountPresets.map((preset) => {
                const update = (patch: Partial<typeof preset>) => sidecar.setFixtureMountPresets(
                  project.fixtureMountPresets.map((p) => (p.id === preset.id ? { ...p, ...patch } : p)))
                return (
                  <tr key={preset.id}>
                    <td>
                      <input
                        value={preset.name}
                        onChange={(e) => update({ name: e.target.value })}
                      />
                    </td>
                    <td>
                      <NumericInput value={preset.basePitchDeg} step={5}
                        onCommit={(v) => update({ basePitchDeg: v ?? 0 })} />
                    </td>
                    <td>
                      <input type="checkbox" checked={preset.pitchTracksYaw}
                        onChange={(e) => update({ pitchTracksYaw: e.target.checked })} />
                    </td>
                    <td>
                      <NumericInput value={preset.baseRollDeg} step={5}
                        onCommit={(v) => update({ baseRollDeg: v ?? 0 })} />
                    </td>
                    <td>
                      <input type="checkbox" checked={preset.rollTracksYaw}
                        onChange={(e) => update({ rollTracksYaw: e.target.checked })} />
                    </td>
                    <td>
                      {/* Saisi en mètres (comme la hauteur de l'inspecteur
                          acteur), stocké en cm scène. */}
                      <NumericInput value={(preset.zOffsetCm ?? 0) / 100} step={0.1}
                        onCommit={(v) => update({ zOffsetCm: (v ?? 0) * 100 })} />
                    </td>
                    <td>
                      {/* Offset rY additif sur le lacet du plan (2026-08-06,
                          "que les tubes tournent dans le bon sens"). */}
                      <NumericInput value={preset.yawOffsetDeg ?? 0} step={90}
                        onCommit={(v) => update({ yawOffsetDeg: v ?? 0 })} />
                    </td>
                    <td>
                      <button
                        className="psn-preset-delete"
                        title={t('psn.mountPresetDelete')}
                        onClick={() => sidecar.setFixtureMountPresets(
                          project.fixtureMountPresets.filter((p) => p.id !== preset.id))}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <button
            onClick={() => sidecar.setFixtureMountPresets([
              ...project.fixtureMountPresets,
              {
                id: crypto.randomUUID(), name: t('psn.mountPresetDefaultName'),
                basePitchDeg: 0, baseRollDeg: 0, pitchTracksYaw: false, rollTracksYaw: false,
                zOffsetCm: 0, yawOffsetDeg: 0,
              },
            ])}
          >
            {t('psn.mountPresetAdd')}
          </button>
          <p className="psn-note">{t('psn.mountPresetsNote')}</p>
        </section>
        </details>

        <details className="settings-section" open>
          <summary>{t('psn.sectionTimecode')}</summary>
        <section>
          {/* Timecode In Art-Net uniquement (arbitrage 2026-08-06) : le LTC/
              MTC se convertit avec Super Timecode Converter en amont. */}
          <label className="psn-check">
            <input type="checkbox" checked={project.timecodeChaseEnabled}
              onChange={(e) => sidecar.setTimecodeChase(e.target.checked)} />
            {t('psn.timecodeEnable')}
          </label>
          <label>{t('psn.networkInterface')}
            <select
              value={project.timecodeIfaceIp ?? '0.0.0.0'}
              onChange={(e) => sidecar.setTimecodeChase(undefined, e.target.value)}
            >
              {!addresses.includes(project.timecodeIfaceIp) && (
                <option value={project.timecodeIfaceIp}>{project.timecodeIfaceIp}</option>
              )}
              {addresses.map((a) => (
                <option key={a} value={a}>{a === '0.0.0.0' ? t('psn.networkAuto') : a}</option>
              ))}
            </select>
          </label>
          <label>{t('menu.settings.timecodeOffset')}
            <NumericInput value={Math.round((project.timecodeOffsetMs ?? 0) / 100) / 10} step={0.5}
              onCommit={(v) => { if (v !== null) sidecar.updateProjectSettings({ timecodeOffsetMs: v * 1000 }) }} />
          </label>
          <p className="psn-note">{t('psn.timecodeNote')}</p>
        </section>
        </details>

        <details className="settings-section" open>
          <summary>{t('psn.sectionPsn')}</summary>
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
            {/* Offset GLOBAL de sortie (2026-08-06, "descendre les astera
                de 12 m") : additif, indépendant des presets, appliqué en
                tout dernier. Z = hauteur. */}
            <h3>{t('psn.outputOffsetTitle')}</h3>
            <div className="psn-grid2">
              <label>{t('psn.outputOffsetX')}
                <NumericInput value={project.outputOffsetXM ?? 0} step={0.1}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ outputOffsetXM: v }) }} />
              </label>
              <label>{t('psn.outputOffsetY')}
                <NumericInput value={project.outputOffsetYM ?? 0} step={0.1}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ outputOffsetYM: v }) }} />
              </label>
              <label>{t('psn.outputOffsetZ')}
                <NumericInput value={project.outputOffsetZM ?? 0} step={0.5}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ outputOffsetZM: v }) }} />
              </label>
              <label>{t('psn.outputRotation')}
                <NumericInput value={project.outputRotationDeg ?? 0} step={15}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ outputRotationDeg: v }) }} />
              </label>
              {/* Offsets d'ORIENTATION globaux (2026-08-06) : degrés ajoutés
                  aux axes ori ÉMIS — fin de la chaîne additive
                  lacet résolu → preset (rX/rZ + offset rY) → global. */}
              <label>{t('psn.outputOriX')}
                <NumericInput value={project.outputOriXDeg ?? 0} step={15}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ outputOriXDeg: v }) }} />
              </label>
              <label>{t('psn.outputOriY')}
                <NumericInput value={project.outputOriYDeg ?? 0} step={15}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ outputOriYDeg: v }) }} />
              </label>
              <label>{t('psn.outputOriZ')}
                <NumericInput value={project.outputOriZDeg ?? 0} step={15}
                  onCommit={(v) => { if (v !== null) sidecar.updatePsnConfig({ outputOriZDeg: v }) }} />
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
        </details>

        <details className="settings-section" open>
          <summary>{t('psn.trackers')}</summary>
        <section>
          <div className="psn-scroll"><table className="psn-table">
            <thead>
              <tr>
                <th>{t('psn.tableActor')}</th><th>{t('psn.tableNumber')}</th>
                <th>{t('psn.tablePsnId')}</th><th>{t('psn.tableEmittedId')}</th>
              </tr>
            </thead>
            <tbody>
              {/* Tri par ID ÉMIS, pas par ordre du roster (fix 2026-08-04,
                  "les acteurs des groupes ont disparu de la liste") : ranger
                  un groupe dans le roster réordonne project.points, et les
                  acteurs groupés se retrouvaient relégués en fin de tableau
                  — l'ID émis, lui, est stable (number/psnTrackerId). */}
              {/* Les points de focus ne sont JAMAIS émis (engine.py saute
                  is_focus_point) — les lister ici avec un ID de repli
                  laissait croire à une collision avec un vrai acteur
                  (question de Florian, 2026-08-06). L'index de repli reste
                  calculé sur la liste COMPLÈTE, comme côté backend. */}
              {project.points
                .map((pt, index) => ({ pt, resolved: pt.psnTrackerId ?? pt.number ?? index }))
                .filter(({ pt }) => !pt.isFocusPoint)
                .sort((a, b) => a.resolved - b.resolved)
                .map(({ pt, resolved }) => {
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
          </table></div>
          <p className="psn-note">{t('psn.trackersNote')}</p>
        </section>
        </details>

        <details className="settings-section" open>
          <summary>{t('psn.monitor')} {preview ? t('psn.monitorRateSuffix', { rateHz: preview.rateHz }) : ''}</summary>
        <section>
          <div className="psn-scroll"><table className="psn-table psn-mono">
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
              {/* Même tri stable par ID que le tableau des trackers. */}
              {[...(preview?.trackers ?? [])].sort((a, b) => a.id - b.id).map((trk) => (
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
          </table></div>
        </section>
        </details>

      </div>
    </div>
  )
}
