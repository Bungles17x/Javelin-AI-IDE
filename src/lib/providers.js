/**
 * Provider layer.
 *
 * Javelin can talk to any OpenAI-compatible /chat/completions endpoint. The default
 * provider is a *local* model served by Ollama, which requires no API key and keeps
 * your code on your machine. Cloud providers are opt-in and pluggable.
 *
 * Why a provider abstraction instead of one hardcoded endpoint:
 *  - "No API key" is only physically possible when the model runs locally. A 70B
 *    cloud model cannot execute inside a browser tab. So the honest way to give you
 *    a keyless experience is to default to a local runtime and make cloud optional.
 *  - The agent loop is identical either way, so swapping providers changes nothing
 *    downstream.
 */

export const PROVIDERS = {
  /**
   * Javelin's own model: a fine-tuned adapter served locally by Ollama (or any
   * OpenAI-compatible server). Keyless, like the plain local provider, but it points
   * at the trained Javelin weights instead of a stock model.
   *
   * Nothing in the runtime changes for this — Javelin Core already treats any
   * endpoint as a swappable engine. Selecting this provider is all that is needed to
   * use a trained model. The model must actually exist; `npm run models` reports
   * whether it does. A missing model simply fails to connect, like any other.
   */
  javelin: {
    id: 'javelin',
    label: 'Javelin (self-hosted)',
    baseUrl: 'http://localhost:8080/v1',
    requiresKey: false,
    isJavelinModel: true,
    models: [
      { id: 'javelin', label: 'Javelin (your model)' },
      { id: 'javelin-coder-80b', label: 'Javelin Coder 80B (flagship)' },
    ],
    defaultModel: 'javelin',
    help:
      'Serves your Javelin-trained weights. Create it once with ' +
      '`ollama create javelin -f Modelfile`. Javelin Coder 80B must be trained and ' +
      'merged first — run `npm run models` to see whether it actually exists.',
  },

  /**
   * Local runtime (Ollama). Keyless. Strong models available: qwen2.5-coder,
   * deepseek-coder-v2, llama3.1, etc. Quality scales with your hardware.
   */
  local: {
    id: 'local',
    label: 'Local (keyless)',
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
    models: [
      { id: 'javelin-coder', label: 'Javelin Coder (local, built here)' },
      { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B' },
      { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B' },
      { id: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B' },
      { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
      { id: 'codellama:13b', label: 'Code Llama 13B' },
    ],
    defaultModel: 'javelin-coder',
    help:
      'Runs locally, no key, code never leaves your machine. Build your own Javelin ' +
      'model once with `npm run model:local` (creates `javelin-coder`), then select it. ' +
      'Or pull a stock model: `ollama pull qwen2.5-coder:7b`.',
  },

  /** Groq cloud (fast, free tier, needs a key). */
  groq: {
    id: 'groq',
    label: 'Groq (cloud, key required)',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (fast)' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'qwen/qwen3-32b', label: 'Qwen3 32B' },
    ],
    defaultModel: 'llama-3.3-70b-versatile',
    help: 'Get a free key at https://console.groq.com/keys',
  },

  /** Any other OpenAI-compatible server (LM Studio, vLLM, OpenRouter, your own). */
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    requiresKey: false,
    models: [],
    defaultModel: '',
    help: 'Point this at any /v1 endpoint, including your own self-hosted model.',
  },
}

export const DEFAULT_PROVIDER = 'local'

export function getProvider(id) {
  return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER]
}

/** Models for a provider, falling back to the custom free-text model. */
export function modelsFor(providerId, customModel) {
  const provider = getProvider(providerId)
  if (provider.models.length) return provider.models
  return customModel ? [{ id: customModel, label: customModel }] : []
}

/**
 * Stream a chat completion in OpenAI format.
 *
 * @param {object} opts
 * @param {'local'|'groq'|'custom'} opts.providerId
 * @param {string} [opts.baseUrl] override the provider's default endpoint
 * @param {string} [opts.apiKey] only needed when the provider requires one
 * @param {string} opts.model
 * @param {object[]} opts.messages OpenAI-format messages (roles may include 'tool')
 * @param {object[]} [opts.tools] OpenAI-format tool definitions
 * @param {(delta: string) => void} [opts.onToken]
 * @param {(call: {id: string, name: string, args: any}) => void} [opts.onToolCall]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.temperature]
 * @returns {Promise<{content: string, toolCalls: {id: string, name: string, args: any}[], finishReason: string}>}
 */
export async function streamCompletion({
  providerId = DEFAULT_PROVIDER,
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  onToken,
  onToolCall,
  signal,
  temperature = 0.2,
}) {
  const provider = getProvider(providerId)
  const url = `${(baseUrl || provider.baseUrl || '').replace(/\/$/, '')}/chat/completions`
  if (!url.startsWith('http')) {
    throw new Error(
      `No endpoint configured for provider "${provider.id}". ${provider.help}`,
    )
  }
  if (provider.requiresKey && !apiKey) {
    throw new Error(`Provider "${provider.label}" needs an API key. ${provider.help}`)
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const body = {
    model,
    messages,
    temperature,
    stream: true,
  }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  let res
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    // A network-level failure against a local runtime is almost always "not running".
    if (provider.id === 'local') {
      throw new Error(
        `Could not reach the local model at ${url}. Is Ollama running? Try \`ollama serve\`. ${provider.help}`,
      )
    }
    throw new Error(`Could not reach ${url}: ${err.message}`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const parsed = await res.json()
      detail = parsed?.error?.message || JSON.stringify(parsed)
    } catch {
      detail = await res.text().catch(() => '')
    }
    if (res.status === 401) throw new Error('Invalid API key (401). Check it in Settings.')
    if (res.status === 404) throw new Error(`Model "${model}" not found (404) at ${url}. ${provider.help}`)
    if (res.status === 429) throw new Error('Rate limited (429). Wait a moment or use a smaller/local model.')
    throw new Error(`Provider error ${res.status}: ${detail}`)
  }

  return readStream(res, { onToken, onToolCall, signal })
}

/**
 * Parse an OpenAI-style SSE stream, accumulating text deltas and tool-call fragments.
 * Tool calls stream as partial JSON, so we buffer arguments per call index and only
 * parse them once the stream ends.
 */
export async function readStream(res, { onToken, onToolCall, signal } = {}) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason = 'stop'
  const toolCalls = []

  const ensureCall = (index) => {
    if (!toolCalls[index]) {
      toolCalls[index] = { id: '', name: '', argsRaw: '' }
    }
    return toolCalls[index]
  }

  try {
    for (;;) {
      if (signal?.aborted) break
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue // keep-alive or partial fragment
        }

        const choice = json.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finishReason = choice.finish_reason

        const delta = choice.delta ?? {}
        if (delta.content) {
          content += delta.content
          onToken?.(delta.content)
        }
        for (const tc of delta.tool_calls ?? []) {
          const call = ensureCall(tc.index ?? 0)
          if (tc.id) call.id = tc.id
          if (tc.function?.name) call.name = tc.function.name
          if (tc.function?.arguments) call.argsRaw += tc.function.arguments
        }
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  const parsed = []
  for (const call of toolCalls) {
    if (!call?.name) continue
    let args = {}
    if (call.argsRaw) {
      try {
        args = JSON.parse(call.argsRaw)
      } catch {
        args = { __raw: call.argsRaw, __parseError: true }
      }
    }
    const result = { id: call.id || `call_${parsed.length}`, name: call.name, args }
    parsed.push(result)
    onToolCall?.(result)
  }

  // Fallback for local models that *describe* a tool call in text instead of using
  // the structured channel. qwen2.5-coder served by Ollama commonly emits a fenced
  // JSON block (```json {...} ```) or a bare <tool_call>{...}</tool_call> rather than
  // populating delta.tool_calls. Without this, the agent sees prose and never acts.
  if (parsed.length === 0 && content) {
    const salvaged = salvageToolCallFromText(content)
    if (salvaged) {
      parsed.push(salvaged)
      onToolCall?.(salvaged)
    }
  }

  return {
    content: parsed.length ? '' : content,
    toolCalls: parsed,
    finishReason,
  }
}

/**
 * Try to recover a single tool call that a model emitted as text.
 * Handles: a <tool_call>…</tool_call> block, a ```json fenced object, or a bare JSON
 * object that names a tool. Returns null if nothing tool-shaped is found — we never
 * invent a call that is not there.
 */
export function salvageToolCallFromText(text) {
  if (!text || typeof text !== 'string') return null
  const candidates = []

  // <tool_call> {...} </tool_call>
  const tagged = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i)
  if (tagged) candidates.push(tagged[1])

  // ```json ... ``` or ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1])

  // A bare {...} object anywhere in the text.
  const braced = text.match(/\{[\s\S]*\}/)
  if (braced) candidates.push(braced[0])

  for (const raw of candidates) {
    let obj
    try {
      obj = JSON.parse(raw.trim())
    } catch {
      continue
    }
    // Accept both {name, arguments} and the OpenAI {function:{name,arguments}} shape.
    const fn = obj?.function ?? obj
    const name = fn?.name ?? fn?.tool
    if (typeof name !== 'string' || !name) continue
    let args = fn?.arguments ?? fn?.parameters ?? {}
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = { __raw: args, __parseError: true }
      }
    }
    return { id: `salvaged_${name}_${Date.now()}`, name, args, salvaged: true }
  }

  return null
}

/** True if a local runtime answers on its /v1 endpoint (used to show a friendly hint). */
export async function probeLocalRuntime(baseUrl = PROVIDERS.local.baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return { ok: false }
    const data = await res.json()
    return { ok: true, models: (data?.data ?? []).map((m) => m.id) }
  } catch {
    return { ok: false }
  }
}
