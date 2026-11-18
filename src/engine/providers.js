/**
 * Javelin Engine — model transport.
 *
 * One streaming client for every supported backend:
 *
 *   • Ollama (local, keyless)        http://127.0.0.1:11434/v1
 *   • Any OpenAI-compatible server   vLLM, LM Studio, llama.cpp, TGI, OpenRouter…
 *   • Hosted providers               OpenAI, Groq, Together (API key, https)
 *
 * The engine owns transport concerns so the reasoning loop never has to:
 * bound retries with jittered backoff, a total and an idle timeout, cooperative
 * abort, usage accounting, and streamed tool-call assembly.
 *
 * Local providers never transmit an API key, and a hosted provider is only
 * reachable when it was explicitly selected — a stray remote baseUrl on the local
 * provider is refused before any request is made.
 */

import { getProvider, installId, parseToolArguments, salvageToolCallsFromText } from '../lib/providers.js'
import { enqueueProviderRequest } from '../lib/providerQueue.js'
import { LOCAL_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from './limits.js'

/** Extra attempts after the first request. */
export const MAX_MODEL_RETRIES = 2
export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Provider ids that are allowed to talk to a remote endpoint. */
export const HOSTED_PROVIDER_IDS = new Set([
  'openai',
  'groq',
  'together',
  'openrouter',
  'anthropic',
  'custom',
  'gemini',
  'javelincloud',
  'javelinclouddirect',
  'javelinhosted',
])

const DEFAULT_ENDPOINTS = {
  javelin: 'http://127.0.0.1:11434/v1',
  local: 'http://127.0.0.1:11434/v1',
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  openrouter: 'https://openrouter.ai/api/v1',
}

export function isLoopbackEndpoint(value) {
  try {
    const url = new URL(String(value))
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isHostedProvider(provider = {}) {
  if (provider.hosted === true) return true
  if (provider.hosted === false) return false
  return HOSTED_PROVIDER_IDS.has(provider.providerId)
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '')
}

/**
 * Validate a provider selection and produce everything a request needs.
 *
 * Fails loudly and early — before any network call — when the configuration
 * cannot work: no model, a remote URL on a local provider, a hosted endpoint
 * without a key, or plain http to a remote host.
 */
export function resolveTransport(provider = {}) {
  const providerId = provider.providerId ?? 'javelin'
  const model = typeof provider.model === 'string' ? provider.model.trim() : ''
  if (!model) {
    throw new Error('No model is selected. Choose a model in Settings, then run the task again.')
  }

  // The Agent path historically passed only {providerId, baseUrl, apiKey, model}.
  // Merge the provider registry so a keyless hosted provider such as Javelin Cloud
  // is not mistaken for a local Ollama endpoint just because `hosted`/`keyless`
  // were omitted by that caller. Explicit values in `provider` still win.
  const config = { ...getProvider(providerId), ...provider, providerId }
  const endpoint = stripTrailingSlash(config.baseUrl || DEFAULT_ENDPOINTS[providerId] || '')
  if (!endpoint) {
    throw new Error(`Provider "${providerId}" has no endpoint. Set one in Settings.`)
  }

  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`Provider endpoint is not a valid URL: ${endpoint}`)
  }

  const loopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  // A provider selected as hosted but pointed at this machine is a local model:
  // no key is required, and no credential is sent.
  const hosted = isHostedProvider(config) && !loopback

  if (!hosted && !loopback) {
    throw new Error(
      'Remote AI endpoints are disabled for local providers. Select a hosted provider (for example OpenAI or Groq) to use a remote model.',
    )
  }
  if (hosted && !loopback && parsed.protocol !== 'https:') {
    throw new Error(`Hosted model endpoints must use https: ${endpoint}`)
  }
  if (hosted && !loopback && !config.apiKey && !config.keyless) {
    throw new Error(`Provider "${providerId}" requires an API key. Add one in Settings.`)
  }

  return {
    providerId,
    model,
    endpoint,
    hosted,
    // A local runtime must never receive a credential.
    apiKey: hosted && !config.keyless ? config.apiKey : undefined,
    // Javelin Cloud counts its free allowance per install.
    headers: hosted && config.installHeader ? { 'x-javelin-install': installId() } : undefined,
    url: `${endpoint}/chat/completions`,
  }
}

