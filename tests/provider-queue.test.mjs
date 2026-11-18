import { enqueueProviderRequest } from '../src/lib/providerQueue.js'
import { streamCompletion } from '../src/lib/providers.js'
import { requestCompletion } from '../src/engine/providers.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('\n1. A one-slot provider runs requests in order')
{
  let active = 0
  let maxActive = 0
  const order = []
  const task = (name, delay) => enqueueProviderRequest('javelinclouddirect', async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    order.push(`${name}:start`)
    await wait(delay)
    order.push(`${name}:end`)
    active -= 1
    return name
  })
  const results = await Promise.all([task('first', 30), task('second', 5), task('third', 1)])
  check('all queued requests complete', results.join(',') === 'first,second,third', results.join(','))
  check('never more than one runs at once', maxActive === 1, String(maxActive))
  check('the first request finishes before the next starts',
    order.join(',') === 'first:start,first:end,second:start,second:end,third:start,third:end',
    order.join(','))
}

console.log('\n2. Providers with normal concurrency are not serialized')
{
  let active = 0
  let maxActive = 0
  const task = () => enqueueProviderRequest('openai', async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await wait(20)
    active -= 1
  })
  await Promise.all([task(), task()])
  check('both requests overlap', maxActive === 2, String(maxActive))
}

console.log('\n3. An aborted queued request never reaches the provider')
{
  let ran = false
  const controller = new AbortController()
  const first = enqueueProviderRequest('javelinclouddirect', () => wait(25))
  const aborted = enqueueProviderRequest(
    'javelinclouddirect',
    async () => { ran = true },
    controller.signal,
  )
  controller.abort()
  await first
  let name = ''
  try {
    await aborted
  } catch (error) {
    name = error.name
  }
  check('the aborted request is rejected', name === 'AbortError', name)
  check('the aborted request sends nothing', ran === false)
  const next = await enqueueProviderRequest('javelinclouddirect', async () => 'next')
  check('the queue still works afterwards', next === 'next', next)
}

console.log('\n4. A failed request does not poison the queue')
{
  const failed = enqueueProviderRequest('javelinclouddirect', async () => {
    throw new Error('provider failed')
  })
  let message = ''
  try {
    await failed
  } catch (error) {
    message = error.message
  }
  const next = await enqueueProviderRequest('javelinclouddirect', async () => 'recovered')
  check('the original error is visible', message === 'provider failed', message)
  check('the next request still runs', next === 'recovered', next)
}

console.log('\n5. Chat and Agent share the same provider slot')
{
  const originalFetch = globalThis.fetch
  let active = 0
  let maxActive = 0
  globalThis.fetch = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    const body = new ReadableStream({
      async start(controller) {
        await wait(15)
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ))
        controller.close()
        active -= 1
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    await Promise.all([
      streamCompletion({
        providerId: 'javelinclouddirect',
        model: 'openai-fast',
        messages: [{ role: 'user', content: 'chat reply' }],
      }),
      requestCompletion({
        transport: {
          providerId: 'javelinclouddirect',
          model: 'openai-fast',
          endpoint: 'https://text.pollinations.ai/openai',
          url: 'https://text.pollinations.ai/openai/chat/completions',
          hosted: true,
          keyless: true,
        },
        messages: [{ role: 'user', content: 'agent turn' }],
        maxRetries: 0,
      }),
    ])
    check('chat and agent never contact the provider together', maxActive === 1, String(maxActive))
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n6. A one-slot provider that is still busy is retried')
{
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'Your previous request is still running.' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '0.05' },
      })
    }
    return new Response('data: {"choices":[{"delta":{"content":"after retry"},"finish_reason":"stop"}]}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  try {
    const result = await streamCompletion({
      providerId: 'javelinclouddirect',
      model: 'openai-fast',
      messages: [{ role: 'user', content: 'retry this' }],
    })
    check('the busy request is sent again', calls === 2, String(calls))
    check('the retried request returns its answer', result.content === 'after retry', result.content)
  } finally {
    globalThis.fetch = originalFetch
  }
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
