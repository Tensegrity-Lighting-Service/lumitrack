// Store de langue (mission traduction FR/EN, 2026-08-02) — même principe
// que sidecar.ts (useSyncExternalStore) : un état module-level, des
// abonnés, persisté dans localStorage pour retenir la dernière langue
// choisie à la réouverture (demande explicite de Florian).
import { useSyncExternalStore } from 'react'
import { translations, type Locale } from './translations'

export type { Locale }

const STORAGE_KEY = 'lumitrack.locale'

function detectDefault(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'fr' || stored === 'en') return stored
  } catch {
    // localStorage indisponible (contexte hors navigateur) : repli silencieux.
  }
  return 'fr'
}

let currentLocale: Locale = detectDefault()
const listeners = new Set<() => void>()

export function setLocale(locale: Locale) {
  if (locale === currentLocale) return
  currentLocale = locale
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Pas grave si ça ne persiste pas cette fois — le changement reste actif.
  }
  for (const fn of listeners) fn()
}

export function getLocale(): Locale {
  return currentLocale
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Substitution simple {var} -> valeur — pas de pluralisation savante,
 * les clés qui en ont besoin portent déjà leur propre variante (voir
 * translations.ts, ex. `roster.deleteActorsConfirm` + `plural`). */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = translations[currentLocale] ?? translations.fr
  let str = dict[key] ?? translations.fr[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, String(v))
    }
  }
  return str
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, () => currentLocale)
}

/** Hook : s'abonne aux changements de langue (re-render au switch) et
 * renvoie `t` — les composants font `const t = useT()` puis `t('key')`. */
export function useT() {
  useLocale()
  return t
}
