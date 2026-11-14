import { DEFAULT_CLOUD_PROVIDER, DEFAULT_PROVIDER, PROVIDERS, getProvider, isLocalOllamaEndpoint, probeLocalRuntime, providerNeedsLocalRuntime, streamCompletion } from '../src/lib/providers.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. The IDE starts on a free cloud model, and local Ollama stays available')
check('the library default is still the local model', DEFAULT_PROVIDER === 'javelin', DEFAULT_PROVIDER)
{
  const cloud = PROVIDERS[DEFAULT_CLOUD_PROVIDER]
  check('the IDE default is a working cloud provider', cloud?.id === 'gemini', String(cloud?.id))
  check('the IDE default is hosted', cloud?.hosted === true)
  check('the IDE default is free tier', cloud?.freeTier === true)
  check('the IDE default uses https', cloud?.baseUrl.startsWith('https://'), cloud?.baseUrl)
  check('the IDE default explains where to get its key', cloud?.keyUrl?.startsWith('https://') === true)
  check('the IDE default has a model', Boolean(cloud?.defaultModel))
  check('the IDE default needs no local runtime', providerNeedsLocalRuntime(DEFAULT_CLOUD_PROVIDER) === false)
}
check('the default model is the Javelin local model', PROVIDERS.javelin.defaultModel === 'javelin-coder:latest')
check('the endpoint is local Ollama', isLocalOllamaEndpoint(PROVIDERS.javelin.baseUrl))
check('legacy local selection resolves to a valid local provider', isLocalOllamaEndpoint(getProvider('local').baseUrl))
check('public hosts are not local endpoints', !isLocalOllamaEndpoint('https://api.openai.com/v1'))

