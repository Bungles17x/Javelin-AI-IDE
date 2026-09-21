/**
 * Javelin Core — Inference Engine Layer
 * =====================================
 *
 * Javelin does not depend on one model. It owns its own *reasoning lifecycle* and
 * treats any model as a pluggable **engine** underneath it.
 *
 * The distinction matters and is worth being precise about:
 *   - A model's parameters (the "weights") are not Javelin's. Swapping engines
 *     swaps the raw language ability.
 *   - The *system* — planning, tool use, memory, verification, self-repair — IS
 *     Javelin's, and is identical regardless of which engine is attached.
 *
 * An engine must implement `generate(request) -> { text, toolCalls }` and declare
 * its capabilities. Engines are registered, probed for health, and can be swapped
 * or chained (e.g. a fast engine for planning, a stronger one for code) at runtime.
 */

import { streamCompletion } from '../lib/providers.js'

/** Capabilities an engine may advertise, so the planner can adapt its strategy. */
export const CAPABILITY = {
  TOOLS: 'tools',
  LONG_CONTEXT: 'long-context',
  STRONG_REASONING: 'strong-reasoning',
  FAST: 'fast',
  OFFLINE: 'offline',
}

/**
 * @typedef {object} EngineDescriptor
 * @property {string} id
 * @property {string} label
 * @property {string[]} capabilities
 * @property {() => Promise<{ok: boolean, detail?: string}>} probe
 * @property {(req: EngineRequest) => Promise<EngineResponse>} generate
 */

/**
 * @typedef {object} EngineRequest
 * @property {object[]} messages
 * @property {object[]} [tools]
 * @property {AbortSignal} [signal]
 * @property {(delta: string) => void} [onToken]
 * @property {number} [temperature]
 */

/**
 * @typedef {object} EngineResponse
 * @property {string} text
 * @property {{id: string, name: string, args: any}[]} toolCalls
 * @property {string} finishReason
 * @property {string} engineId
 */

/**
 * Wrap a provider (local Ollama / Groq / custom) as a Javelin engine.
 * This is the adaptor that keeps `providers.js` as the transport while Javelin
 * owns everything above it.
 */
export function providerEngine(provider, { id, label, capabilities = [], model } = {}) {
  return {
    id: id ?? provider.id,
    label: label ?? provider.label,
    capabilities,
    async probe() {
      try {
        const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
          signal: AbortSignal.timeout(1500),
        })
        return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` }
      } catch (err) {
        return { ok: false, detail: err.message }
      }
    },
    async generate(req) {
      const result = await streamCompletion({
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: model ?? provider.defaultModel,
        messages: req.messages,
        tools: req.tools,
        signal: req.signal,
        temperature: req.temperature,
        onToken: req.onToken,
      })
      return {
        text: result.content ?? '',
        toolCalls: result.toolCalls ?? [],
        finishReason: result.finishReason ?? 'stop',
        engineId: id ?? provider.id,
      }
    },
  }
}

/**
 * A scripted engine. Used by the test suite to drive the brain deterministically,
 * and useful as a dry-run mode: it proves the *system* works without needing a
 * model installed.
 */
export function scriptedEngine(steps) {
  let call = 0
  return {
    id: 'scripted',
    label: 'Scripted (deterministic)',
    capabilities: [CAPABILITY.TOOLS, CAPABILITY.OFFLINE],
    async probe() {
      return { ok: true, detail: 'deterministic engine, always available' }
    },
    async generate(req) {
      const step = steps[Math.min(call, steps.length - 1)]
      call++
      if (typeof step === 'function') {
        return step(req)
      }
      return {
        text: step.text ?? '',
        toolCalls: step.toolCalls ?? [],
        finishReason: step.finishReason ?? (step.toolCalls?.length ? 'tool_calls' : 'stop'),
        engineId: 'scripted',
      }
    },
  }
}

/**
 * The registry. Javelin holds a set of engines, tracks which is primary for a
 * given *role* (planning vs coding vs review), and can degrade gracefully when an
 * engine is unavailable.
 */
export class EngineRegistry {
  constructor() {
    /** @type {Map<string, EngineDescriptor>} */
    this.engines = new Map()
    /** @type {Map<string, string>} role -> engine id */
    this.roles = new Map()
    this.primaryId = null
    this.health = new Map()
  }

  register(engine) {
    this.engines.set(engine.id, engine)
    if (!this.primaryId) {
      this.primaryId = engine.id
    }
    return this
  }

  /** Assign an engine to a role: 'primary' | 'plan' | 'code' | 'review'. */
  assign(role, engineId) {
    if (!this.engines.has(engineId)) {
      throw new Error(`Cannot assign unknown engine "${engineId}" to role "${role}"`)
    }
    this.roles.set(role, engineId)
    if (role === 'primary') {
      this.primaryId = engineId
    }
    return this
  }

  /** Resolve the engine for a role, degrading to primary then any engine. */
  resolve(role = 'primary') {
    const id = this.roles.get(role) ?? this.primaryId
    const engine = this.engines.get(id) ?? this.engines.values().next().value
    if (!engine) {
      throw new Error('No inference engine is registered.')
    }
    return engine
  }

  list() {
    return [...this.engines.values()].map((e) => ({
      id: e.id,
      label: e.label,
      capabilities: e.capabilities,
      health: this.health.get(e.id) ?? null,
      roles: [...this.roles.entries()].filter(([, v]) => v === e.id).map(([r]) => r),
    }))
  }

  async probeAll() {
    const results = {}
    for (const engine of this.engines.values()) {
      const res = await engine.probe().catch((err) => ({ ok: false, detail: err.message }))
      this.health.set(engine.id, res)
      results[engine.id] = res
    }
    return results
  }

  /** Healthiest available engine, preferring the requested role. */
  async bestAvailable(role = 'primary') {
    if (this.health.size === 0) {
      await this.probeAll()
    }
    const preferred = this.resolve(role)
    if (this.health.get(preferred.id)?.ok !== false) {
      return preferred
    }
    for (const engine of this.engines.values()) {
      if (this.health.get(engine.id)?.ok) {
        return engine
      }
    }
    return preferred
  }

  has(id) {
    return this.engines.has(id)
  }
}

/** Default registry: the configured provider as primary, plus a deterministic dry-run engine. */
export function createDefaultRegistry({ provider, model, apiKey }) {
  const registry = new EngineRegistry()
  registry.register(
    providerEngine(
      { ...provider, apiKey },
      {
        id: 'javelin-local',
        label: `${provider.label} engine`,
        model,
        capabilities: provider.requiresKey
          ? [CAPABILITY.TOOLS, CAPABILITY.STRONG_REASONING]
          : [CAPABILITY.TOOLS, CAPABILITY.OFFLINE],
      },
    ),
  )
  registry.assign('primary', 'javelin-local')
  return registry
}
