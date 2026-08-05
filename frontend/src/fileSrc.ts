import { convertFileSrc } from '@tauri-apps/api/core'

/** convertFileSrc sans exploser hors Tauri (dev navigateur) : l'API lance
 * une exception SYNCHRONE quand __TAURI_INTERNALS__ est absent, et sans
 * error boundary l'exception démontait toute l'app (écran blanc constaté
 * le 2026-08-04 en reproduisant "l'app ne se lance plus" dans un
 * navigateur). Hors Tauri le chemin brut ne chargera rien (les fichiers
 * disque ne sont pas servis) — l'audio/le terrain sont simplement absents
 * en dev navigateur, tout le reste de l'app fonctionne. */
export function fileSrc(path: string): string {
  try {
    return convertFileSrc(path)
  } catch {
    return path
  }
}
