import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// App desktop (Tauri = une WebView) : le menu contextuel natif du
// navigateur ("Recharger", "Inspecter l'élément"...) n'a aucun sens ici et
// un "Recharger" accidentel perdrait l'état de l'éditeur — désactivé
// globalement (signalé 2026-08-01 : "clic droit... toujours un menu
// contextuel de navigateur"). Base de repli le temps que le vrai menu
// contextuel par cible (DIRECTIVES.md point 8, pas encore construit) existe
// partout ; une fois posé, il fera son propre preventDefault plus haut dans
// la capture et affichera son propre menu à la place.
window.addEventListener('contextmenu', (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
