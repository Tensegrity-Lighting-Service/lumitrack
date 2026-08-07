// Vérification de mise à jour (2026-08-06, canaux stable/bêta 2026-08-07) :
// le canal est un réglage MACHINE (localStorage, pas le projet), et le
// check passe par les commandes Rust check_update_channel /
// install_update_channel qui construisent l'updater avec l'endpoint du
// canal — les endpoints statiques de tauri.conf.json ne servent plus au
// flux normal. La signature minisign du binaire reste vérifiée par le
// plugin dans les deux canaux (même clé). Trois choix : mettre à jour
// maintenant (progression via l'événement update-progress, l'installateur
// NSIS relance), plus tard, ou ouvrir la page. Hors Tauri/hors ligne :
// silencieux. « Vérifier maintenant » (Réglages généraux) déclenche le
// même flux via l'événement DOM lumitrack-check-update.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { relaunch } from '@tauri-apps/plugin-process'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useT } from '../i18n'

const RELEASES_URL = 'https://github.com/Tensegrity-Lighting-Service/lumitrack/releases'

export type UpdateChannel = 'stable' | 'beta'

export function getUpdateChannel(): UpdateChannel {
  return localStorage.getItem('lumitrack.updateChannel') === 'beta' ? 'beta' : 'stable'
}

export function setUpdateChannel(channel: UpdateChannel) {
  localStorage.setItem('lumitrack.updateChannel', channel)
}

/** Déclenche une vérification manuelle (bouton des Réglages généraux). */
export function requestUpdateCheck() {
  window.dispatchEvent(new CustomEvent('lumitrack-check-update'))
}

interface UpdateInfo { version: string; body: string | null }

export function UpdateDialog() {
  const t = useT()
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [state, setState] = useState<'idle' | 'downloading' | 'error' | 'uptodate'>('idle')
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let cancelled = false
    const check = (manual: boolean) => {
      invoke<UpdateInfo | null>('check_update_channel', { channel: getUpdateChannel() })
        .then((u) => {
          if (cancelled) return
          if (u) { setState('idle'); setUpdate(u) }
          else if (manual) { setState('uptodate'); setUpdate(null) }
        })
        .catch(() => { /* hors Tauri, hors ligne, pas de manifeste : silencieux */ })
    }
    // Différé au démarrage : le splash/la connexion sidecar ont la priorité.
    const timer = window.setTimeout(() => check(false), 4000)
    const onManual = () => check(true)
    window.addEventListener('lumitrack-check-update', onManual)
    let unlisten: (() => void) | null = null
    listen<number>('update-progress', (e) => setProgress(e.payload)).then((fn) => { unlisten = fn }).catch(() => {})
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.removeEventListener('lumitrack-check-update', onManual)
      unlisten?.()
    }
  }, [])

  if (state === 'uptodate') {
    return (
      <div className="update-toast">{t('update.upToDate')}
        <button onClick={() => setState('idle')}>✕</button>
      </div>
    )
  }
  if (!update) return null

  const install = async () => {
    setState('downloading')
    setProgress(0)
    try {
      await invoke('install_update_channel', { channel: getUpdateChannel() })
      // Windows/NSIS ferme l'app tout seul ; relaunch en filet multi-OS.
      await relaunch()
    } catch {
      setState('error')
    }
  }

  return (
    <div className="update-overlay">
      <div className="update-dialog">
        <h3>{t('update.title', { version: update.version })}</h3>
        {getUpdateChannel() === 'beta' && <p className="update-beta-tag">{t('update.betaChannelTag')}</p>}
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
