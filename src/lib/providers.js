import { TOOL_DEFS } from './agentTools.js'
import { canonicalizeToolCall } from '../core/tools.js'
import { codeError, ERROR_CODES } from '../engine/errors.js'

/**
 * Provider layer.
 *
 * A local provider (Ollama on this machine) is keyless and cannot be pointed at a remote
 * host. Hosted providers are opt-in: they need https and their own API key, and are never
 * substituted for a local one implicitly. Transport failures carry a stable error code
 * (see `src/engine/errors.js`).
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/**
 * Does this provider need the local Ollama runtime at all?
 *
 * Only a loopback endpoint does. A hosted provider must never start, probe or require
 * Ollama — someone using OpenAI should not have a local runtime running (or installed).
 */
export function providerNeedsLocalRuntime(providerId, baseUrl) {
  const provider = PROVIDERS[providerId]
  // A provider that ships its own local server must not drag Ollama in with it.
  if (provider?.localServer) return false
  const endpoint = String(baseUrl || provider?.baseUrl || '')
  try {
    return LOOPBACK_HOSTS.has(new URL(endpoint).hostname.toLowerCase())
  } catch {
    return !provider?.hosted
  }
}

export const PROVIDERS = {
  /**
   * Javelin Cloud — Javelin models served from our own proxy, free for users.
   * No API key and no local runtime: the proxy holds the provider key server-side
   * and counts one daily allowance per install id.
   */
  javelincloud: {
    id: 'javelincloud',
    label: 'Javelin Cloud (server proxy, free)',
    baseUrl: 'https://site-96a7149f3a1b4e329da008e6a95c848e.freebuff.page/v1',
    requiresKey: false,
    keyless: true,
    hosted: true,
    freeTier: true,
    vision: false,
    installHeader: true,
    models: [
      { id: 'javelin', label: 'Javelin Cloud' },
      { id: 'javelin-fast', label: 'Javelin Cloud (fast)' },
    ],
    defaultModel: 'javelin',
    help:
      'Free Javelin models hosted by Javelin Cloud. No API key and no Ollama: requests go to the hosted service, ' +
      'which uses one shared free allowance (a daily request limit per machine). Its shared upstream can be busy; ' +
      'choose Javelin Cloud Direct on a phone for the lowest-latency free route.',
  },
  /**
   * The same free model without the Javelin Cloud proxy hop.
   *
   * The hosted proxy calls this public keyless service from one Cloudflare egress
   * address, so all of its users compete for one upstream slot. Calling it from the
   * user's own device gives each phone/browser its own slot, removes the proxy wait,
   * and avoids the proxy's 429 when that shared slot is busy.
   */
  javelinclouddirect: {
    id: 'javelinclouddirect',
    label: 'Javelin Cloud Direct (free, no key)',
    baseUrl: 'https://text.pollinations.ai/openai',
    requiresKey: false,
    keyless: true,
    hosted: true,
    freeTier: true,
    vision: false,
    models: [
      { id: 'openai-fast', label: 'Javelin Cloud Direct (fast)' },
      { id: 'openai', label: 'Javelin Cloud Direct' },
    ],
    defaultModel: 'openai-fast',
    help:
      'The free Javelin model called directly from this device. No API key or Ollama needed; ' +
      'one free reply runs at a time, so wait for the current answer if the service asks you to retry.',
  },
  /**
   * Javelin's self-hosted model served by local Ollama.
   */
  javelin: {
    id: 'javelin',
    label: 'Javelin (self-hosted)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    isJavelinModel: true,
    vision: false,
    models: [
      { id: 'javelin-coder:latest', label: 'Javelin Coder (local)' },
      { id: 'qwen2.5-coder:7b', label: 'Local Qwen2.5 Coder 7B' },
      { id: 'qwen2.5-coder:1.5b', label: 'Local Qwen2.5 Coder 1.5B (faster)' },
      { id: 'llama3.2:1b', label: 'Local Llama 3.2 1B (faster)' },
    ],
    defaultModel: 'javelin-coder:latest',
    help:
      'Uses Javelin Coder through Ollama on this computer. Prompts and project files stay local; no hosted AI API is used. ' +
      'Install the Javelin model through its supplied model distribution if it is not installed.',
  },
  /**
   * Javelin's own trained model, served by `training/knowledge/serve.py`.
   *
   * This is the one provider whose weights belong to this project: a LoRA adapter
   * trained on the knowledge corpus, served from a loopback HTTP process with no
   * Ollama and no key. `localServer` marks it so nothing tries to start or probe the
   * Ollama runtime for it — a different local server must not imply a different one.
   *
   * It is deliberately not the default: a 135M model is fluent but not reliable on
   * novel reasoning, and the agent loop needs a model that can drive tools.
   */
  javelinlocal: {
    id: 'javelinlocal',
    label: 'Javelin Local (your trained model)',
    baseUrl: 'http://127.0.0.1:8787/v1',
    requiresKey: false,
    keyless: true,
    hosted: false,
    localServer: true,
    vision: false,
    models: [
      { id: 'javelin-knowledge', label: 'Javelin Chatting Knowledge (0.5B, local)' },
      { id: 'javelin-coder-1.5b', label: 'Javelin Coder 1.5B (local)' },
      { id: 'javelin-coder-3b', label: 'Javelin Coder 3B (local, fast)' },
      { id: 'javelin-coder-7b', label: 'Javelin Coder 7B (local, recommended)' },
    ],
    // The coder is the better default for an editor; the chat model stays available.
    defaultModel: 'javelin-coder-1.5b',
    help:
      'Your own trained models, running on this computer. Start them with "npm run serve:knowledge", then chat; the ' +
      'llama.cpp path measured ~18 tokens/s against ~2.7 for the Python one. No API key, no Ollama and no cloud. ' +
      'Javelin Chatting Knowledge (Qwen2.5-Coder 0.5B) is the conversation model; '
      + 'Javelin Coder 7B is recommended when Vulkan GPU acceleration is available; 3B is the fast choice '
      + 'without a GPU, and 1.5B is the lightest. The server detects a Vulkan device, offloads every layer '
      + 'to it, and falls back to CPU automatically when no GPU is usable.',
  },
  /**
   * Your own model, hosted on your own GPU endpoint.
   *
   * Unlike `javelincloud`, this does not proxy to a vendor model: the endpoint you
   * point it at serves the merged weights from `npm run model:merge`. That makes 7B
   * and 14B usable — sizes that cannot run in the IDE's own process.
   *
   * No default base URL on purpose. Guessing a host would produce a confusing
   * failure; the error instead says the URL is missing and where to set it.
   */
  javelinhosted: {
    id: 'javelinhosted',
    label: 'Javelin Hosted (your own GPU model)',
    baseUrl: '',
    requiresKey: true,
    hosted: true,
    models: [
      { id: 'javelin-7b', label: 'Javelin 7B (recommended)' },
      { id: 'javelin-14b', label: 'Javelin 14B (needs 40GB+ VRAM)' },
      { id: 'javelin-cloud', label: 'Javelin (whatever the server serves)' },
    ],
    defaultModel: 'javelin-7b',
    help:
      'Your own model on your own GPU endpoint, with no vendor AI in the request path. ' +
      'Train and merge with the 7B/14B commands in cloud-model/README.md, deploy the container, ' +
      'then paste its https URL and key here.',
  },
  /**
   * Google Gemini — free tier, OpenAI-compatible endpoint, no card required.
   * The default so a new install runs on a cloud model without Ollama.
   */
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (free tier)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    hosted: true,
    vision: true,
    freeTier: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    // Current model ids only: older flash ids answer 404 "no longer available to new
    // users" for keys created today, which looked like a broken provider.
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (fast, free tier)' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (limited free tier)' },
    ],
    defaultModel: 'gemini-3.8-flash',
    help:
      'Cloud model with a free tier. Create a free API key in Google AI Studio (no card needed) and paste it here. ' +
      'Prompts and file contents are sent to Google; nothing runs on this computer and Ollama is not used.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (hosted)',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    hosted: true,
    vision: true,
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini (faster)' },
    ],
    defaultModel: 'gpt-5-codex',
    help:
      'Hosted OpenAI models. Prompts are sent to OpenAI with your API key, so project code you share in a prompt leaves this computer.',
  },
  groq: {
    id: 'groq',
    label: 'Groq (hosted, low latency)',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    hosted: true,
    vision: false,
    freeTier: true,
    keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2 Instruct' },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'qwen/qwen3-32b', label: 'Qwen3 32B' },
    ],
    defaultModel: 'moonshotai/kimi-k2-instruct',
    help: 'Hosted Groq inference for very low latency. Requires a Groq API key; prompts leave this computer.',
  },
  together: {
    id: 'together',
    label: 'Together AI (hosted)',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    hosted: true,
    vision: false,
    models: [
      { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', label: 'Qwen3 Coder 480B' },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' },
    ],
    defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    help: 'Hosted Together AI models, including large coding fine-tunes. Requires an API key.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (hosted)',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    hosted: true,
    vision: true,
    keyUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder' },
    ],
    defaultModel: 'anthropic/claude-sonnet-4.5',
    help: 'Hosted models through OpenRouter. Requires an OpenRouter API key.',
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    baseUrl: '',
    requiresKey: false,
    hosted: true,
    models: [],
    defaultModel: '',
    help:
      'Any OpenAI-compatible server (vLLM, LM Studio, llama.cpp, TGI). Use https for a remote host; localhost may use http. Add an API key if the server needs one.',
  },
}

