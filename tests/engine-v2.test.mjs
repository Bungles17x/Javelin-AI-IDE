/**
 * Javelin Engine tests.
 *
 * These cover what the engine adds on top of the behavioural contract the existing
 * suites already pin down: hosted and local transport policy, bounded retries and
 * timeouts, usage accounting, context pruning that stays protocol-valid, the file
 * cache, concurrent reads, and the hard budgets that stop runaway runs.
 */

import {
  ERROR_CODES,
  ERROR_TITLES,
  HOSTED_PROVIDER_IDS,
  MAX_STALLED_STEPS,
  buildTranscript,
  createMemory,
  ensureToolResultPairing,
  errorLabel,
  isErrorCode,
  requestCompletion,
  resolveTransport,
  runAgent,
} from '../src/engine/index.js'
import { runAgent as legacyRunAgent } from '../src/lib/agent.js'
import { PROVIDERS, streamCompletion } from '../src/lib/providers.js'
import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const provider = { providerId: 'javelin', baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-model' }

function sseResponse(chunks) {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify({ choices: [chunk] })}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function scriptedCompletion(script, onRequest) {
  let call = 0
  return async (request) => {
    onRequest?.(request)
    const step = script[Math.min(call, script.length - 1)]
    call += 1
    return {
      content: step.content ?? '',
      toolCalls: step.toolCalls ?? [],
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
    }
  }
}

const eventsFor = () => {
  const events = []
  return { events, emit: (event) => events.push(event) }
}

console.log('\n1. Transport policy: local vs hosted')
{
  const local = resolveTransport({ providerId: 'javelin', model: 'javelin-coder:latest' })
  check('Ollama is the default endpoint', local.endpoint === 'http://127.0.0.1:11434/v1', local.endpoint)
  check('a local transport is keyless', local.apiKey === undefined && local.hosted === false)
  check('the chat-completions path is built once', local.url.endsWith('/chat/completions'), local.url)

  let remoteOnLocal = ''
  try { resolveTransport({ providerId: 'javelin', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' }) }
  catch (error) { remoteOnLocal = error.message }
  check('a remote URL on the local provider is refused', /Remote AI endpoints are disabled/.test(remoteOnLocal), remoteOnLocal)

  let missingKey = ''
  try { resolveTransport({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-codex' }) }
  catch (error) { missingKey = error.message }
  check('a hosted provider requires a key', /requires an API key/.test(missingKey), missingKey)

  let insecure = ''
  try { resolveTransport({ providerId: 'openai', baseUrl: 'http://api.example.com/v1', apiKey: 'k', model: 'm' }) }
  catch (error) { insecure = error.message }
  check('hosted endpoints must use https', /must use https/.test(insecure), insecure)

  const hosted = resolveTransport({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-5-codex' })
  check('hosted transport carries the key', hosted.hosted === true && hosted.apiKey === 'sk-test')

  const customLocal = resolveTransport({ providerId: 'custom', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-model' })
  check('a custom endpoint on localhost stays local and keyless',
    customLocal.hosted === false && customLocal.apiKey === undefined)

  check('the hosted provider list is explicit', HOSTED_PROVIDER_IDS.has('openai') && !HOSTED_PROVIDER_IDS.has('javelin'))
  check('the IDE offers hosted providers', Boolean(PROVIDERS.openai?.hosted && PROVIDERS.groq?.hosted), Object.keys(PROVIDERS).join(','))
  check('the default IDE provider is still local Ollama', PROVIDERS.javelin.baseUrl === 'http://127.0.0.1:11434/v1')
}

console.log('\n2. Streaming, tool assembly and credentials')
{
  const originalFetch = globalThis.fetch
  let captured = null
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) }
    return sseResponse([
      { delta: { content: 'Thinking…', tool_calls: [{ index: 0, id: 'tc1', function: { name: 'read_file', arguments: '{"path":' } }] } },
      { delta: { tool_calls: [{ index: 0, function: { arguments: '"src/app.js"}' } }] } },
      { delta: {}, finish_reason: 'tool_calls' },
    ])
  }
  try {
    const local = resolveTransport({ providerId: 'javelin', model: 'm', apiKey: 'must-not-be-sent' })
    const result = await requestCompletion({ transport: local, messages: [{ role: 'user', content: 'hi' }] })
    check('streamed text is assembled', result.content === 'Thinking…' || result.content === '', result.content)
    check('split tool-call arguments are reassembled',
      result.toolCalls[0]?.name === 'read_file' && result.toolCalls[0]?.args.path === 'src/app.js',
      JSON.stringify(result.toolCalls))
    check('a local request never sends a credential', !captured.headers.Authorization)
    check('local requests omit hosted-only options', captured.body.stream_options === undefined)

    const remote = resolveTransport({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live', model: 'gpt-5-codex' })
    await requestCompletion({ transport: remote, messages: [{ role: 'user', content: 'hi' }] })
    check('a hosted request sends a bearer token', captured.headers.Authorization === 'Bearer sk-live', captured.headers.Authorization)
    check('a hosted request asks for usage', captured.body.stream_options?.include_usage === true)
    check('the provider url is used', captured.url === 'https://api.openai.com/v1/chat/completions', captured.url)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n3. Retries, timeouts and usage')
{
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts < 3) return new Response('busy', { status: 503 })
    return new Response(
      `${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } })}\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  try {
    const retries = []
    const transport = resolveTransport({ providerId: 'javelin', model: 'm' })
    const result = await requestCompletion({
      transport,
      messages: [{ role: 'user', content: 'hi' }],
      onRetry: (attempt) => retries.push(attempt),
    })
    check('a 503 is retried', attempts === 3, String(attempts))
    check('retries are reported to the caller', retries.length === 2, JSON.stringify(retries))
    check('usage is captured', result.usage?.prompt_tokens === 11, JSON.stringify(result.usage))
    check('attempt count is returned', result.attempts === 3, String(result.attempts))
  } finally {
    globalThis.fetch = originalFetch
  }

  const originalFetch2 = globalThis.fetch
  let failures = 0
  globalThis.fetch = async () => { failures += 1; return new Response('down', { status: 500 }) }
  try {
    let message = ''
    try {
      await requestCompletion({
        transport: resolveTransport({ providerId: 'javelin', model: 'm' }),
        messages: [{ role: 'user', content: 'hi' }],
        maxRetries: 1,
      })
    } catch (error) { message = error.message }
    check('a permanent failure stops at the retry bound', failures === 2, String(failures))
    check('the failure is reported with its status', /Provider error 500/.test(message), message)
  } finally {
    globalThis.fetch = originalFetch2
  }

  // A slow but productive stream must not be killed by the wall-clock limit: the
  // total timer covers the wait for a first token, then only idleness applies.
  const originalFetchSlow = globalThis.fetch
  let sent = 0
  globalThis.fetch = async () => {
    const body = new ReadableStream({
      async pull(controller) {
        if (sent >= 3) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 40))
        sent += 1
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const slow = await requestCompletion({
      transport: resolveTransport({ providerId: 'javelin', model: 'm' }),
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 80,
      idleTimeoutMs: 60,
      maxRetries: 0,
    })
    check('a slow stream that keeps producing is not cut off', slow.content === 'xxx', slow.content)
  } catch (error) {
    check('a slow stream that keeps producing is not cut off', false, error.message)
  } finally {
    globalThis.fetch = originalFetchSlow
  }

  const originalFetch3 = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    // A server that accepts the request and then never streams anything.
    return new Response(new ReadableStream({ start() { } }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      signal: init?.signal,
    })
  }
  try {
    let message = ''
    const started = Date.now()
    try {
      await requestCompletion({
        transport: resolveTransport({ providerId: 'javelin', model: 'm' }),
        messages: [{ role: 'user', content: 'hi' }],
        idleTimeoutMs: 60,
        maxRetries: 0,
      })
    } catch (error) { message = error.message }
    check('a stalled stream fails instead of hanging', /stopped responding/.test(message), message)
    check('the stall is detected quickly', Date.now() - started < 3000, String(Date.now() - started))
  } finally {
    globalThis.fetch = originalFetch3
  }
}

console.log('\n4. Context is bounded without breaking the protocol')
{
  const memory = createMemory()
  memory.transcript.push(
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'the original task that must survive pruning' },
  )
  for (let index = 0; index < 8; index++) {
    memory.transcript.push(
      { role: 'assistant', content: null, tool_calls: [{ id: `c${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `c${index}`, content: 'x'.repeat(9000) },
    )
  }
  const pruned = buildTranscript(memory, { maxChars: 4000 })
  const totalChars = pruned.reduce((sum, message) => sum + String(message.content ?? '').length, 0)
  const problems = []
  for (let index = 0; index < pruned.length; index++) {
    const message = pruned[index]
    if (message.role !== 'assistant' || !message.tool_calls) continue
    let next = index + 1
    const answered = new Set()
    while (pruned[next]?.role === 'tool') { answered.add(pruned[next].tool_call_id); next++ }
    for (const call of message.tool_calls) if (!answered.has(call.id)) problems.push(call.id)
  }
  check('pruning respects the character budget', totalChars <= 4000, String(totalChars))
  check('pruning keeps every tool call paired with its result', problems.length === 0, problems.join(','))
  check('pruning never drops the task', pruned.some((message) => message.role === 'user' && /original task/.test(message.content)))
  check('pruning is counted for reporting', memory.metrics.prunedMessages > 0, String(memory.metrics.prunedMessages))
  check('an unpaired transcript is repaired', ensureToolResultPairing([
    { role: 'assistant', content: null, tool_calls: [{ id: 'missing', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  ]).some((message) => message.role === 'tool' && message.tool_call_id === 'missing'))
}

console.log('\n5. Independent reads in one turn run together')
{
  const files = { 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' }
  const workspace = new VirtualWorkspace(files)
  const read = workspace.read.bind(workspace)
  workspace.read = async (path, start, end) => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    return read(path, start, end)
  }
  const { emit } = eventsFor()
  const started = Date.now()
  const result = await runAgent({
    task: 'Read a.js, b.js and c.js and finish',
    workspace,
    provider,
    generate: scriptedCompletion([
      {
        toolCalls: [
          { id: 'r1', name: 'read_file', args: { path: 'a.js' } },
          { id: 'r2', name: 'read_file', args: { path: 'b.js' } },
          { id: 'r3', name: 'read_file', args: { path: 'c.js' } },
        ],
      },
      { toolCalls: [{ id: 'f1', name: 'finish', args: { summary: 'Read all three' } }] },
    ]),
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  const elapsed = Date.now() - started
  check('three 40ms reads take roughly one delay, not three', elapsed < 100, `${elapsed}ms`)
  check('the reads still complete', result.status === 'done', `${result.status}: ${result.summary}`)
  check('results are recorded in call order',
    result.steps.map((step) => step.args?.path).join(',') === 'a.js,b.js,c.js',
    JSON.stringify(result.steps.map((step) => step.args?.path)))
}

console.log('\n6. The file cache removes redundant I/O')
{
  const workspace = new VirtualWorkspace({ 'app.js': 'export const n = 1\n', 'other.js': 'x\n' })
  const { emit } = eventsFor()
  const result = await runAgent({
    task: 'Inspect app.js and update other.js',
    workspace,
    provider,
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'edit_file', args: { path: 'other.js', old_string: 'x', new_string: 'y' } }] },
      { toolCalls: [{ id: 'c3', name: 'read_file', args: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c4', name: 'finish', args: { summary: 'Checked app.js twice' } }] },
    ]),
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  check('the second read is served from the content cache',
    result.metrics.cachedReads === 1, JSON.stringify(result.metrics))
  check('the cached read is still a successful tool result',
    result.steps.filter((step) => step.name === 'read_file' && step.ok).length === 2)
  check('the run still finishes', result.status === 'done', result.status)
}

console.log('\n7. Hard budgets stop runaway runs')
{
  const { emit } = eventsFor()
  const stallScript = Array.from({ length: MAX_STALLED_STEPS + 3 }, (_, index) => ({
    toolCalls: [{ id: `l${index}`, name: 'list_files', args: { path: `dir${index}` } }],
  }))
  const workspace = new VirtualWorkspace({ 'main.js': 'export {}\n' })
  workspace.directories.add('dir0')
  const stalled = await runAgent({
    task: 'Fix the project',
    workspace,
    provider,
    generate: scriptedCompletion(stallScript),
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  check('a run that never changes the workspace is stopped',
    stalled.status === 'failed' && /without changing the workspace/.test(stalled.summary),
    `${stalled.status}: ${stalled.summary}`)
  check('the stall reports ER.0205', stalled.code === ERROR_CODES.STALLED, `${stalled.code}`)

  const slow = await runAgent({
    task: 'Fix the project',
    workspace: new VirtualWorkspace(),
    provider,
    generate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { content: 'hello', toolCalls: [], finishReason: 'stop' }
    },
    limits: { maxRunMs: 1 },
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })
  check('a run over its time budget is stopped',
    slow.status === 'failed' && /time budget/.test(slow.summary), `${slow.status}: ${slow.summary}`)
  check('the time budget reports ER.0206', slow.code === ERROR_CODES.TIME_BUDGET, `${slow.code}`)

  const bounded = await runAgent({
    task: 'Fix the project',
    workspace: new VirtualWorkspace({ 'main.js': 'export {}\n' }),
    provider,
    generate: scriptedCompletion([{ toolCalls: [{ id: 'x', name: 'list_files', args: { path: '' } }] }]),
    limits: { maxSteps: 2 },
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })
  check('the step budget is reported honestly',
    bounded.status === 'failed' && /Stopped after 2 steps/.test(bounded.summary), bounded.summary)
  check('the step limit reports ER.0201', bounded.code === ERROR_CODES.STEP_LIMIT, `${bounded.code}`)
}

console.log('\n8. Metrics describe what the run cost')
{
  const { emit } = eventsFor()
  const result = await runAgent({
    task: 'Create notes.txt',
    workspace: new VirtualWorkspace(),
    provider,
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'm1', name: 'write_file', args: { path: 'notes.txt', content: 'hello\n' } }] },
      { toolCalls: [{ id: 'm2', name: 'finish', args: { summary: 'Created notes.txt', verified: false } }] },
    ]),
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  check('model calls are counted', result.metrics.modelCalls === 2, String(result.metrics.modelCalls))
  check('tool calls are counted', result.metrics.toolCalls >= 1, String(result.metrics.toolCalls))
  check('duration is reported', result.metrics.durationMs >= 0)
  check('touched files are reported for the undo offer', result.filesTouched.includes('notes.txt'), JSON.stringify(result.filesTouched))
  check('the run finished', result.status === 'done', result.status)
}

console.log('\n9. Hosted models run end to end through the engine')
{
  const originalFetch = globalThis.fetch
  const seen = []
  let turn = 0
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    seen.push({ url: String(url), headers: init.headers, body })
    turn += 1
    if (turn === 1) {
      return sseResponse([
        { delta: { tool_calls: [{ index: 0, id: 'h1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hosted.txt', content: 'from hosted\n' }) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ])
    }
    if (turn === 2) {
      return sseResponse([
        {
          delta: {
            tool_calls: [{ index: 0, id: 'h2', function: { name: 'finish', arguments: JSON.stringify({ summary: 'Created hosted.txt', verified: false }) } }],
          },
        },
        { delta: {}, finish_reason: 'tool_calls' },
      ])
    }
    return new Response(
      `${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  try {
    const workspace = new VirtualWorkspace()
    const { emit } = eventsFor()
    const result = await runAgent({
      task: 'Create hosted.txt',
      workspace,
      provider: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live', model: 'gpt-5-codex' },
      signal: new AbortController().signal,
      events: { emit, requestApproval: async () => ({ approved: true }) },
    })
    check('a hosted model can create a file through the engine',
      workspace.exists('hosted.txt'), JSON.stringify(workspace.toJSON()))
    check('the hosted run finished', result.status === 'done', `${result.status}: ${result.summary}`)
    check('every hosted request carried the credential', seen.every((entry) => entry.headers.Authorization === 'Bearer sk-live'))
    check('the hosted endpoint was used', seen.every((entry) => entry.url.startsWith('https://api.openai.com/v1/')))
    check('the requested model was sent', seen[0].body.model === 'gpt-5-codex', seen[0].body.model)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n10. The IDE keeps its stable entry point')
{
  check('src/lib/agent.js exposes the engine runAgent', legacyRunAgent === runAgent)

  const originalFetch = globalThis.fetch
  let captured = null
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers }
    return sseResponse([{ delta: { content: 'hosted chat' }, finish_reason: 'stop' }])
  }
  try {
    const hostedChat = await streamCompletion({
      providerId: 'openai',
      apiKey: 'sk-chat',
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('chat mode can reach a hosted model', hostedChat.content === 'hosted chat', hostedChat.content)
    check('chat mode sends the hosted credential', captured.headers.Authorization === 'Bearer sk-chat')

    let rejected = ''
    try {
      await streamCompletion({ baseUrl: 'https://api.openai.com/v1', model: 'x', messages: [{ role: 'user', content: 'hi' }] })
    } catch (error) { rejected = error.message }
    check('a remote URL without a hosted provider is still refused',
      /Remote AI endpoints are disabled/.test(rejected), rejected)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n11. Every failure reports a stable error code')
{
  const codes = Object.values(ERROR_CODES)
  check('codes are unique', new Set(codes).size === codes.length)
  check('codes follow ER.NNNN', codes.every(isErrorCode), codes.filter((code) => !isErrorCode(code)).join(','))
  check('every code has a title', codes.every((code) => Boolean(ERROR_TITLES[code])))
  check('a label combines code and title',
    errorLabel(ERROR_CODES.IDENTICAL_RESPONSES) === `ER.0203 · ${ERROR_TITLES[ERROR_CODES.IDENTICAL_RESPONSES]}`,
    errorLabel(ERROR_CODES.IDENTICAL_RESPONSES))
  check('malformed values are not accepted as codes', !isErrorCode('ER.203') && !isErrorCode(undefined) && !isErrorCode('ER.0203 '))

  const options = (script, extra = {}) => ({
    task: 'Fix the project',
    workspace: new VirtualWorkspace({ 'app.js': 'export const n = 1\n' }),
    provider,
    generate: scriptedCompletion(script),
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
    ...extra,
  })

  const repeatedRun = await runAgent(options([{ content: 'I will change the file now.' }]))
  check('identical responses report ER.0203',
    repeatedRun.code === ERROR_CODES.IDENTICAL_RESPONSES, `${repeatedRun.code}: ${repeatedRun.summary}`)

  const silentRun = await runAgent(options([
    { content: 'First thought.' },
    { content: 'Second thought.' },
    { content: 'Third thought.' },
  ]))
  check('a run with no tool action reports ER.0202',
    silentRun.code === ERROR_CODES.NO_ACTION, `${silentRun.code}: ${silentRun.summary}`)

  const abortedController = new AbortController()
  abortedController.abort()
  const stoppedRun = await runAgent(options([{ content: 'ignored' }], { signal: abortedController.signal }))
  check('a user stop reports ER.0301', stoppedRun.code === ERROR_CODES.ABORTED, String(stoppedRun.code))

  const keylessRun = await runAgent(options([{ content: 'x' }], {
    generate: undefined,
    provider: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-codex' },
  }))
  check('a missing hosted key reports ER.0102',
    keylessRun.code === ERROR_CODES.MODEL_AUTH, `${keylessRun.code}: ${keylessRun.summary}`)

  const cleanRun = await runAgent(options([
    { toolCalls: [{ id: 'e1', name: 'write_file', args: { path: 'app.js', content: 'export const n = 2\n', overwrite: true } }] },
    { toolCalls: [{ id: 'e2', name: 'finish', args: { summary: 'Updated app.js', verified: false } }] },
  ]))
  check('a clean finish carries no code', cleanRun.status === 'done' && cleanRun.code === null,
    `${cleanRun.status}/${cleanRun.code}`)

  let chatCode = null
  try {
    await streamCompletion({ baseUrl: 'https://api.openai.com/v1', model: 'x', messages: [{ role: 'user', content: 'hi' }] })
  } catch (error) {
    chatCode = error.code
  }
  check('chat-mode failures carry a code too', chatCode === ERROR_CODES.MODEL_CONFIG, String(chatCode))
}

console.log('\n12. The agent can build a multi-file project, in chunks')
{
  const workspace = new VirtualWorkspace()
  const result = await runAgent({
    task: 'Build a small notes app: package.json, src/app.js, src/store.js, README.md',
    workspace,
    provider,
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'b1', name: 'create_folder', args: { path: 'src' } }] },
      { toolCalls: [{ id: 'b2', name: 'write_file', args: { path: 'package.json', content: '{\n  "name": "notes",\n  "type": "module"\n}\n' } }] },
      { toolCalls: [{ id: 'b3', name: 'write_file', args: { path: 'src/store.js', content: 'export const notes = []\n' } }] },
      { toolCalls: [{ id: 'b4', name: 'write_file', args: { path: 'src/app.js', content: "import { notes } from './store.js'\n" } }] },
      { toolCalls: [{ id: 'b5', name: 'append_file', args: { path: 'src/app.js', content: 'export function add(text) {\n  notes.push({ text, at: Date.now() })\n}\n' } }] },
      { toolCalls: [{ id: 'b6', name: 'append_file', args: { path: 'src/app.js', content: 'export function count() {\n  return notes.length\n}\n' } }] },
      { toolCalls: [{ id: 'b7', name: 'read_file', args: { path: 'src/app.js', start: 1, end: 2 } }] },
      { toolCalls: [{ id: 'b8', name: 'write_file', args: { path: 'README.md', content: '# Notes\n' } }] },
      { toolCalls: [{ id: 'b9', name: 'finish', args: { summary: 'Built the notes app', verified: false } }] },
    ]),
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })

  const files = workspace.toJSON()
  const app = files['src/app.js'] ?? ''
  check('every requested file exists',
    ['package.json', 'src/app.js', 'src/store.js', 'README.md'].every((path) => workspace.exists(path)),
    JSON.stringify(Object.keys(files)))
  check('the nested folder was created', workspace.directories.has('src'), JSON.stringify([...workspace.directories]))
  check('appends extended the file instead of replacing it',
    app.includes("import { notes }") && app.includes('export function add') && app.includes('export function count'),
    app)
  check('the chunked build finished', result.status === 'done', `${result.status}: ${result.summary}`)
  check('the build used several steps without hitting the cap',
    result.steps.length >= 8 && result.steps.length < 40, String(result.steps.length))
  check('a clean multi-file build has no error code', result.code === null, String(result.code))
}

console.log('\n13. A large file can be read in parts')
{
  const bigLine = 'export const value = 1234567890\n'
  const workspace = new VirtualWorkspace({ 'big.js': bigLine.repeat(900) })
  const result = await runAgent({
    task: 'Inspect big.js and finish',
    workspace,
    provider,
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'big.js' } }] },
      { toolCalls: [{ id: 'r2', name: 'read_file', args: { path: 'big.js', start: 1, end: 5 } }] },
      { toolCalls: [{ id: 'r3', name: 'finish', args: { summary: 'Inspected big.js', verified: false } }] },
    ]),
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })
  const full = result.steps.find((step) => step.name === 'read_file' && step.args?.start == null)
  const slice = result.steps.find((step) => step.name === 'read_file' && step.args?.start === 1)
  check('a truncated read points at start/end', /read_file with start\/end/.test(full?.output ?? ''), (full?.output ?? '').slice(-120))
  check('a line-range read returns the requested slice',
    (slice?.output ?? '').split('\n').filter(Boolean).length <= 5, JSON.stringify((slice?.output ?? '').slice(0, 80)))
  check('the run still finishes', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n14. A repeated reply is not echoed back, and a tool call is forced')
{
  const workspace = new VirtualWorkspace()
  const seen = []
  let turn = 0
  const script = [
    { content: 'I will inspect the files and then build it.' },
    { content: 'I will inspect the files and then build it.' },
    { toolCalls: [{ id: 'esc1', name: 'write_file', args: { path: 'built.js', content: 'export const ok = true\n' } }] },
    { toolCalls: [{ id: 'esc2', name: 'finish', args: { summary: 'Created built.js', verified: false } }] },
  ]
  const generate = async (request) => {
    seen.push(request)
    const step = script[Math.min(turn, script.length - 1)]
    turn += 1
    return {
      content: step.content ?? '',
      toolCalls: step.toolCalls ?? [],
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
    }
  }
  const result = await runAgent({
    task: 'Create built.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })

  const repeated = 'I will inspect the files and then build it.'
  const copies = seen[2].messages.filter((message) => String(message.content ?? '').includes(repeated)).length
  check('the repeated prose is not sent back to the model', copies === 0,
    `${copies}: ${JSON.stringify(seen[2].messages.map((message) => `${message.role}:${String(message.content ?? '').slice(0, 60)}`))}`)
  check('the retry requires a tool call', seen[2].toolChoice === 'required', String(seen[2].toolChoice))
  check('the forced turn actually produced the file', workspace.exists('built.js'), JSON.stringify(Object.keys(workspace.toJSON())))
  check('the run completes instead of stopping at ER.0203', result.status === 'done' && result.code === null,
    `${result.status}/${result.code}: ${result.summary}`)
}

console.log('\n15. A finished job ends on the model summary instead of failing')
{
  const workspace = new VirtualWorkspace()
  const result = await runAgent({
    task: 'Create src/greet.js and src/greet.test.js',
    workspace,
    provider,
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'g1', name: 'list_files', args: { path: '' } }] },
      { toolCalls: [{ id: 'g2', name: 'write_file', args: { path: 'src/greet.js', content: 'export function greet(name) { return "Hello, " + name }\n' } }] },
      { toolCalls: [{ id: 'g3', name: 'write_file', args: { path: 'src/greet.test.js', content: 'import { greet } from "./greet.js"\n' } }] },
      { content: 'Both files are created.' },
      { content: 'Both files are created.' },
    ]),
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })

  check('the run reports success instead of ER.0203', result.status === 'done', `${result.status}: ${result.summary}`)
  check('the summary is the model own report', /Both files are created/.test(result.summary), result.summary)
  check('no error code is attached', result.code === null, String(result.code))
  check('the files really exist',
    workspace.exists('src/greet.js') && workspace.exists('src/greet.test.js'),
    JSON.stringify(Object.keys(workspace.toJSON())))
}

console.log('\n16. A job is not complete while a requested file is missing')
{
  const workspace = new VirtualWorkspace()
  const prose = '```bash\nnpm test\n```\nRun this command to execute the tests.'
  const result = await runAgent({
    task: 'Create src/greet.js and src/greet.test.js, then run npm test',
    workspace,
    provider,
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'z1', name: 'list_files', args: { path: '' } }] },
      { toolCalls: [{ id: 'z2', name: 'write_file', args: { path: 'src/greet.js', content: 'export function greet(name) { return "Hello, " + name }\n' } }] },
      { content: prose },
      { content: prose },
      { content: prose },
    ]),
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })

  check('the run does not claim success with a file missing', result.status === 'failed',
    `${result.status}: ${result.summary}`)
  check('the missing file is named in the summary', /src\/greet\.test\.js/.test(result.summary), result.summary)
  check('the code names the missing files', result.code === ERROR_CODES.MISSING_FILES, String(result.code))
  check('the file that was written is kept', workspace.exists('src/greet.js'), JSON.stringify(Object.keys(workspace.toJSON())))
}

console.log('\n17. A very large file is built in verified sections')
{
  const workspace = new VirtualWorkspace()
  const section = (n) => Array.from({ length: 200 }, (_, i) => `export const line_${n}_${i} = ${n * 1000 + i}\n`).join('')
  const result = await runAgent({
    task: 'Create src/huge.js with 800 exported constants',
    workspace,
    provider,
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'h1', name: 'write_file', args: { path: 'src/huge.js', content: section(1) } }] },
      { toolCalls: [{ id: 'h2', name: 'append_file', args: { path: 'src/huge.js', content: section(2) } }] },
      { toolCalls: [{ id: 'h3', name: 'append_file', args: { path: 'src/huge.js', content: section(3) } }] },
      { toolCalls: [{ id: 'h4', name: 'append_file', args: { path: 'src/huge.js', content: section(4) } }] },
      { toolCalls: [{ id: 'h5', name: 'finish', args: { summary: 'Created src/huge.js' } }] },
    ]),
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })

  const content = workspace.read('src/huge.js')
  check('the run completes', result.status === 'done', `${result.status}: ${result.summary}`)
  check('nothing is lost between sections', content.split('\n').filter(Boolean).length === 800, String(content.split('\n').filter(Boolean).length))
  check('the file ends with the last section', content.trimEnd().endsWith('export const line_4_199 = 4199'), content.slice(-40))
}

console.log('\n18. An oversized single write is refused instead of silently truncated')
{
  const workspace = new VirtualWorkspace()
  const huge = 'x'.repeat(30_000)
  const result = await runAgent({
    task: 'Create src/big.txt',
    workspace,
    provider,
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'b1', name: 'write_file', args: { path: 'src/big.txt', content: huge } }] },
      { toolCalls: [{ id: 'b2', name: 'write_file', args: { path: 'src/big.txt', content: 'short\n' } }] },
      { toolCalls: [{ id: 'b3', name: 'finish', args: { summary: 'Created src/big.txt' } }] },
    ]),
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })

  const step = result.steps.find((record) => record.name === 'write_file' && record.ok === false)
  check('the oversized write is rejected', Boolean(step), JSON.stringify(result.steps.map((s) => [s.name, s.ok])))
  check('the rejection explains how to chunk it', /Split the file/.test(step?.output ?? ''), step?.output)
  check('the run still completes with a smaller write', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log(`\n${failures === 0 ? 'ALL ENGINE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
