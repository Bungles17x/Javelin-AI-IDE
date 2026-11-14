import http from 'node:http'
import { buildTtsRequest, chunkForSpeech, fetchSpeech, isCloudVoice, voicesFor, ttsProvider, TTS_PROVIDERS } from '../src/lib/cloudTts.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Requests match each provider\'s API')
const openai = buildTtsRequest({ providerId: 'openai', text: 'Hello there.', voice: 'nova', apiKey: 'sk-test' })
check('OpenAI posts to /audio/speech', openai.url === 'https://api.openai.com/v1/audio/speech', openai.url)
check('OpenAI sends a bearer token', openai.headers.Authorization === 'Bearer sk-test')
check('OpenAI sends model, voice, input, format', openai.body.model === 'gpt-4o-mini-tts' && openai.body.voice === 'nova' && openai.body.input === 'Hello there.' && openai.body.response_format === 'mp3')
check('the key never leaks into the body', !JSON.stringify(openai.body).includes('sk-test'))

const eleven = buildTtsRequest({ providerId: 'elevenlabs', text: 'Hello there.', voice: 'abc123', apiKey: 'el-key' })
check('ElevenLabs puts the voice in the path', eleven.url === 'https://api.elevenlabs.io/v1/text-to-speech/abc123', eleven.url)
check('ElevenLabs authenticates with xi-api-key', eleven.headers['xi-api-key'] === 'el-key')
check('ElevenLabs asks for mp3', eleven.headers.Accept === 'audio/mpeg')
check('ElevenLabs sends text and model_id', eleven.body.text === 'Hello there.' && eleven.body.model_id === 'eleven_turbo_v2_5')

const custom = buildTtsRequest({ providerId: 'openai', text: 'x', baseUrl: 'http://localhost:9000/v1/', apiKey: 'k' })
check('a custom endpoint is used and joined cleanly', custom.url === 'http://localhost:9000/v1/audio/speech', custom.url)
const defaultVoice = buildTtsRequest({ providerId: 'openai', text: 'x', apiKey: 'k' })
check('a missing voice falls back to the provider default', defaultVoice.body.voice === TTS_PROVIDERS.openai.defaultVoice)
check('a system voice cannot build a cloud request', (() => { try { buildTtsRequest({ providerId: 'system', text: 'x' }); return false } catch { return true } })())

console.log('\n2. Long answers are split safely')
const short = chunkForSpeech('One sentence. Two sentences.')
check('short text stays in one chunk', short.length === 1)
check('speech text has markdown removed', !chunkForSpeech('**Bold** and `code` and [link](http://x)').join(' ').includes('**'))
const long = 'This is a sentence that is reasonably long. '.repeat(200)
const chunks = chunkForSpeech(long, 500)
check('long text is split', chunks.length > 1, String(chunks.length))
check('no chunk exceeds the limit', chunks.every((c) => c.length <= 500), String(Math.max(...chunks.map((c) => c.length))))
check('nothing is lost while splitting', Math.abs(chunks.join(' ').length - long.trim().length) < 5)
check('a single word longer than the limit is hard-split', chunkForSpeech('a'.repeat(1200), 500).every((c) => c.length <= 500))
check('empty text produces no audio work', chunkForSpeech('   ').length === 0)
check('pure punctuation produces no audio work', chunkForSpeech('**').length === 0)

console.log('\n3. Providers and fallbacks are explicit')
check('system is not a cloud provider', isCloudVoice('system') === false)
check('openai and elevenlabs are cloud providers', isCloudVoice('openai') && isCloudVoice('elevenlabs'))
check('an unknown provider is treated as system', ttsProvider('nope').id === 'system')
check('every provider exposes a default voice or none', Object.values(TTS_PROVIDERS).every((p) => p.id === 'system' || p.defaultVoice))
check('voice lists are normalised to { id, label }', voicesFor('elevenlabs').every((v) => v.id && v.label))
check('openai voices are usable as ids', voicesFor('openai').some((v) => v.id === 'nova'))

console.log('\n4. A real request reaches a real server and its failures are readable')
const seen = []
const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (piece) => { body += piece })
  request.on('end', () => {
    seen.push({ url: request.url, auth: request.headers.authorization, body })
    if (request.headers.authorization === 'Bearer good') {
      response.writeHead(200, { 'content-type': 'audio/mpeg' })
      response.end(Buffer.from('ID3fake-audio'))
    } else {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"bad key"}')
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`

const audio = await fetchSpeech({ providerId: 'openai', text: 'Say this.', voice: 'nova', apiKey: 'good', baseUrl })
check('audio bytes come back as a blob', audio.size > 0)
check('the request carried the key in a header', seen[0]?.auth === 'Bearer good')
check('the request hit the speech endpoint', seen[0]?.url === '/v1/audio/speech', seen[0]?.url)
check('the body asked for the right text and voice', JSON.parse(seen[0]?.body ?? '{}').input === 'Say this.' && JSON.parse(seen[0]?.body).voice === 'nova')

let failure = ''
try {
  await fetchSpeech({ providerId: 'openai', text: 'x', apiKey: 'bad', baseUrl })
} catch (error) {
  failure = String(error.message)
}
check('a rejected key throws instead of playing silence', failure.includes('401'), failure.slice(0, 60))
check('the provider message is included', failure.includes('bad key'), failure.slice(0, 80))

server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))

console.log(`\n${failures === 0 ? 'ALL CLOUD TTS CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
// No process.exit here: forcing exit while libuv is closing the server socket
// aborts on Windows. Setting the code lets Node wind down on its own.
process.exitCode = failures === 0 ? 0 : 1