// Library default: the local model, so an explicit provider choice is never assumed.
export const DEFAULT_PROVIDER = 'javelin'
// What the IDE starts a new install on.
//
// Javelin Cloud (the `javelincloud` provider) is the long-term answer, but until the
// hosted service has its upstream key attached it can only answer "busy". A free
// Gemini key is a real cloud API with proper limits, needs no local runtime, and is
// what every install starts on, so the app works out of the box.
export const DEFAULT_CLOUD_PROVIDER = 'gemini'

/**
 * This install's id, sent to Javelin Cloud so its free daily allowance is counted per
 * machine rather than per user account.
 */
export function installId() {
  const key = 'javelin.installId'
  try {
    let id = localStorage.getItem(key)
    if (!id) {
      id = globalThis.crypto?.randomUUID?.() ?? `j-${Date.now().toString(36)}`
      localStorage.setItem(key, id)
    }
    return id
  } catch {
    return 'unknown-install'
  }
}

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
 * Requests are restricted to the Ollama service on this computer.
 *
 * @param {object} opts
 * @param {'javelin'|'local'|'groq'|'custom'} opts.providerId
 * @param {string} [opts.baseUrl] override the provider's default endpoint
 * @param {string} [opts.apiKey] only needed when the provider requires one
 * @param {string} opts.model
 * @param {object[]} opts.messages OpenAI-format messages (roles may include 'tool')
 * @param {object[]} [opts.tools] OpenAI-format tool definitions
 * @param {(delta: string) => void} [opts.onToken]
 * @param {(call: {id: string, name: string, args: any}) => void} [opts.onToolCall]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.temperature]
 * @returns {Promise<{content: string, toolCalls: {id: string, name: string, args: any}[], finishReason: string, usage: object|null}>}
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

  const endpoint = (baseUrl || provider.baseUrl || '').replace(/\/$/, '')
  if (!endpoint) {
    throw codeError(
      new Error(`${provider.label ?? providerId} needs an endpoint URL. Open Settings and paste the https URL of your model server.`),
      ERROR_CODES.MODEL_CONFIG,
    )
  }
  // A hosted provider is only reachable when the user selected one explicitly, and
  // only for a non-loopback endpoint: a custom provider pointed at localhost is
  // still a local model and must not demand a key. A local provider can never be
  // pointed at a remote service by accident.
  const hosted = Boolean(provider.hosted) && !isLocalOllamaEndpoint(endpoint)
  let endpointProtocol = ''
  try {
    endpointProtocol = new URL(endpoint).protocol
  } catch {
    endpointProtocol = ''
  }
  if (hosted) {
    if (!apiKey && !provider.keyless) {
      throw codeError(
        new Error(`${provider.label ?? providerId} requires an API key. Open Settings and add one.`),
        ERROR_CODES.MODEL_AUTH,
      )
    }
    if (endpointProtocol !== 'https:' && !isLocalOllamaEndpoint(endpoint)) {
      throw codeError(new Error(`Hosted model endpoints must use https: ${endpoint}`), ERROR_CODES.MODEL_CONFIG)
    }
  } else if (!isLocalOllamaEndpoint(endpoint) && !isLoopbackEndpoint(endpoint)) {
    // Ollama and Javelin's own local server can run on another machine on the same
    // network. Only the explicitly selected local providers get this exception;
    // they never receive an API key. Browsers still enforce mixed-content rules.
    const remoteLocalServer = providerId === 'javelin' || providerId === 'local' || providerId === 'javelinlocal'
    if (!remoteLocalServer) {
      throw codeError(
        new Error('Javelin only connects to a server on this computer (localhost). Remote AI endpoints are disabled.'),
        ERROR_CODES.MODEL_CONFIG,
      )
    }
    if (
      endpointProtocol === 'http:' &&
      typeof window !== 'undefined' &&
      window.location?.protocol === 'https:'
    ) {
      throw codeError(
        new Error(
          `This HTTPS page cannot call the plain-HTTP endpoint ${endpoint}. Use an HTTPS tunnel for Ollama, ` +
          'or open the app from a local HTTP address. Hosted providers work without Ollama.',
        ),
        ERROR_CODES.MODEL_CONFIG,
      )
    }
  }
  const url = `${endpoint}/chat/completions`

  const headers = { 'Content-Type': 'application/json' }
  // Credentials go only to an explicitly selected hosted provider.
  if (hosted && apiKey && !provider.keyless) headers.Authorization = `Bearer ${apiKey}`
  // Javelin Cloud counts its free allowance per install, not per account.
  if (hosted && provider.installHeader) headers['x-javelin-install'] = installId()

  const body = {
    model,
    messages,
    temperature,
    stream: true,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    // Ask hosted providers to include the usage totals in the final chunk so
    // signed-in token accounting can use exact numbers when they are offered.
    ...(hosted ? { stream_options: { include_usage: true } } : {}),
  }

  // A provider that never answers must not leave the UI spinning forever.
  const timeoutMs = 90_000
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCallerAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onCallerAbort, { once: true })

  let res
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
  } catch (err) {
    if (signal?.aborted) throw err
    throw codeError(
      new Error(
        timedOut
          ? `${provider.label ?? providerId} did not answer within ${Math.round(timeoutMs / 1000)}s. Free tiers are often busy — try again, or switch provider in Settings.`
          : hosted
            ? `Could not reach ${provider.label ?? providerId} at ${endpoint}. Check the endpoint and your network connection.`
            : provider.localServer
              ? `Could not reach your own model server at ${endpoint}. Start it with "npm run serve:knowledge" — it serves Javelin Chatting Knowledge and Javelin Coder 1.5B — then try again.`
              : `Could not reach Ollama at ${endpoint}. Start Ollama, confirm it is listening on port 11434, and make sure this device can reach that address. ${provider.help}`,
      ),
      ERROR_CODES.MODEL_UNREACHABLE,
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const parsed = await res.json()
      detail = parsed?.error?.message || JSON.stringify(parsed)
    } catch {
      detail = await res.text().catch(() => '')
    }
    if (res.status === 404) {
      throw codeError(new Error(`Model "${model}" not found (404) at ${url}. ${provider.help}`), ERROR_CODES.MODEL_CONFIG)
    }
    const statusCode = res.status === 401 || res.status === 403 ? ERROR_CODES.MODEL_AUTH : ERROR_CODES.MODEL_FAILED
    throw codeError(new Error(`Provider error ${res.status}: ${detail}`), statusCode)
  }

  return readStream(res, { onToken, onToolCall, signal })
}

