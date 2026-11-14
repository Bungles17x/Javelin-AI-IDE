import { useEffect, useState } from 'react'
import { X, ExternalLink, Eye, EyeOff, Cpu } from 'lucide-react'
import { Button } from './Button'
import { PROVIDERS, getProvider, probeLocalRuntime } from '../lib/providers'
import { TTS_PROVIDERS, voicesFor, isCloudVoice } from '../lib/cloudTts'

export function SettingsDialog({
  open, onClose, providerId, apiKey, baseUrl, model, providerEndpoints = {}, onSave,
  ttsProvider = 'system', ttsKey = '', ttsVoice = '',
}) {
  const [draftProvider, setDraftProvider] = useState(providerId)
  const [draftKey, setDraftKey] = useState(apiKey)
  const [draftBase, setDraftBase] = useState(baseUrl)
  const [draftModel, setDraftModel] = useState(model)
  const [draftTtsProvider, setDraftTtsProvider] = useState(ttsProvider)
  const [draftTtsKey, setDraftTtsKey] = useState(ttsKey)
  const [draftTtsVoice, setDraftTtsVoice] = useState(ttsVoice)
  const [showKey, setShowKey] = useState(false)
  const [probe, setProbe] = useState(null)

  useEffect(() => {
    if (open) {
      setDraftProvider(providerId)
      setDraftKey(apiKey)
      setDraftBase(baseUrl)
      setDraftModel(model)
      setDraftTtsProvider(ttsProvider)
      setDraftTtsKey(ttsKey)
      setDraftTtsVoice(ttsVoice)
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
    const res = await probeLocalRuntime(draftBase || PROVIDERS.javelin.baseUrl)
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
      voice: {
        ttsProvider: draftTtsProvider,
        ttsKey: draftTtsKey.trim(),
        ttsVoice: draftTtsVoice,
      },
    })
    onClose()
  }

  return (
    <div
      className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <div
        className="settings-panel glass-dialog max-h-[85vh] w-full max-w-md overflow-y-auto rounded-3xl border p-6 text-card-foreground"
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
              onChange={(e) => {
                const nextProvider = e.target.value
                setDraftProvider(nextProvider)
                setDraftBase(providerEndpoints[nextProvider] ?? '')
              }}
              className="flex h-10 w-full rounded-md border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {Object.values(PROVIDERS).map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">{provider.help}</p>
            {draftProvider === 'javelin' && (
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
            {(draftProvider === 'together' || draftProvider === 'replicate' || draftProvider === 'anyscale') && (
              <div className="mt-2">
                <p className="text-xs text-muted-foreground">
                  💡 These providers support custom fine-tuned models. See{' '}
                  <a
                    href="https://github.com/javelin-ai/javelin-ai-assistant/blob/main/docs/CLOUD-FINE-TUNING.md"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    Cloud Fine-Tuning Guide
                  </a>
                </p>
              </div>
            )}
          </div>

          {(draftProvider === 'custom' || draftProvider === 'local' || draftProvider === 'replicate' || draftProvider === 'together' || draftProvider === 'anyscale' || draftProvider === 'javelinhosted') && (
            <div>
              <label htmlFor="base-url" className="mb-1.5 block text-sm font-medium">
                Endpoint base URL
              </label>
              <input
                id="base-url"
                type="text"
                value={draftBase}
                onChange={(e) => setDraftBase(e.target.value)}
                placeholder={provider.baseUrl || (draftProvider === 'javelinhosted'
                  ? 'https://your-model-host.example.com/v1'
                  : 'http://localhost:1234/v1')}
                spellCheck={false}
                className="flex h-10 w-full rounded-md border-input bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {draftProvider === 'javelinhosted'
                  ? 'Required. The https URL of the server running your merged model.'
                  : 'Leave blank to use the provider default.'}
              </p>
            </div>
          )}

          {provider.keyUrl && (
            <p className="-mt-1 text-xs text-muted-foreground">
              <a
                href={provider.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {provider.freeTier ? 'Get a free API key' : 'Get an API key'}
              </a>
              {provider.freeTier ? ' — free tier, no card required.' : ''}
            </p>
          )}

          {(provider.requiresKey || (provider.hosted && !provider.keyless)) && (
          <div>
            <label htmlFor="api-key" className="mb-1.5 block text-sm font-medium">
              API key{provider.requiresKey ? '' : ' (optional)'}
            </label>
            <div className="flex gap-2">
              <input
                id="api-key"
                type={showKey ? 'text' : 'password'}
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                placeholder={provider.id === 'openai' ? 'sk-...' : provider.id === 'gemini' ? 'AIza...' : provider.id === 'anthropic' ? 'sk-ant-...' : provider.id === 'replicate' ? 'r8_' : provider.id === 'together' ? 'tgpv_' : provider.id === 'anyscale' ? 'ans_' : 'gsk_...'}
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
              {provider.id === 'openai' && (
                <>
                  Get a key at{' '}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                  >
                    platform.openai.com <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
              {provider.id === 'anthropic' && (
                <>
                  Get a key at{' '}
                  <a
                    href="https://console.anthropic.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                  >
                    console.anthropic.com <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
              {provider.id === 'groq' && (
                <>
                  Get a key at{' '}
                  <a
                    href="https://console.groq.com/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                  >
                    console.groq.com <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
              {provider.id === 'openrouter' && (
                <>
                  Get a key at{' '}
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                  >
                    openrouter.ai <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
              {provider.id === 'replicate' && (
                <>
                  Get a key at{' '}
                  <a
                    href="https://replicate.com/account/api-tokens"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                  >
                    replicate.com <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
              {provider.id === 'together' && (
                <>
                  Get a key at{' '}
                  <a
                    href="https://api.together.xyz/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                  >
                    api.together.xyz <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
              {provider.id === 'anyscale' && (
                <>
                  Get a key at{' '}
                  <a
                    href="https://console.anyscale.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                  >
                    console.anyscale.com <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
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

          {/* Voice output. Cloud voices are optional: with no key the system voice
              keeps working, so this section can be ignored entirely. */}
          <div className="border-t pt-4">
            <label htmlFor="tts-provider" className="mb-1.5 block text-sm font-medium">
              Spoken replies
            </label>
            <select
              id="tts-provider"
              value={draftTtsProvider}
              onChange={(e) => {
                setDraftTtsProvider(e.target.value)
                const next = voicesFor(e.target.value)
                setDraftTtsVoice(next[0]?.id ?? '')
              }}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {Object.values(TTS_PROVIDERS).map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">{TTS_PROVIDERS[draftTtsProvider]?.help}</p>

            {isCloudVoice(draftTtsProvider) && (
              <>
                <label htmlFor="tts-key" className="mb-1.5 mt-3 block text-sm font-medium">
                  Voice API key
                </label>
                <input
                  id="tts-key"
                  type="password"
                  value={draftTtsKey}
                  onChange={(e) => setDraftTtsKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={draftTtsProvider === 'elevenlabs' ? 'sk_...' : 'sk-...'}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <a
                    href={TTS_PROVIDERS[draftTtsProvider]?.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    Get a key
                  </a>
                  {' '}· stored in this browser's localStorage, sent only to that provider.
                </p>

                <label htmlFor="tts-voice" className="mb-1.5 mt-3 block text-sm font-medium">
                  Voice
                </label>
                <select
                  id="tts-voice"
                  value={draftTtsVoice}
                  onChange={(e) => setDraftTtsVoice(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {voicesFor(draftTtsProvider).map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
                {!draftTtsKey.trim() && (
                  <p className="mt-1.5 text-xs text-amber-600">
                    Without a key, spoken replies use the system voice.
                  </p>
                )}
              </>
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
