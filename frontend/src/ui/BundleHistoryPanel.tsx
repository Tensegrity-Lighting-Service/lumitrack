// Panneau "Historique des versions" (format bundle 2026-07-31 : fichier
// .lumitrack + media/ + archive/). Chaque sauvegarde explicite archive
// l'ancien contenu du fichier avant de l'écraser — ce panneau liste ces
// copies et permet d'en restaurer une. Réutilise les classes .psn-* : un
// panneau modal générique, pas spécifique au PSN malgré le nom.
import { useEffect } from 'react'
import { sidecar, useBundleArchive } from '../sidecar'

export function BundleHistoryPanel({ path, onClose }: {
  path: string
  onClose: () => void
}) {
  const archive = useBundleArchive()

  useEffect(() => {
    sidecar.listBundleArchive(path)
  }, [path])

  // Périmé si la réponse concerne un autre chemin (changement de projet
  // pendant que le panneau était déjà ouvert).
  const entries = archive && archive.path === path ? archive.entries : null

  const restore = (name: string) => {
    if (!window.confirm(`Restaurer "${name}" ? L'état actuel sera d'abord archivé au prochain Enregistrer, rien n'est perdu.`)) return
    sidecar.loadBundle(path, name)
    onClose()
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
  }

  return (
    <div className="psn-overlay" onClick={onClose}>
      <div className="psn-panel" onClick={(e) => e.stopPropagation()}>
        <div className="psn-head">
          <h2>Historique des versions</h2>
          <span className="psn-head-spacer" />
          <button onClick={onClose} title="Fermer (Échap)">✕</button>
        </div>
        <p className="psn-note">
          Une copie de l'état précédent à chaque « Enregistrer » — jusqu'aux
          50 dernières. Restaurer archive d'abord l'état courant, il reste
          récupérable.
        </p>
        {entries === null && <p className="psn-note">Chargement…</p>}
        {entries !== null && entries.length === 0 && (
          <p className="psn-note">Aucune version archivée pour l'instant — seule une resauvegarde en crée une.</p>
        )}
        {entries !== null && entries.length > 0 && (
          <table className="psn-table">
            <thead>
              <tr><th>Sauvegardé le</th><th></th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.name}>
                  <td>{formatDate(e.mtime)}</td>
                  <td><button onClick={() => restore(e.name)}>Restaurer</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
