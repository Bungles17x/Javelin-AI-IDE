/**
 * JavelinEngine — serve a Javelin-trained model as a Javelin engine.
 * ==================================================================
 *
 * This is where the training work connects to the runtime, and it is deliberately
 * thin. `EngineRegistry` already defines the seam: an engine is
 *
 *     { id, label, capabilities, probe(), generate({messages, tools, signal}) }
 *
 * So a fine-tuned model is *just another engine*. That is the architecture paying
 * off — nothing in `runtime.js`, `brain.js`, `tools.js` or `memory.js` changes.
 *
 * A merged Javelin model can be served two ways, both supported here:
 *
 *   1. **Ollama** (`ollama create javelin -f Modelfile`) — simplest, keyless, local.
 *      The adapter speaks the OpenAI-compatible endpoint Ollama exposes.
 *
 *   2. **Any OpenAI-compatible server** — vLLM, TGI, LM Studio. Point `baseUrl` at it.
 *
 * Before serving a merged model, verify it still behaves: `reportEngineFitness()`
 * runs the engine against held-out JDF examples and measures whether it emits the
 * expected tool call. An adapter that regressed is worse than none.
 */

import { CAPABILITY } from './engines.js'
import { streamCompletion } from '../lib/providers.js'

/** Capabilities a Javelin-trained model is expected to have. */
const JAVELIN_CAPABILITIES = [
  CAPABILITY.TOOLS,
  CAPABILITY.OFFLINE,
  CAPABILITY.LONG_CONTEXT,
]

/**
 * Build an engine that talks to a served Javelin model.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl]   default: local Ollama
 * @param {string} opts.model       the served model name, e.g. 'javelin'
 * @param {string} [opts.apiKey]    only if the server requires one
 * @param {string} [opts.id]
 * @param {string} [opts.label]
 * @param {object} [opts.lineage]   which base model + adapter produced this
 */
export function javelinEngine({
  baseUrl = 'http://localhost:11434/v1',
  model = 'javelin',
  apiKey,
  id = 'javelin-trained',
  label = 'Javelin (fine-tuned)',
  lineage = null,
} = {}) {
  return {
    id,
    label,
    capabilities: JAVELIN_CAPABILITIES,
    lineage,

    async probe() {
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
          signal: AbortSignal.timeout(2000),
        })
        if (!res.ok) {
          return { ok: false, detail: `HTTP ${res.status} from ${baseUrl}` }
        }
        const data = await res.json()
        const names = (data?.data ?? []).map((m) => m.id)
        if (names.length && !names.some((n) => n === model || n.startsWith(`${model}:`))) {
          return {
            ok: false,
            detail: `server is up but "${model}" is not loaded (available: ${names.join(', ')})`,
          }
        }
        return { ok: true, detail: `serving ${model}` }
      } catch (err) {
        return {
          ok: false,
          detail: `cannot reach ${baseUrl} (${err.message}). Start the server, e.g. \`ollama serve\`.`,
        }
      }
    },

    async generate(req) {
      const result = await streamCompletion({
        providerId: 'custom',
        baseUrl,
        apiKey,
        model,
        messages: req.messages,
        tools: req.tools,
        signal: req.signal,
        temperature: req.temperature ?? 0.2,
        onToken: req.onToken,
      })
      return {
        text: result.content ?? '',
        toolCalls: result.toolCalls ?? [],
        finishReason: result.finishReason ?? 'stop',
        engineId: id,
      }
    },
  }
}

/**
 * Register a trained Javelin model, optionally as the primary engine.
 * Returns the registry so calls can chain.
 */
export function registerJavelinEngine(registry, opts = {}) {
  const engine = javelinEngine(opts)
  registry.register(engine)
  if (opts.primary !== false) {
    registry.assign('primary', engine.id)
  }
  if (opts.role) {
    registry.assign(opts.role, engine.id)
  }
  return registry
}

/**
 * Evaluate a served model against held-out JDF examples.
 *
 * Measures the two things that actually matter for a coding agent:
 *   - **format compliance**: did it emit a well-formed tool call at all?
 *   - **action match**: was it the *expected* tool with the expected arguments?
 *
 * A model that scores well on neither is not ready to be Javelin's engine, however
 * good it looks in chat.
 *
 * @param {object} engine
 * @param {object[]} examples   JDF sft records (held-out; never train on these)
 * @param {object} [opts]
 */
