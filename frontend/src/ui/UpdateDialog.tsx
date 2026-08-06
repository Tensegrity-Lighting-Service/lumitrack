// Vérification de mise à jour au démarrage (2026-08-06, repo public) :
// tauri-plugin-updater lit latest.json sur la release GitHub la plus
// récente, compare à la version installée, et vérifie la SIGNATURE du
// binaire (clé minisign — personne ne peut pousser un faux installateur
// aux utilisateurs, même avec la main sur le repo). Trois choix : mettre
// à jour maintenant (téléchargement + installation + relance), plus tard
// (au prochain démarrage), ou ouvrir la page de la release. Hors Tauri
// (dev navigateur) ou hors ligne : silencieux, l'app démarre normalement.
import { useEffect, useState } from 'react'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useT } from '../i18n'

const RELEASES_URL = 'https://github.com/Tensegrity-Lighting-Service/lumitrack/releases/latest'

export function UpdateDialog() {
  const t = useT()
  const [update, setUpdate] = useState<Update | null>(null)
  const [state, setState] = useState<'idle' | 'downloading' | 'error'>('idle')
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let cancelled = false
    // Différé de quelques secondes : le démarrage (splash, connexion au
    // sidecar) garde la priorité, la vérification réseau vient après.
    const timer = window.setTimeout(() => {
      check().then((u) => { if (!cancelled && u) setUpdate(u) })
        .catch(() => { /* hors Tauri, hors ligne, pas de latest.json : silencieux */ })
    }, 4000)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [])

  if (!update) return null

  const install = async () => {
    setState('downloading')
    try {
      let total = 0
      let received = 0
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0
        else if (event.event === 'Progress') {
          received += event.data.chunkLength
          if (total > 0) setProgress(Math.min(100, Math.round((received / total) * 100)))
        }
      })
      await relaunch()
    } catch {
      setState('error')
    }
  }

  return (
    <div className="update-overlay">
      <div className="update-dialog">
        <h3>{t('update.title', { version: update.version })}</h3>
        {update.body && <p className="update-notes">{update.body.slice(0, 400)}</p>}
        {state === 'downloading' ? (
          <div className="update-progress">
            <div className="update-progress-bar"><div style={{ width: `${progress}%` }} /></div>
            <span>{t('update.downloading', { pct: progress })}</span>
          </div>
        ) : (
          <div className="update-actions">
            <button className="update-primary" onClick={install}>{t('update.installNow')}</button>
            <button onClick={() => setUpdate(null)}>{t('update.later')}</button>
            <button onClick={() => { openUrl(RELEASES_URL).catch(() => {}) }}>{t('update.viewPage')}</button>
          </div>
        )}
        {state === 'error' && <p className="update-error">{t('update.error')}</p>}
      </div>
    </div>
  )
}
