// Petit utilitaire pour déclencher le sélecteur de couleur natif depuis un
// item de menu contextuel (pas de `<input type="color">` visible à cet
// endroit) — un `<input>` caché, ajouté au DOM le temps du choix puis
// retiré, plutôt qu'un composant React à monter/démonter pour un geste
// aussi ponctuel.
export function pickColor(initial: string, onPick: (hex: string) => void) {
  const input = document.createElement('input')
  input.type = 'color'
  input.value = initial
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  input.style.opacity = '0'
  document.body.appendChild(input)
  const cleanup = () => { input.remove() }
  input.addEventListener('input', () => onPick(input.value))
  input.addEventListener('change', cleanup)
  // Certains navigateurs/webviews n'émettent pas toujours 'change' si
  // l'utilisateur ferme le picker sans confirmer explicitement — filet de
  // sécurité pour ne jamais laisser l'input orphelin dans le DOM.
  input.addEventListener('blur', cleanup)
  input.click()
}