/** Any server on this machine — the Ollama runtime or Javelin's own knowledge server. */
export function isLoopbackEndpoint(baseUrl) {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isLocalOllamaEndpoint(baseUrl) {
  try {
    const endpoint = new URL(baseUrl)
    return endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) &&
      endpoint.port === '11434'
  } catch {
    return false
  }
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
  let usage = null
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

        if (json.usage) usage = json.usage
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
          if (tc.function?.arguments) {
            call.argsRaw = typeof tc.function.arguments === 'string'
              ? `${call.argsRaw}${tc.function.arguments}`
              : tc.function.arguments
          }
        }
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  const parsed = []
  for (const call of toolCalls) {
    if (!call?.name) continue
    const args = parseToolArguments(call.argsRaw)
    const result = { id: call.id || `call_${parsed.length}`, name: call.name, args }
    parsed.push(result)
    onToolCall?.(result)
  }

  // Fallback for local models that describe tool calls in prose or fenced blocks
  // instead of populating the structured channel.
  if (parsed.length === 0 && content) {
    const salvaged = salvageToolCallsFromText(content)
    if (salvaged.length) {
      parsed.push(...salvaged)
      for (const call of salvaged) onToolCall?.(call)
    }
  }

  return {
    content: parsed.length ? '' : content,
    toolCalls: parsed,
    finishReason,
    usage,
  }
}