console.log('\n2. Completion uses local Ollama with streaming and tools')
{
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options }
    return new Response([
      'data: {"choices":[{"delta":{"content":"Local "},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"response"},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const tokens = []
    const result = await streamCompletion({
      model: 'javelin-coder:latest',
      messages: [{ role: 'user', content: 'Say hello' }],
      tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }],
      apiKey: 'legacy-cloud-key-must-not-be-sent',
      onToken: (token) => tokens.push(token),
    })
    const body = JSON.parse(request.options.body)
    check('request goes to the local chat completion endpoint',
      request.url === 'http://127.0.0.1:11434/v1/chat/completions', request.url)
    check('local model name is used', body.model === 'javelin-coder:latest', body.model)
    check('tools are sent to the model', body.tools?.[0]?.function?.name === 'write_file')
    check('streaming text is returned', result.content === 'Local response', result.content)
    check('streaming deltas are emitted', tokens.join('') === 'Local response', tokens.join(''))
    check('legacy API keys are never sent', !request.options.headers.Authorization)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n3. Remote endpoints fail before a request is made')
{
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('Remote request attempted') }
  try {
    let message = ''
    try {
      await streamCompletion({
        baseUrl: 'https://api.openai.com/v1',
        model: 'anything',
        messages: [{ role: 'user', content: 'Do not send this remotely' }],
      })
    } catch (error) {
      message = error.message
    }
    check('remote base URL is rejected', message.includes('Remote AI endpoints are disabled'), message)
    check('fetch is not called for a remote URL', !called)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n4. Local runtime check uses the Javelin Ollama endpoint')
{
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return new Response(JSON.stringify({ data: [{ id: 'javelin-coder:latest' }] }))
  }
  try {
    const result = await probeLocalRuntime()
    check('probe uses the configured local model endpoint',
      requestedUrl === 'http://127.0.0.1:11434/v1/models', requestedUrl)
    check('probe reports installed model names', result.ok && result.models[0] === 'javelin-coder:latest')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n1a. Javelin Cloud is keyless, hosted, and needs no local runtime')
{
  const cloud = PROVIDERS.javelincloud
  check('the Javelin Cloud provider exists', Boolean(cloud))
  check('it needs no API key', cloud.requiresKey === false && cloud.keyless === true)
  check('it is hosted over https', cloud.hosted === true && cloud.baseUrl.startsWith('https://'), cloud.baseUrl)
  check('it needs no local runtime', providerNeedsLocalRuntime('javelincloud') === false)
  check('it identifies the install for quota', cloud.installHeader === true)
}

console.log('\n1c. A keyless impossible-to-miss bug check: no key, no throw')
{
  const originalFetch = globalThis.fetch
  let headers = null
  globalThis.fetch = async (url, options) => {
    headers = options.headers
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    await streamCompletion({
      providerId: 'javelincloud',
      apiKey: '',
      model: 'javelin',
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('a keyless hosted provider does not demand a key', true)
    check('it sends an install id for the free quota', Boolean(headers?.['x-javelin-install']))
    check('it sends no authorization header', headers?.Authorization === undefined)
  } catch (error) {
    check('a keyless hosted provider does not demand a key', false, error.message)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n1b. A hosted provider never needs the local runtime')
check('OpenAI needs no local runtime', providerNeedsLocalRuntime('openai') === false)
check('Groq needs no local runtime', providerNeedsLocalRuntime('groq') === false)
check('Together needs no local runtime', providerNeedsLocalRuntime('together') === false)
check('the Javelin local model does need it', providerNeedsLocalRuntime('javelin') === true)
check('a custom provider on localhost needs it',
  providerNeedsLocalRuntime('custom', 'http://127.0.0.1:8000/v1') === true)
check('a custom provider on the network needs none',
  providerNeedsLocalRuntime('custom', 'https://api.example.com/v1') === false)

console.log('\n1c. The trained local model is a first-class provider')
{
  const local = PROVIDERS.javelinlocal
  check('the Javelin Local provider exists', Boolean(local))
  check('it points at the knowledge server', local?.baseUrl === 'http://127.0.0.1:8787/v1', local?.baseUrl)
  check('it needs no API key', local?.requiresKey === false && local?.keyless === true)
  check('it is classified as a local server', local?.localServer === true)
  check('it never needs the Ollama runtime', providerNeedsLocalRuntime('javelinlocal') === false)
  check('it still needs one when a custom URL is set',
    providerNeedsLocalRuntime('javelinlocal', 'http://127.0.0.1:9000/v1') === false)
  check('it offers the chatting model', local?.models?.some((m) => m.id === 'javelin-knowledge'))
  check('it offers the 1.5B coder', local?.models?.some((m) => m.id === 'javelin-coder-1.5b'))
  check('it offers the 3B coder', local?.models?.some((m) => m.id === 'javelin-coder-3b'))
  check('it offers the 7B coder', local?.models?.some((m) => m.id === 'javelin-coder-7b'))
  check('the coder is the default for an editor', local?.defaultModel === 'javelin-coder-1.5b')
  check('both models are named for what they do',
    local?.models?.some((m) => m.label.includes('Chatting Knowledge')) &&
    local?.models?.some((m) => m.label.includes('Coder 1.5B')))
}

console.log('\n1d. Your own model, hosted on your own GPU')
{
  const hosted = PROVIDERS.javelinhosted
  check('the Javelin Hosted provider exists', Boolean(hosted))
  check('it offers a 7B model', hosted?.models?.some((m) => m.id === 'javelin-7b'))
  check('it offers a 14B model', hosted?.models?.some((m) => m.id === 'javelin-14b'))
  check('7B is the default', hosted?.defaultModel === 'javelin-7b')
  check('it needs a key', hosted?.requiresKey === true && hosted?.hosted === true)
  check('it has no guessed endpoint', hosted?.baseUrl === '')
  check('it needs no local runtime', providerNeedsLocalRuntime('javelinhosted') === false)
}

console.log(`\n${failures === 0 ? 'ALL LOCAL PROVIDER CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
