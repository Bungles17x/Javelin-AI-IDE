import { useMemo, useState } from 'react'
import {
  AlertTriangle, Bug, CheckCircle2, Copy, Cpu, HardDrive, LogOut, MessageSquare,
  RefreshCw, RotateCcw, ShieldCheck, X,
} from 'lucide-react'
import { GUEST_DAILY_LIMIT, OWNER_USERNAME } from '../lib/ownerAuth'

function readLastCrash() {
  try {
    return JSON.parse(localStorage.getItem('javelin.lastCrash') || 'null')
  } catch {
    return null
  }
}

function bytesLabel(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Owner-only diagnostics. This is deliberately read-only plus a few safe
 * recovery actions; it never exposes API keys or executes arbitrary commands.
 */
export function DebugScreen({
  open, providerLabel, model, baseUrl, runtimeStatus, runtimeError, needsLocalRuntime = true,
  workspaceFiles, workspaceDirectories, messages, theme, guestUsed, error, runResult, voiceNotice,
  onClose, onLock, onRefreshRuntime, onReload,
}) {
  const [copied, setCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const lastCrash = useMemo(() => (open ? readLastCrash() : null), [open])
  const storageBytes = useMemo(() => {
    if (!open) return 0
    try {
      return Object.keys(localStorage).reduce((sum, key) => sum + key.length + String(localStorage.getItem(key) ?? '').length, 0)
    } catch {
      return 0
    }
  }, [open, messages, guestUsed])

  if (!open) return null

  const fileCount = Object.keys(workspaceFiles ?? {}).length

  const report = {
    app: 'Javelin AI IDE',
    generatedAt: new Date().toISOString(),
    owner: OWNER_USERNAME,
    provider: { id: providerLabel, model, endpoint: baseUrl || 'default' },
    runtime: runtimeStatus ?? null,
    runtimeError: runtimeError || null,
    workspace: { files: fileCount, directories: (workspaceDirectories ?? []).length },
    conversation: { messages: (messages ?? []).length },
    theme,
    guestUsage: guestUsed,
    guestLimit: GUEST_DAILY_LIMIT,
    currentError: error || null,
    lastRun: runResult ? {
      status: runResult.status,
      code: runResult.code,
      confidence: runResult.confidence,
      summary: runResult.summary,
      steps: runResult.steps?.length ?? 0,
    } : null,
    voiceNotice: voiceNotice || null,
    lastCrash,
    environment: {
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      storageBytes,
    },
  }

  const reportText = JSON.stringify(report, null, 2)

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(reportText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await onRefreshRuntime?.()
    } finally {
      setRefreshing(false)
    }
  }

  const runtimeOk = needsLocalRuntime && Boolean(runtimeStatus?.ollama?.ok)
  const runtimeValue = !needsLocalRuntime
    ? 'Not required'
    : runtimeStatus
      ? (runtimeOk ? 'Online' : 'Offline')
      : 'Checking'
  const runtimeDetail = !needsLocalRuntime
    ? 'Provider runs separately'
    : `${runtimeStatus?.ollama?.models?.length ?? 0} local model(s)`

  return (
    <div className="debug-backdrop" role="dialog" aria-modal="true" aria-labelledby="debug-title">
      <div className="debug-screen">
        <header className="debug-header">
          <div className="debug-brand">
            <span className="debug-emblem"><Bug size={18} /></span>
            <div>
              <span className="debug-kicker">OWNER DIAGNOSTICS</span>
              <h2 id="debug-title">Debug console</h2>
            </div>
            <span className="debug-owner"><ShieldCheck size={12} /> {OWNER_USERNAME}</span>
          </div>
          <div className="debug-header-actions">
            <button type="button" onClick={onLock} title="Lock the owner session"><LogOut size={14} /> Lock</button>
            <button type="button" className="debug-close" onClick={onClose} aria-label="Close debug console"><X size={16} /></button>
          </div>
        </header>

        <div className="debug-body">
          <section className="debug-stats" aria-label="System status">
            <article className="debug-stat">
              <span><Cpu size={14} /> Local runtime</span>
              <strong className={!needsLocalRuntime ? '' : runtimeOk ? 'is-good' : 'is-bad'}>{runtimeValue}</strong>
              <small>{runtimeDetail}</small>
            </article>
            <article className="debug-stat">
              <span><ShieldCheck size={14} /> Access</span>
              <strong className="is-good">Owner</strong>
              <small>Unlimited AI requests</small>
            </article>
            <article className="debug-stat">
              <span><HardDrive size={14} /> Workspace</span>
              <strong>{fileCount}</strong>
              <small>{(workspaceDirectories ?? []).length} folders indexed</small>
            </article>
            <article className="debug-stat">
              <span><MessageSquare size={14} /> Conversation</span>
              <strong>{(messages ?? []).length}</strong>
              <small>{storageBytes ? bytesLabel(storageBytes) : '0 B'} local data</small>
            </article>
          </section>

          <section className="debug-grid">
            <article className="debug-panel">
              <h3>Model connection</h3>
              <dl>
                <div><dt>Provider</dt><dd>{providerLabel}</dd></div>
                <div><dt>Model</dt><dd>{model}</dd></div>
                <div><dt>Endpoint</dt><dd title={baseUrl || 'Provider default'}>{baseUrl || 'Provider default'}</dd></div>
                <div><dt>Ollama runtime</dt><dd className={!needsLocalRuntime ? '' : runtimeOk ? 'is-good' : 'is-bad'}>{!needsLocalRuntime ? 'Not used by this provider' : runtimeOk ? 'Reachable' : runtimeError || 'Not reachable'}</dd></div>
              </dl>
              <div className="debug-actions">
                <button type="button" onClick={refresh} disabled={refreshing || !needsLocalRuntime}>
                  <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
                  {!needsLocalRuntime ? 'Runtime not required' : refreshing ? 'Checking…' : 'Refresh runtime'}
                </button>
                <button type="button" onClick={copyReport}><Copy size={13} /> {copied ? 'Copied' : 'Copy report'}</button>
              </div>
            </article>

            <article className="debug-panel">
              <h3>Recent issues</h3>
              <div className="debug-issues">
                {error && <div className="debug-issue is-error"><AlertTriangle size={13} /><span>{String(error)}</span></div>}
                {runResult && runResult.status !== 'done' && (
                  <div className={`debug-issue ${runResult.status === 'failed' ? 'is-error' : ''}`}>
                    <AlertTriangle size={13} />
                    <span>{runResult.code ? `${runResult.code} · ` : ''}{runResult.summary || runResult.status}</span>
                  </div>
                )}
                {lastCrash && (
                  <div className="debug-issue is-error">
                    <AlertTriangle size={13} />
                    <span>UI crash at {new Date(lastCrash.at).toLocaleString()}: {lastCrash.message}</span>
                  </div>
                )}
                {voiceNotice && <div className="debug-issue"><AlertTriangle size={13} /><span>{voiceNotice}</span></div>}
                {!error && !lastCrash && (!runResult || runResult.status === 'done') && !voiceNotice && (
                  <div className="debug-issue is-clear"><CheckCircle2 size={13} /><span>No errors recorded in this session.</span></div>
                )}
              </div>
            </article>
          </section>

          <details className="debug-raw">
            <summary>Full diagnostic report</summary>
            <pre>{reportText}</pre>
          </details>
        </div>

        <footer className="debug-footer">
          <span>Local diagnostics · nothing is uploaded</span>
          <button type="button" onClick={onReload}><RotateCcw size={13} /> Reload app</button>
        </footer>
      </div>
    </div>
  )
}