export async function reportEngineFitness(engine, examples, { limit = 20, verbose = false } = {}) {
  const sft = examples.filter((e) => e.kind === 'sft' && e.messages?.some((m) => m.tool_calls))
  const sample = sft.slice(0, limit)

  const results = []
  let formatOk = 0
  let actionMatch = 0
  const failures = []

  for (const example of sample) {
    // Present everything up to the target action, then see what the model does.
    const targetIndex = example.messages.findIndex((m) => m.tool_calls)
    if (targetIndex === -1) {
      continue
    }
    const prompt = example.messages.slice(0, targetIndex)
    const expected = example.messages[targetIndex].tool_calls[0]

    let response
    try {
      response = await engine.generate({ messages: prompt, tools: example.tools ?? [] })
    } catch (err) {
      failures.push({ id: example.id, reason: `generate() threw: ${err.message}` })
      continue
    }

    const call = response.toolCalls?.[0]
    const hasFormat = Boolean(call?.name)
    if (hasFormat) {
      formatOk++
    }

    let matches = false
    if (hasFormat && call.name === expected.function.name) {
      try {
        const expectedArgs = JSON.parse(expected.function.arguments)
        const actualArgs = call.args ?? {}
        matches = shallowEqual(expectedArgs, actualArgs)
      } catch {
        matches = false
      }
    }
    if (matches) {
      actionMatch++
    } else {
      failures.push({
        id: example.id,
        expected: `${expected.function.name}(${expected.function.arguments})`,
        actual: call ? `${call.name}(${JSON.stringify(call.args)})` : '(no tool call)',
      })
    }

    results.push({ id: example.id, skill: example.skill, formatOk: hasFormat, actionMatch: matches })
  }

  const n = sample.length || 1
  return {
    evaluated: sample.length,
    formatCompliance: +(formatOk / n).toFixed(3),
    actionAccuracy: +(actionMatch / n).toFixed(3),
    bySkill: groupBySkill(results),
    failures: verbose ? failures : failures.slice(0, 5),
    verdict: verdictFor(formatOk / n, actionMatch / n, sample.length),
  }
}

function verdictFor(formatRate, actionRate, count) {
  if (count === 0) {
    return 'No tool-call examples were available to evaluate.'
  }
  if (formatRate < 0.8) {
    return 'NOT READY: the model often fails to emit well-formed tool calls. Train longer or on more tool-selection examples.'
  }
  if (actionRate < 0.5) {
    return 'MARGINAL: tool calls are well-formed but frequently wrong. More edit-precision and repair examples are needed.'
  }
  if (actionRate < 0.75) {
    return 'USABLE: the model demonstrably learned the policy, but review its actions in the loop.'
  }
  return 'GOOD: the model reproduces the expected tool calls on held-out data.'
}

function groupBySkill(results) {
  const out = {}
  for (const r of results) {
    const k = r.skill ?? 'unknown'
    out[k] = out[k] ?? { count: 0, formatOk: 0, actionMatch: 0 }
    out[k].count++
    out[k].formatOk += r.formatOk ? 1 : 0
    out[k].actionMatch += r.actionMatch ? 1 : 0
  }
  for (const v of Object.values(out)) {
    v.formatRate = +(v.formatOk / v.count).toFixed(3)
    v.actionRate = +(v.actionMatch / v.count).toFixed(3)
  }
  return out
}

/** Compare parsed tool arguments, ignoring key order and insignificant spacing. */
function shallowEqual(a, b) {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length) {
    return false
  }
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) {
      return false
    }
    const va = a[ka[i]]
    const vb = b[kb[i]]
    if (!valuesEqual(va, vb)) {
      return false
    }
  }
  return true
}

/** Compare two argument values, normalising whitespace inside strings. */
function valuesEqual(va, vb) {
  if (typeof va === 'string' && typeof vb === 'string') {
    // An edit snippet differing only in whitespace is the same edit in intent;
    // flagging it as a miss would waste the evaluation.
    return normaliseWhitespace(va) === normaliseWhitespace(vb)
  }
  return va === vb
}

function normaliseWhitespace(text) {
  return text.trim().split(/\s+/).join(' ')
}

/**
 * Generate the Ollama Modelfile needed to serve a merged Javelin model.
 * Emitted rather than committed, because it embeds an absolute path.
 */
export function buildModelfile({ mergedModelPath, systemPrompt, temperature = 0.2 }) {
  return `# Javelin model definition — generated, do not hand-edit.
#
# Create the model:
#   ollama create javelin -f Modelfile
#
# Then Javelin serves it as an engine automatically (provider: custom,
# baseUrl http://localhost:11434/v1, model "javelin").

FROM ${mergedModelPath}

PARAMETER temperature ${temperature}
PARAMETER num_ctx 8192
${systemPrompt ? `\nSYSTEM """\n${systemPrompt}\n"""` : ''}
`
}
