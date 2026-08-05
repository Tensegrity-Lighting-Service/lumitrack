// Error boundary générique — ajouté le 2026-08-04 en diagnostiquant le bug
// "l'app ne se lance plus" : sans AUCUN error boundary dans l'arbre, la
// moindre exception de rendu (API Tauri absente hors WebView, terrain GLB
// introuvable, etc.) démontait TOUTE l'app en écran blanc, sans le moindre
// message visible — indiagnosticable pour l'utilisateur. Deux usages :
// autour de l'app entière (fallback = message d'erreur lisible) et autour
// de sous-arbres risqués comme le chargement du terrain (fallback = null,
// la scène continue sans terrain).
import React from 'react'

export class ErrorBoundary extends React.Component<
  { fallback?: React.ReactNode; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui', color: '#e8e8ec', background: '#15151a', minHeight: '100vh' }}>
          <h2>Erreur inattendue</h2>
          <p>L'application a rencontré une erreur de rendu. Détail (à transmettre) :</p>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#f5734f' }}>
            {String(this.state.error?.stack ?? this.state.error)}
          </pre>
          <button onClick={() => this.setState({ error: null })}>Réessayer</button>
        </div>
      )
    }
    return this.props.children
  }
}
