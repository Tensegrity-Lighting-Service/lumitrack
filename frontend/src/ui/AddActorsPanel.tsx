// Popup "Ajouter des acteurs" (2026-08-01, remplace l'ancien "+ Acteur"
// un-par-un) : nom de base + quantité en un seul geste. Numérotation sur le
// premier trou libre (un acteur supprimé redevient disponible plutôt que de
// laisser un numéro à jamais inutilisé) ; le nom de chaque acteur ajouté
// partage cet index avec son numéro ("Danseur 6" ↔ n° 6). Couleur : cycle
// sur une palette, comme les blocs de la timeline, plutôt que la même
// couleur par défaut pour tout le lot. Nom de base et quantité sont
// mémorisés pour la session (variables de module, pas un state React) afin
// de préremplir la prochaine ouverture — pas persisté entre redémarrages,
// choix discuté avec Florian.
import { useEffect, useState } from 'react'
import { sidecar } from '../sidecar'
import type { Project } from '../types'
import { NumericInput } from './NumericInput'

const ACTOR_PALETTE = ['#4F6DF5', '#F5734F', '#B06FE0', '#4FF58C', '#4FF5E0', '#F5C84F']

let lastBaseName = 'Acteur'
let lastCount = 1

function firstFreeNumbers(existing: Set<number>, count: number): number[] {
  const out: number[] = []
  let n = 1
  while (out.length < count) {
    if (!existing.has(n)) out.push(n)
    n++
  }
  return out
}

export function AddActorsPanel({ project, onClose }: {
  project: Project
  onClose: () => void
}) {
  const [baseName, setBaseName] = useState(lastBaseName)
  const [count, setCount] = useState(lastCount)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmedName = baseName.trim() || 'Acteur'
  const usedNumbers = new Set(
    project.points.map((p) => p.number).filter((n): n is number => n !== null))
  const numbers = firstFreeNumbers(usedNumbers, count)

  const add = () => {
    lastBaseName = trimmedName
    lastCount = count
    numbers.forEach((num, i) => {
      sidecar.addPoint(
        `${trimmedName} ${num}`, num, null,
        ACTOR_PALETTE[(project.points.length + i) % ACTOR_PALETTE.length])
    })
    onClose()
  }

  return (
    <div className="psn-overlay" onClick={onClose}>
      <div className="psn-panel" onClick={(e) => e.stopPropagation()}>
        <div className="psn-head">
          <h2>Ajouter des acteurs</h2>
          <span className="psn-head-spacer" />
          <button onClick={onClose} title="Fermer (Échap)">✕</button>
        </div>
        <div className="actor-grid">
          <label>Nom de base
            <input
              value={baseName}
              autoFocus
              onChange={(e) => setBaseName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add() }}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <label>Nombre à ajouter
            <NumericInput
              value={count} step={1}
              onCommit={(v) => setCount(Math.max(1, Math.min(99, Math.round(v ?? 1))))}
            />
          </label>
        </div>
        <p className="psn-note">
          {numbers.length === 1
            ? `Créera « ${trimmedName} ${numbers[0]} » (n° ${numbers[0]}), sans groupe.`
            : `Créera « ${trimmedName} ${numbers[0]} » à « ${trimmedName} ${numbers[numbers.length - 1]} » (n° ${numbers[0]} à ${numbers[numbers.length - 1]}), sans groupe.`}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button onClick={add}>Ajouter</button>
        </div>
      </div>
    </div>
  )
}
