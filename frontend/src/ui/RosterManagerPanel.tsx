// Panneau "Gérer le roster" (mission "hiérarchie du roster", 2026-07-31) :
// avant cette mission, le roster ne savait qu'ajouter un acteur à la fois
// depuis la colonne de gauche — jamais supprimer, jamais réordonner en
// masse, jamais organiser en sous-groupes. Ce panneau réunit l'édition par
// lot (ajout de plusieurs acteurs, suppression, réassignation de groupe en
// masse) et la gestion des sous-groupes eux-mêmes.
//
// Les sous-groupes sont PUREMENT organisationnels — ordonner la vue du
// roster, faciliter la sélection et le glisser-déposer d'un ensemble
// d'acteurs. Rien à voir avec les groupes animables du §12.2 (reportés en
// v1.1 : appartenance multiple, animation relative, LTP inter-groupes) :
// ici, un acteur appartient à AU PLUS UN sous-groupe, comme un dossier de
// fichiers. Réutilise les classes .psn-* : un panneau modal générique.
import { useState } from 'react'
import { sidecar } from '../sidecar'
import type { Project } from '../types'
import { NumericInput } from './NumericInput'

const UNGROUPED = ''

export function RosterManagerPanel({ project, onClose }: {
  project: Project
  onClose: () => void
}) {
  const groups = project.rosterGroups
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [addCount, setAddCount] = useState(1)
  const [addGroupId, setAddGroupId] = useState(UNGROUPED)
  const [newGroupName, setNewGroupName] = useState('')

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    setSelectedIds((prev) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }
      return prev.has(id) && prev.size === 1 ? new Set() : new Set([id])
    })
  }

  const addActors = () => {
    const base = project.points.length
    for (let i = 0; i < addCount; i++) {
      sidecar.addPoint(`Acteur ${base + i + 1}`, base + i + 1, addGroupId || null)
    }
  }

  const deleteSelected = () => {
    if (selectedIds.size === 0) return
    if (!window.confirm(`Supprimer ${selectedIds.size} acteur${selectedIds.size > 1 ? 's' : ''} ? Leurs activations dans tous les blocs partent aussi.`)) return
    for (const id of selectedIds) sidecar.deletePoint(id)
    setSelectedIds(new Set())
  }

  const assignSelectedToGroup = (groupId: string) => {
    for (const id of selectedIds) sidecar.updatePoint(id, { rosterGroupId: groupId || null })
  }

  const addGroup = () => {
    const name = newGroupName.trim()
    if (!name) return
    sidecar.setRosterGroups([...groups, { id: crypto.randomUUID(), name }])
    setNewGroupName('')
  }

  const renameGroup = (id: string, name: string) => {
    sidecar.setRosterGroups(groups.map((g) => (g.id === id ? { ...g, name } : g)))
  }

  const deleteGroup = (id: string) => {
    if (!window.confirm('Supprimer ce sous-groupe ? Les acteurs qu’il contient redeviennent « sans groupe » — rien d’autre ne change.')) return
    sidecar.setRosterGroups(groups.filter((g) => g.id !== id))
  }

  return (
    <div className="psn-overlay" onClick={onClose}>
      <div className="psn-panel roster-manager-panel" onClick={(e) => e.stopPropagation()}>
        <div className="psn-head">
          <h2>Gérer le roster</h2>
          <span className="psn-head-spacer" />
          <button onClick={onClose} title="Fermer (Échap)">✕</button>
        </div>

        <section>
          <h3>Sous-groupes</h3>
          <p className="psn-note">
            Purement pour organiser la vue, la sélection et le glisser-déposer —
            aucun effet sur la lecture ni sur la sortie PSN.
          </p>
          {groups.length > 0 && (
            <table className="psn-table">
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <input value={g.name} onChange={(e) => renameGroup(g.id, e.target.value)} />
                    </td>
                    <td className="psn-note">
                      {project.points.filter((p) => p.rosterGroupId === g.id).length} acteur(s)
                    </td>
                    <td><button onClick={() => deleteGroup(g.id)}>Supprimer</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="roster-manager-row">
            <input
              placeholder="Nom du nouveau groupe" value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addGroup() }}
            />
            <button onClick={addGroup}>+ Groupe</button>
          </div>
        </section>

        <section>
          <h3>Acteurs ({project.points.length})</h3>
          <div className="roster-manager-row">
            <input
              type="number" min={1} max={99} value={addCount}
              title="Nombre d'acteurs à ajouter d'un coup"
              onChange={(e) => setAddCount(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            />
            <select value={addGroupId} onChange={(e) => setAddGroupId(e.target.value)}>
              <option value={UNGROUPED}>Sans groupe</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <button onClick={addActors}>+ Ajouter</button>
            {selectedIds.size > 0 && (
              <>
                <span className="psn-head-spacer" />
                <span className="psn-note">{selectedIds.size} sélectionné(s)</span>
                <select defaultValue="" onChange={(e) => { if (e.target.value !== '') assignSelectedToGroup(e.target.value === '__none__' ? '' : e.target.value); e.target.value = '' }}>
                  <option value="" disabled>Assigner au groupe…</option>
                  <option value="__none__">Sans groupe</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <button onClick={deleteSelected}>Supprimer la sélection</button>
              </>
            )}
          </div>

          <table className="psn-table roster-manager-table">
            <thead>
              <tr><th>Nom</th><th>N°</th><th></th><th>Groupe</th><th></th></tr>
            </thead>
            <tbody>
              {project.points.map((p) => (
                <tr
                  key={p.id}
                  className={selectedIds.has(p.id) ? 'selected' : ''}
                  onClick={(e) => toggleSelect(p.id, e)}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      value={p.name}
                      onChange={(e) => sidecar.updatePoint(p.id, { name: e.target.value })}
                    />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <NumericInput value={p.number} step={1} nullable
                      onCommit={(v) => sidecar.updatePoint(p.id, { number: v })} />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="color" value={p.color}
                      onChange={(e) => sidecar.updatePoint(p.id, { color: e.target.value })} />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      value={p.rosterGroupId ?? UNGROUPED}
                      onChange={(e) => sidecar.updatePoint(p.id, { rosterGroupId: e.target.value || null })}
                    >
                      <option value={UNGROUPED}>Sans groupe</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => sidecar.deletePoint(p.id)} title="Supprimer cet acteur">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
