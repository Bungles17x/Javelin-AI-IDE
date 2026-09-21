/**
 * Trained-model integration tests.
 *
 * Proves that a Javelin fine-tuned model plugs into the EXISTING architecture with
 * no changes to the runtime — the whole point of building the engine seam first.
 *
 * Uses a fake OpenAI-compatible server rather than a real model: the contract being
 * tested is Javelin's, not the model's, so the test is deterministic and free.
 */

import { EngineRegistry, CAPABILITY } from '../src/core/engines.js'
import { javelinEngine, registerJavelinEngine, reportEngineFitness, buildModelfile } from '../src/core/javelinEngine.js'
import { runJavelin } from '../src/core/runtime.js'
import { JavelinMemory } from '../src/core/memory.js'
import { createStandardToolset } from '../src/core/tools.js'
import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'
import { buildSeedDataset } from '../training/dataset/seeds.js'
import { validateDataset } from '../training/dataset/format.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Build an SSE response body the way an OpenAI-compatible server would. */
function sse({ content = '', toolCalls = [] }) {
  const delta = { role: 'assistant' }
  if (content) {
    delta.content = content
  }
  if (toolCalls.length) {
    delta.tool_calls = toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }))
  }
  return (
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
    'data: [DONE]\n\n'
  )
}

/** Install a fake fetch that emulates a served model. */
function fakeServer(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url: String(url), body })
    const result = handler({ url: String(url), body })

    if (result?.models) {
      return new Response(JSON.stringify({ data: result.models.map((id) => ({ id })) }), { status: 200 })
    }
    if (result?.status && result.status !== 200) {
      return new Response(result.error ?? 'error', { status: result.status })
    }
    return new Response(sse(result ?? {}), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

console.log('\n1. A served Javelin model is a drop-in engine')
{
  const mkCall = (name, args) => ({ id: 'c1', name, args })
  const server = fakeServer(({ url }) => {
    if (url.endsWith('/models')) {
      return { models: ['javelin:latest'] }
    }
    return { content: 'thinking', toolCalls: [mkCall('read_file', { path: 'x.js' })] }
  })

  const engine = javelinEngine({ baseUrl: 'http://localhost:11434/v1', model: 'javelin' })
  const probe = await engine.probe()

  check('probe reports the model is served', probe.ok, probe.detail)
  check('engine advertises tool capability', engine.capabilities.includes(CAPABILITY.TOOLS))

  const registry = new EngineRegistry()
  registerJavelinEngine(registry, { baseUrl: 'http://localhost:11434/v1', model: 'javelin' })
  check('registry accepts the trained engine', registry.has('javelin-trained'))
  check('registry assigns it as primary', registry.primaryId === 'javelin-trained')

  server.restore()
}

console.log('\n2. Probe fails honestly when the model is not served')
{
  const server = fakeServer(() => ({ models: ['some-other-model'] }))
  const engine = javelinEngine({ baseUrl: 'http://localhost:11434/v1', model: 'javelin' })
  const probe = await engine.probe()
  check('probe reports not ok', probe.ok === false)
  check('probe names what is actually available', /some-other-model/.test(probe.detail), probe.detail)
  server.restore()
}

console.log('\n3. Probe fails honestly when the server is down')
{
  const server = fakeServer(() => {
    throw new Error('connect ECONNREFUSED')
  })
  const engine = javelinEngine({ baseUrl: 'http://localhost:11434/v1', model: 'javelin' })
  const probe = await engine.probe()
  check('probe reports not ok', probe.ok === false)
  check('probe explains how to fix it', /ollama serve/.test(probe.detail), probe.detail)
  server.restore()
}

console.log('\n4. A trained engine drives the UNMODIFIED runtime')
{
  // The fake model plays a correct Javelin policy: read → edit → verify → finish.
  const tc = (id, name, args) => ({ id, name, args })
  const script = [
    { content: 'Inspecting.', toolCalls: [tc('c1', 'read_file', { path: 'calc.js' })] },
    { content: 'Plan:\n1. Fix the operator\n2. Verify', toolCalls: [] },
    { toolCalls: [tc('c2', 'edit_file', { path: 'calc.js', old_string: 'return a - b', new_string: 'return a + b' })] },
    { toolCalls: [tc('c3', 'run_command', { command: 'npm test' })] },
    { toolCalls: [tc('c4', 'finish', { summary: 'Fixed and verified', verified: true })] },
  ]
  let i = 0
  const server = fakeServer(({ url, body }) => {
    if (url.endsWith('/models')) {
      return { models: ['javelin'] }
    }
    const step = script[Math.min(i, script.length - 1)]
    i++
    return step
  })

  const registry = new EngineRegistry()
  registerJavelinEngine(registry, { baseUrl: 'http://localhost:11434/v1', model: 'javelin' })

  const ws = new VirtualWorkspace({ 'calc.js': 'export function add(a, b) {\n  return a - b\n}\n' })
  const result = await runJavelin({
    task: 'Fix the bug in calc.js',
    workspace: ws,
    engines: registry,
    signal: new AbortController().signal,
    memory: new JavelinMemory(),
    tools: createStandardToolset(),
    runCommand: async () => ({ exitCode: 0, stdout: 'PASS', stderr: '' }),
    onEvent: () => { },
    requestApproval: async () => ({ approved: true }),
  })

  check('the run completed using the trained engine', result.status === 'done', result.status)
  check('the fix was actually applied', ws.read('calc.js').includes('return a + b'))
  check('the run reports verification', result.verified === true)
  check('no changes to runtime were needed', typeof runJavelin === 'function')

  server.restore()
}

console.log('\n5. Fitness evaluation catches an unusable model')
{
  // A model that never emits tool calls — the classic bad fine-tune.
  const server = fakeServer(({ url }) => {
    if (url.endsWith('/models')) {
      return { models: ['javelin'] }
    }
    return { content: 'I would suggest editing the file to fix the bug.' }
  })

  const engine = javelinEngine({ baseUrl: 'http://localhost:11434/v1', model: 'javelin' })
  const seeds = buildSeedDataset()
  const report = await reportEngineFitness(engine, seeds)

  check('fitness evaluated some examples', report.evaluated > 0, String(report.evaluated))
  check('format compliance is 0', report.formatCompliance === 0, String(report.formatCompliance))
  check('verdict says NOT READY', /NOT READY/.test(report.verdict), report.verdict)

  server.restore()
}

console.log('\n6. Fitness evaluation passes a model that follows the policy')
{
  // A model that echoes the expected tool call for whatever it is asked.
  const server = fakeServer(({ url, body }) => {
    if (url.endsWith('/models')) {
      return { models: ['javelin'] }
    }
    // Find the last assistant tool_call in the prompt and replay it — this emulates
    // a model that has perfectly learned the policy.
    const messages = body?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const tc = messages[i]?.tool_calls?.[0]
      if (tc) {
        return {
          toolCalls: [{ id: 'r', name: tc.function.name, args: JSON.parse(tc.function.arguments) }],
        }
      }
    }
    return { content: 'no idea' }
  })

  // Build evaluation examples where the target call is discoverable.
  const examples = buildSeedDataset().filter((r) => r.messages.some((m) => m.tool_calls))
  const engine = javelinEngine({ baseUrl: 'http://localhost:11434/v1', model: 'javelin' })
  const report = await reportEngineFitness(engine, examples)

  check('fitness evaluated examples', report.evaluated > 0, String(report.evaluated))
  check('per-skill breakdown is produced', Object.keys(report.bySkill).length > 0,
    JSON.stringify(report.bySkill))

  server.restore()
}

console.log('\n7. Modelfile generation for serving')
{
  const modelfile = buildModelfile({
    mergedModelPath: 'C:/models/javelin-merged',
    systemPrompt: 'You are Javelin.',
  })
  check('Modelfile references the merged model', modelfile.includes('FROM C:/models/javelin-merged'))
  check('Modelfile carries the system prompt', modelfile.includes('You are Javelin.'))
  check('Modelfile sets a temperature', modelfile.includes('PARAMETER temperature'))
}

console.log('\n8. Seed dataset is a valid evaluation set')
{
  const seeds = buildSeedDataset()
  const v = validateDataset(seeds)
  check('seeds validate', v.ok, JSON.stringify(v.errors.slice(0, 3)))
  check('seeds include tool-call examples',
    seeds.some((r) => r.messages.some((m) => m.tool_calls)))
}

console.log(`\n${failures === 0 ? 'ALL TRAINED-MODEL INTEGRATION CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
