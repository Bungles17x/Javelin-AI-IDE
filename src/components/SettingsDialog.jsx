import { useEffect, useState } from 'react'
import { X, ExternalLink, Eye, EyeOff, Cpu } from 'lucide-react'
import { Button } from './Button'
import { PROVIDERS, getProvider, probeLocalRuntime } from '../lib/providers'

export function SettingsDialog({
  open, onClose, providerId, apiKey, baseUrl, model, onSave,
}) {
  const [draftProvider, setDraftProvider] = useState(providerId)
  const [draftKey, setDraftKey] = useState(apiKey)
  const [draftBase, setDraftBase] = useState(baseUrl)
  const [draftModel, setDraftModel] = useState(model)
  const [showKey, setShowKey] = useState(false)
  const [probe, setProbe] = useState(null)

  useEffect(() => {
    if (open) {
      setDraftProvider(providerId)
      setDraftKey(apiKey)
      setDraftBase(baseUrl)
      setDraftModel(model)
      setShowKey(false)
      setProbe(null)
    }
  }, [open, providerId, apiKey, baseUrl, model])

  const provider = getProvider(draftProvider)

  // When the provider changes, snap the model to one that provider actually serves.
  useEffect(() => {
    if (!open) return
    const list = provider.models
    if (list.length && !list.some((m) => m.id === draftModel)) {
      setDraftModel(provider.defaultModel)
    }
  }, [open, provider, draftModel])

  // Offer a one-click check that a local runtime is actually reachable.
  const checkLocal = async () => {
    setProbe({ checking: true })
    const res = await probeLocalRuntime(draftBase || PROVIDERS.local.baseUrl)
    setProbe(res.ok ? { ok: true, count: res.models.length } : { ok: false })
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const save = () => {
    onSave({
      providerId: draftProvider,
      apiKey: draftKey.trim(),
      baseUrl: draftBase.trim(),
      model: draftModel,
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <div
        className="w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="settings-title" className="text-lg font-semibold">Settings</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="provider" className="mb-1.5 block text-sm font-medium">
              Model provider
            </label>
            <select
              id="provider"
              value={draftProvider}
              onChange={(e) => setDraftProvider(e.target.value)}
              className="flex h-10 w-full rounded-md border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {Object.values(PROVIDERS).map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">{provider.help}</p>
            {draftProvider === 'local' && (
              <div className="mt-2 flex items-center gap-2">
                <Button variant="outline" size="sm" type="button" onClick={checkLocal} className="h-7 text-xs">
                  <Cpu className="mr-1.5 h-3 w-3" />
                  Check local runtime
                </Button>
                {probe?.checking && <span className="text-xs text-muted-foreground">Checking…</span>}
                {probe && !probe.checking && (
                  <span className={`text-xs ${probe.ok ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {probe.ok ? `Running — ${probe.count} model(s) available` : 'Not reachable — start Ollama first'}
                  </span>
                )}
              </div>
            )}
          </div>

          {(draftProvider === 'custom' || draftProvider === 'local') && (
            <div>
              <label htmlFor="base-url" className="mb-1.5 block text-sm font-medium">
                Endpoint base URL
              </label>
              <input
                id="base-url"
                type="text"
                value={draftBase}
                onChange={(e) => setDraftBase(e.target.value)}
                placeholder={provider.baseUrl || 'http://localhost:1234/v1'}
                spellCheck={false}
                className="flex h-10 w-full rounded-md border-input bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">Leave blank to use the provider default.</p>
            </div>
          )}

          {provider.requiresKey && (
          <div>
            <label htmlFor="api-key" className="mb-1.5 block text-sm font-medium">
              API key
            </label>
            <div className="flex gap-2">
              <input
                id="api-key"
                type={showKey ? 'text' : 'password'}
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                placeholder="gsk_..."
                autoComplete="off"
                spellCheck={false}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <Button
                variant="outline"
                size="icon"
                type="button"
                onClick={() => setShowKey((s) => !s)}
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Get a key at{' '}
              <a
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
              >
                console.groq.com <ExternalLink className="h-3 w-3" />
              </a>
              . Stored only in this browser's localStorage and sent straight to the provider.
            </p>
          </div>
          )}

          <div>
            <label htmlFor="model" className="mb-1.5 block text-sm font-medium">
              Model
            </label>
            {provider.models.length ? (
            <select
              id="model"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            ) : (
              <input
                id="model"
                type="text"
                value={draftModel}
                onChange={(e) => setDraftModel(e.target.value)}
                placeholder="model-name"
                spellCheck={false}
                className="flex h-10 w-full rounded-md border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </div>
      </div>
    </div>
  )
}
