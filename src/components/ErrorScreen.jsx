import { Component } from 'react'
import { AlertTriangle, Bug, Copy, RotateCcw } from 'lucide-react'

/**
 * Fatal UI screen for render crashes. The owner can reload into the login gate
 * to inspect the stored crash from the debug console.
 */
export function ErrorScreen({ error, componentStack, onReload, onOpenDebug }) {
  const message = error?.message || String(error || 'Unknown application error')
  const stack = [error?.stack, componentStack].filter(Boolean).join('\n\n')
  const report = {
    app: 'Javelin AI IDE',
    at: new Date().toISOString(),
    message,
    stack,
    url: window.location.href,
    userAgent: navigator.userAgent,
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
    } catch {
      /* clipboard may be unavailable; the report is still visible */
    }
  }

  return (
    <div className="error-screen">
      <div className="error-screen-card">
        <div className="error-screen-icon"><AlertTriangle size={28} /></div>
        <span className="error-screen-kicker">APPLICATION ERROR</span>
        <h1>The interface hit an unexpected error.</h1>
        <p className="error-screen-copy">
          Your project files are still on disk. Reload the interface first; if it happens again,
          open the owner diagnostics and copy the report below.
        </p>
        <div className="error-screen-message">{message}</div>
        {stack && (
          <details className="error-screen-details">
            <summary>Technical details</summary>
            <pre>{stack}</pre>
          </details>
        )}
        <div className="error-screen-actions">
          <button type="button" className="error-screen-primary" onClick={onReload}>
            <RotateCcw size={15} /> Reload Javelin
          </button>
          <button type="button" onClick={copy}><Copy size={15} /> Copy report</button>
          <button type="button" onClick={onOpenDebug}><Bug size={15} /> Owner diagnostics</button>
        </div>
        <small>Diagnostics are available only after owner login.</small>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, componentStack: '' }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    const crash = {
      at: new Date().toISOString(),
      message: error?.message || String(error),
      stack: error?.stack || '',
      componentStack: info?.componentStack || '',
    }
    try {
      localStorage.setItem('javelin.lastCrash', JSON.stringify(crash))
    } catch {
      /* storage may be unavailable */
    }
    this.setState({ componentStack: info?.componentStack || '' })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <ErrorScreen
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReload={() => window.location.reload()}
        onOpenDebug={() => {
          try {
            sessionStorage.setItem('javelin.openDebugAfterReload', '1')
          } catch {
            /* reload still works without the flag */
          }
          window.location.reload()
        }}
      />
    )
  }
}
