// Contenu du menu contextuel "Acteur" (DIRECTIVES.md point 8), partagé
// entre la scène (clic droit sur un acteur/ghost) et le roster (clic droit
// sur une ligne) — un seul et même acteur, deux endroits d'où le viser.
// "Aller à sa zone backstage" volontairement HORS PÉRIMÈTRE ici : demande
// un nouveau mécanisme de caméra (cadrer un rectangle de zone précis, pas
// seulement le terrain entier) — pas encore construit, risque de code
// caméra sans retour visuel possible (même prudence que le geste libre de
// déplacement, point 3).
import { sidecar } from '../sidecar'
import type { Point, Project } from '../types'
import type { ContextMenuSections } from './contextMenuStore'
import { pickColor } from './colorPicker'
import { promptText } from './promptDialog'
import { t } from '../i18n'

export function buildActorContextMenuSections(point: Point, project: Project): ContextMenuSections {
  // Mission "modes d'orientation" (2026-08-04) : ce repli ne concerne que
  // la phase TRAJET — l'arrivée retombe toujours sur "hold" par défaut.
  // "manual" (lacet animé en douceur) a disparu, remplacé par "fixed"
  // (instantané) — plus de rotationManual au sens de l'ancien mode.
  const orientationOptions: Array<['fixed' | 'path' | 'focus', string]> = [
    ['fixed', t('cue.rotationFixed')],
    ['path', t('cue.rotationPath')],
    ['focus', t('cue.rotationFocus')],
  ]
  return [
    [
      {
        label: t('contextMenu.rename'),
        onClick: async () => {
          const name = await promptText(t('contextMenu.renameActorPrompt'), point.name)
          if (name && name !== point.name) sidecar.updatePoint(point.id, { name })
        },
      },
      { label: t('contextMenu.color'), onClick: () => pickColor(point.color, (hex) => sidecar.updatePoint(point.id, { color: hex })) },
      {
        label: t('contextMenu.duplicate'),
        onClick: () => sidecar.addPoint(`${point.name} (copie)`, undefined, point.rosterGroupId, point.color, crypto.randomUUID()),
      },
    ],
    orientationOptions.map(([mode, label]) => ({
      label: t('contextMenu.orientationDefaultPrefix', { label }),
      checked: (point.defaultTravelOrientationMode ?? 'fixed') === mode,
      onClick: () => sidecar.updatePoint(point.id, { defaultTravelOrientationMode: mode }),
    })),
    [
      {
        label: t('contextMenu.folderNone'),
        checked: point.rosterGroupId === null,
        onClick: () => sidecar.updatePoint(point.id, { rosterGroupId: null }),
      },
      ...project.rosterGroups.map((g) => ({
        label: g.name,
        checked: point.rosterGroupId === g.id,
        onClick: () => sidecar.updatePoint(point.id, { rosterGroupId: g.id }),
      })),
    ],
    [
      {
        label: t('contextMenu.delete'),
        danger: true,
        onClick: () => {
          if (window.confirm(t('contextMenu.deleteActorConfirm', { name: point.name }))) sidecar.deletePoint(point.id)
        },
      },
    ],
  ]
}

/** Menu contextuel "Point de focus" — un simple repère de visée, pas un
 * acteur réel : pas de section mode d'orientation (il n'en a pas), pas de
 * section dossier (vit dans sa propre liste du roster, pas les dossiers
 * d'acteurs). Rename/couleur/dupliquer/supprimer réutilisés tels quels. */
export function buildFocusPointContextMenuSections(point: Point): ContextMenuSections {
  return [
    [
      {
        label: t('contextMenu.rename'),
        onClick: async () => {
          const name = await promptText(t('contextMenu.renameActorPrompt'), point.name)
          if (name && name !== point.name) sidecar.updatePoint(point.id, { name })
        },
      },
      { label: t('contextMenu.color'), onClick: () => pickColor(point.color, (hex) => sidecar.updatePoint(point.id, { color: hex })) },
      {
        label: t('contextMenu.duplicate'),
        onClick: () => sidecar.addFocusPoint(`${point.name} (copie)`, point.color, crypto.randomUUID()),
      },
    ],
    [
      {
        label: t('contextMenu.delete'),
        danger: true,
        onClick: () => {
          if (window.confirm(t('contextMenu.deleteActorConfirm', { name: point.name }))) sidecar.deletePoint(point.id)
        },
      },
    ],
  ]
}