/**
 * Parse one tool-call arguments payload.
 *
 * The OpenAI wire format requires a JSON string, but local runtimes and custom
 * adapters sometimes hand back an already-parsed object. Accept both instead of
 * turning a valid call into `undefined` arguments.
 */
export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { __raw: raw, __parseError: true }
  } catch {
    return { __raw: raw, __parseError: true }
  }
}

/**
 * Recover recognized tool calls embedded in text. Local models sometimes label
 * fences `jsonCopy` and repeat tool-call JSON inside explanatory prose; parse
 * balanced JSON objects individually rather than trying to parse one greedy span.
 */
export function salvageToolCallFromText(text) {
  return salvageToolCallsFromText(text)[0] ?? null
}

export function salvageToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return []
  const toolDefinitions = new Map(TOOL_DEFS.map((tool) => [tool.function.name, tool.function]))
  const calls = []
  const seen = new Set()
  for (const raw of extractBalancedJsonObjects(text)) {
    let obj
    try {
      obj = JSON.parse(raw)
    } catch {
      // Qwen occasionally wraps the whole call in an extra pair of braces.
      const trimmed = raw.trim()
      if (!(trimmed.startsWith('{{') && trimmed.endsWith('}}'))) continue
      try {
        obj = JSON.parse(trimmed.slice(1, -1))
      } catch {
        continue
      }
    }

    const fn = obj?.function ?? obj?.tool_call ?? obj
    const rawName = fn?.name ?? fn?.tool
    const name = typeof rawName === 'string' ? canonicalizeToolCall({ name: rawName }).name : rawName
    const definition = toolDefinitions.get(name)
    if (!definition) continue

    let args = fn?.arguments ?? fn?.parameters ?? fn?.args ?? {}
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue
    if ((definition.parameters.required ?? []).some((key) => !(key in args))) continue

    const signature = JSON.stringify([name, args])
    if (seen.has(signature)) continue
    seen.add(signature)
    calls.push({
      position: text.indexOf(raw),
      call: { id: `salvaged_${name}_${calls.length}`, name, args, salvaged: true },
    })
  }

  for (const xmlCall of salvageXmlFunctionCalls(text, toolDefinitions)) {
    const signature = JSON.stringify([xmlCall.name, xmlCall.args])
    if (seen.has(signature)) continue
    seen.add(signature)
    calls.push(xmlCall)
  }

  for (const fileCall of salvageExplicitNewFile(text)) {
    const signature = JSON.stringify([fileCall.name, fileCall.args])
    if (seen.has(signature)) continue
    seen.add(signature)
    calls.push({ position: fileCall.position, call: fileCall })
  }

  return calls.sort((a, b) => a.position - b.position).map(({ call }) => call)
}

