import worker from '../javelin-cloud/src/index.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Minimal D1 stand-in: only the statements the worker issues. */
function fakeDb(initial = {}) {
  const rows = new Map(Object.entries(initial))
  return {
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) {
          statement.args = args
          return statement
        },
        async run() {
          if (sql.startsWith('CREATE TABLE')) return { success: true }
          const [install, day] = statement.args
          rows.set(`${install}:${day}`, (rows.get(`${install}:${day}`) ?? 0) + 1)
          return { success: true }
        },
        async first() {
          const [install, day] = statement.args
          const count = rows.get(`${install}:${day}`)
          return count === undefined ? null : { count }
        },
      }
      return statement
    },
  }
}

function baseEnv(overrides = {}) {
  return { UPSTREAM_KEY: 'test-key', DB: fakeDb(), DAILY_LIMIT: '2', ...overrides }
}

const originalFetch = globalThis.fetch

function installUpstream() {
  let seen = null
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options }
    return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  return () => seen
}

console.log('1. Health and model discovery')
{
  const health = await worker.fetch(new Request('https://cloud.test/health'), baseEnv())
  const payload = await health.json()
  check('health reports ok', health.status === 200 && payload.ok === true)
  check('health reports configuration', payload.configured === true)
  const models = await worker.fetch(new Request('https://cloud.test/v1/models'), baseEnv())
  const list = await models.json()
  check('models lists the Javelin ids', list.data.map((m) => m.id).includes('javelin'))
}

console.log('\n2. A completion is proxied with the server-side key')
{
  const read = installUpstream()
  const response = await worker.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-javelin-install': 'install-1' },
      body: JSON.stringify({ model: 'javelin', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }),
    baseEnv(),
  )
  const seen = read()
  check('the request succeeds', response.status === 200, String(response.status))
  check('the response streams through', (await response.text()).includes('"content":"hi"'))
  check('the provider URL is the upstream one', seen.url.endsWith('/chat/completions'), seen.url)
  check('the server key is used, not a client key', seen.options.headers.Authorization === 'Bearer test-key')
  check('the caller cannot choose the upstream model', JSON.parse(seen.options.body).model === 'gemini-2.5-flash')
  check('CORS is open for the desktop app', response.headers.get('access-control-allow-origin') === '*')
}

console.log('\n3. Free quota is enforced per install, per day')
{
  const env = baseEnv({ DAILY_LIMIT: '2' })
  installUpstream()
  const send = () =>
    worker.fetch(
      new Request('https://cloud.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-javelin-install': 'install-2' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
      env,
    )
  const first = await send()
  const second = await send()
  const third = await send()
  check('the first two are allowed', first.status === 200 && second.status === 200, `${first.status}/${second.status}`)
  check('the third is refused', third.status === 429, String(third.status))
  check('the refusal explains the limit', (await third.json()).error.message.includes('free daily limit'))
  const other = await worker.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-javelin-install': 'install-3' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
    env,
  )
  check('another install still has its own allowance', other.status === 200, String(other.status))
}

console.log('\n4. With no operator key the service still answers, keylessly')
{
  const read = installUpstream()
  const keyless = await worker.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-javelin-install': 'install-4' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
    baseEnv({ UPSTREAM_KEY: '', ALLOW_KEYLESS: '1' }),
  )
  const seen = read()
  check('an opted-in keyless service still answers', keyless.status === 200, String(keyless.status))
  check('it uses the keyless upstream', seen.url === 'https://text.pollinations.ai/openai', seen.url)
  check('it sends no credential upstream', seen.options.headers.Authorization === undefined)
  const health = await (await worker.fetch(new Request('https://cloud.test/health'), baseEnv({ UPSTREAM_KEY: '', ALLOW_KEYLESS: '1' }))).json()
  check('health reports the keyless mode', health.mode === 'keyless-free', health.mode)
  check('health says it is usable', health.configured === true)

  const inert = await worker.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-javelin-install': 'install-6' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
    baseEnv({ UPSTREAM_KEY: '' }),
  )
  check('without a key and without opt-in the service says so', inert.status === 503, String(inert.status))
  check('the 503 names the missing secret', (await inert.json()).error.message.includes('UPSTREAM_KEY'))

  const missingInstall = await worker.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
    baseEnv(),
  )
  check('a request without an install id is refused', missingInstall.status === 400)

  globalThis.fetch = async () => new Response('rate limited', { status: 429 })

  const providerError = await worker.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-javelin-install': 'install-5' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
    baseEnv(),
  )
  check('a provider rate limit passes through as 429', providerError.status === 429, String(providerError.status))
  check('the busy state is explained to the user', (await providerError.json()).error.message.includes('busy'))
  check('it asks the client to retry shortly', providerError.headers.get('retry-after') === '3')
}

globalThis.fetch = originalFetch

console.log(`\n${failures === 0 ? 'ALL CLOUD PROXY CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