function abortError() {
  const error = new Error('The run was stopped.')
  error.name = 'AbortError'
  return error
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function isRetryableError(error) {
  const message = String(error?.message ?? '')
  if (error?.status && isRetryableStatus(error.status)) return true
  return /econnreset|etimedout|eai_again|network|fetch failed|socket hang up|timed out|idle|temporarily unavailable/i.test(
    message,
  )
}

function backoffMs(attempt) {
  // Jittered exponential backoff keeps several parallel runs from retrying in
  // lockstep against the same local server.
  return 120 * 2 ** attempt + Math.floor(Math.random() * 80)
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Settle `promise` or fail as soon as `signal` aborts, whichever comes first.
 *
 * Streams must never be able to outlive the run that started them: some servers and
 * proxies keep a body open without producing bytes and ignore the abort signal.
 */
function abortRace(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => { })
    return Promise.reject(abortError())
  }
  return new Promise((resolve, reject) => {
    function onAbort() {
      reject(abortError())
    }
    signal.addEventListener?.('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener?.('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener?.('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function readErrorMessage(response) {
  try {
    const text = await response.text()
    if (!text) return ''
    try {
      const parsed = JSON.parse(text)
      return parsed?.error?.message || parsed?.message || text
    } catch {
      return text
    }
  } catch {
    return ''
  }
}

/**
 * Parse an OpenAI-style SSE stream, assembling text and streamed tool calls.
 *
 * Usage is captured when the server sends it (OpenAI `stream_options`, Ollama
 * final chunk), so the caller can account for cost without a second request.
 */
async function readEventStream(response, { onToken, signal, onActivity }) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason = 'stop'
  let usage = null
  let raw = ''
  const calls = []

  const ensureCall = (index) => {
    if (!calls[index]) calls[index] = { id: '', name: '', argsRaw: '', signature: '' }
    return calls[index]
  }

  try {
    for (;;) {
      if (signal?.aborted) throw abortError()
      // Race the read against the abort signal: a body that ignores the controller
      // must not be able to hang the run past its deadline.
      const { value, done } = await abortRace(reader.read(), signal)
      if (done) break
      // Every chunk resets the idle deadline; a stalled stream is aborted by the
      // caller so it becomes a retryable timeout rather than a silent hang.
      onActivity?.()
      const chunkText = decoder.decode(value, { stream: true })
      raw += chunkText
      buffer += chunkText

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
          continue // keep-alive or a partial fragment
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
        for (const call of delta.tool_calls ?? []) {
          const target = ensureCall(call.index ?? 0)
          if (call.id) target.id = call.id
          if (call.function?.name) target.name = call.function.name
          if (call.function?.arguments) {
            target.argsRaw = typeof call.function.arguments === 'string'
              ? `${target.argsRaw}${call.function.arguments}`
              : call.function.arguments
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock?.()
    } catch {
      // ignore
    }
  }

  // Some OpenAI-compatible servers ignore `stream: true` and answer with a single
  // JSON body. Accept that instead of reporting an empty turn.
  if (!content && calls.length === 0 && raw.trim()) {
    try {
      const single = JSON.parse(raw.trim())
      const choice = single.choices?.[0]
      const message = choice?.message ?? choice?.delta
      if (message) {
        content = message.content ?? ''
        if (choice.finish_reason) finishReason = choice.finish_reason
        if (single.usage) usage = single.usage
        for (const call of message.tool_calls ?? []) {
          const target = ensureCall(calls.length)
          target.id = call.id ?? ''
          target.name = call.function?.name ?? ''
          target.argsRaw = call.function?.arguments ?? ''
        }
      }
    } catch {
      // Not a JSON body, so the empty stream stands.
    }
  }

  const toolCalls = []
  for (const call of calls) {
    if (!call?.name) continue
    const args = parseToolArguments(call.argsRaw)
    toolCalls.push({ id: call.id || `call_${toolCalls.length}`, name: call.name, args })
  }

  // Small local models often narrate a tool call instead of using the structured
  // channel. Recovering it here keeps the loop from stalling on a text-only turn.
  if (!toolCalls.length && content) {
    const salvaged = salvageToolCallsFromText(content)
    if (salvaged.length) toolCalls.push(...salvaged)
  }

  return {
    content: toolCalls.length ? '' : content,
    toolCalls,
    finishReason,
    usage,
  }
}

/**
 * Request one model turn.
 *
 * @returns {Promise<{content: string, toolCalls: object[], finishReason: string, usage: object|null, attempts: number, latencyMs: number}>}
 */
export async function requestCompletion(options = {}) {
  if (!options.transport) throw new Error('No model transport was configured.')
  return enqueueProviderRequest(
    options.transport.providerId,
    () => requestCompletionUnqueued(options),
    options.signal,
  )
}

async function requestCompletionUnqueued({
  transport,
  messages,
  tools,
  temperature = 0.2,
  signal,
  maxRetries = MAX_MODEL_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  toolChoice,
  onToken,
  onRetry,
}) {
  if (!transport) throw new Error('No model transport was configured.')
  const startedAt = Date.now()
  let lastError = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw abortError()

    const controller = new AbortController()
    let timedOut = null
    const totalTimer = setTimeout(() => {
      timedOut = `The model did not finish within ${Math.round(timeoutMs / 1000)}s.`
      controller.abort()
    }, timeoutMs)
    let idleTimer = null
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = `The model stopped responding for ${Math.round(idleTimeoutMs / 1000)}s.`
        controller.abort()
      }, idleTimeoutMs)
    }
    let totalCleared = false
    // The wall-clock limit protects the wait for a first token. Once bytes arrive, a
    // slow model that keeps streaming is making progress, so only the idle timeout and
    // the run's own time budget apply.
    const noteActivity = () => {
      if (!totalCleared) {
        totalCleared = true
        clearTimeout(totalTimer)
      }
      armIdle()
    }
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })

    const headers = { 'Content-Type': 'application/json' }
    if (transport.hosted && transport.apiKey) {
      headers.Authorization = `Bearer ${transport.apiKey}`
    }
    if (transport.headers) Object.assign(headers, transport.headers)
    const body = {
      model: transport.model,
      messages,
      temperature,
      // Ask for a real output budget: some servers default to a few hundred tokens,
      // which truncates any file worth writing. A local model gets a smaller one so
      // a runaway reply cannot spend minutes generating before the loop notices.
      max_tokens: transport.hosted ? MAX_OUTPUT_TOKENS : LOCAL_MAX_OUTPUT_TOKENS,
      stream: true,
      // `required` breaks a model out of prose-only replies. It is sent to hosted
      // providers and to Javelin's own server (both accept it); other local runtimes
      // are left alone, because not every OpenAI-compatible server implements it.
      ...(tools?.length
        ? {
          tools,
          ...(transport.hosted || transport.providerId === 'javelinlocal'
            ? { tool_choice: toolChoice ?? 'auto' }
            : {}),
        }
        : {}),
      ...(transport.hosted ? { stream_options: { include_usage: true } } : {}),
    }

    try {
      armIdle()
      let response
      try {
        response = await fetch(transport.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw abortError()
        if (timedOut) throw new Error(timedOut)
        throw new Error(
          `Could not reach the model at ${transport.endpoint}. ${
            transport.hosted
              ? 'Check the endpoint and network connection.'
              // Not every local endpoint is Ollama: naming the wrong runtime sends
              // people looking at the wrong process.
              : 'If that is your own model server, start it with "npm run serve:knowledge"; if it is Ollama, confirm it is listening on port 11434.'
          }`,
        )
      }

      if (!response.ok) {
        const detail = await readErrorMessage(response)
        const error = new Error(`Provider error ${response.status}: ${detail || response.statusText}`)
        error.status = response.status
        throw error
      }

      const parsed = await readEventStream(response, {
        onToken,
        signal: controller.signal,
        onActivity: noteActivity,
      })

      return {
        ...parsed,
        attempts: attempt + 1,
        latencyMs: Date.now() - startedAt,
      }
    } catch (error) {
      lastError = timedOut ? new Error(timedOut) : error
      if (signal?.aborted) throw abortError()
      if (lastError?.name === 'AbortError' && !timedOut) throw abortError()
      const canRetry = attempt < maxRetries && isRetryableError(lastError)
      if (!canRetry) throw lastError
      onRetry?.(attempt + 1, lastError)
      await sleep(backoffMs(attempt), signal)
    } finally {
      clearTimeout(totalTimer)
      if (idleTimer) clearTimeout(idleTimer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  throw lastError ?? new Error('The model request failed.')
}