/**
 * Recover Qwen's XML-ish call form:
 *   <function name="write_file" arguments='{"path":"a.html","content":"..."}'/>
 * The chat template can leak this as plain text when tool parsing is unavailable.
 */
function salvageXmlFunctionCalls(text, toolDefinitions) {
  const calls = []
  const pattern = /<function\s+name=["']([^"']+)["']\s+arguments=(?:"([\s\S]*?)"|'([\s\S]*?)')\s*\/?>/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const name = canonicalizeToolCall({ name: match[1] }).name
    const definition = toolDefinitions.get(name)
    if (!definition) continue

    let args
    try {
      args = JSON.parse((match[2] ?? match[3] ?? '').trim())
    } catch {
      continue
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue
    if ((definition.parameters.required ?? []).some((key) => !(key in args))) continue

    calls.push({
      position: match.index,
      call: { id: `salvaged_${name}_${calls.length}`, name, args, salvaged: true },
    })
  }
  return calls
}

function salvageExplicitNewFile(text) {
  const calls = []
  const declaration = /\bcreate\s+a\s+new\s+file\s+[`'"]?([^`'"\s:]+)[`'"]?\s+inside\s+(?:the\s+)?[`'"]?([^`'".:]+)[`'"]?\s+folder\b/gi
  let match
  while ((match = declaration.exec(text)) !== null) {
    const fileName = match[1]
    const directory = match[2].replace(/[\\/]+$/, '')
    const path = `${directory}/${fileName}`.replace(/\\/g, '/')
    if (path.startsWith('/') || path.split('/').includes('..')) continue

    const fence = /```[^\r\n`]*\r?\n([\s\S]*?)```/g
    fence.lastIndex = declaration.lastIndex
    let block
    let selected
    while ((block = fence.exec(text)) !== null) {
      const code = block[1].trim()
      if (!code) continue
      try {
        const parsed = JSON.parse(code)
        if (parsed && (parsed.name || parsed.function?.name || parsed.tool)) continue
      } catch {
        // Most source blocks are not JSON.
      }

      const declaredPath = code.match(/^\s*(?:\/\/|#)\s*([^\r\n]+\.[\w.-]+)\s*$/m)?.[1]?.trim()
      if (declaredPath) {
        if (declaredPath.replace(/\\/g, '/') !== path) continue
      }
      selected = { code: `${code}\n`, position: block.index }
      break
    }
    if (!selected) continue

    calls.push({
      id: `salvaged_write_file_${calls.length}`,
      name: 'write_file',
      args: { path, content: selected.code },
      salvaged: true,
      position: selected.position,
    })
  }

  const mentionedPath = /\b(?:write|create|save|add|generate|implement|put)\b[^.\r\n]{0,180}?\b(?:in|to|at|as)\s+[`'"]?((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+)[`'"]?/gi
  while ((match = mentionedPath.exec(text)) !== null) {
    const path = match[1].replace(/\\/g, '/')
    if (path.startsWith('/') || path.split('/').includes('..')) continue

    const fence = /```[^\r\n`]*\r?\n([\s\S]*?)```/g
    let block
    let selected
    while ((block = fence.exec(text)) !== null) {
      const code = block[1].trim()
      if (!code) continue
      try {
        const parsed = JSON.parse(code)
        if (parsed && (parsed.name || parsed.function?.name || parsed.tool)) continue
      } catch {
        // Most source blocks are not JSON.
      }

      const declaredPath = code.match(/^\s*(?:\/\/|#|<!--)\s*([^\r\n>]+\.[\w.-]+)\s*(?:-->)?\s*$/m)?.[1]?.trim()
      if (declaredPath?.replace(/\\/g, '/') !== path) continue
      selected = { code: `${code}\n`, position: block.index }
      break
    }
    if (!selected) continue

    calls.push({
      id: `salvaged_write_file_${calls.length}`,
      name: 'write_file',
      args: { path, content: selected.code },
      salvaged: true,
      position: selected.position,
    })
  }

  const codeFence = /```[^\r\n`]*\r?\n([\s\S]*?)```/g
  let block
  while ((block = codeFence.exec(text)) !== null) {
    const code = block[1].trim()
    if (!code) continue

    const declaration = text.slice(0, block.index).split(/```/).pop() ?? ''
    const explicitlyCreatesFile =
      /\b(?:create|write|save|add|generate|implement|build)\b[^.!?\r\n]{0,180}\b(?:file|script|module|component|page|game|program)\b/i.test(declaration) ||
      /\b(?:let['’]s|let us)\s+(?:call|name)\s+(?:it|this)\s+[`'"]?(?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+[`'"]?/i.test(declaration)
    if (!explicitlyCreatesFile) continue

    const headerPath = code.match(/^\s*(?:\/\/|#)\s*((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+)\s*$/m)?.[1]
      ?? code.match(/^\s*<!--\s*((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+)\s*-->\s*$/m)?.[1]
    if (!headerPath) continue

    const path = headerPath.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..')) continue
    try {
      const parsed = JSON.parse(code)
      if (parsed && (parsed.name || parsed.function?.name || parsed.tool)) continue
    } catch {
      // Source code is normally not JSON.
    }

    calls.push({
      id: `salvaged_write_file_${calls.length}`,
      name: 'write_file',
      args: { path, content: `${code}\n` },
      salvaged: true,
      position: block.index,
    })
  }
  return calls
}

function extractBalancedJsonObjects(text) {
  const objects = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"' && depth > 0) {
      inString = true
    } else if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0) {
        objects.push(text.slice(start, index + 1))
        if (objects.length >= 100) break
      }
    }
  }
  return objects
}

/** True if a local runtime answers on its /v1 endpoint (used to show a friendly hint). */
export async function probeLocalRuntime(baseUrl = PROVIDERS.javelin.baseUrl) {
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
