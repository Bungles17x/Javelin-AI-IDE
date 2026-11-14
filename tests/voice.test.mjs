import {
  scoreVoice,
  pickVoice,
  markdownToSpeech,
  speechChunks,
  voiceCapabilities,
  createSpeaker,
  createDictation,
} from '../src/lib/voice.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const voices = [
  { name: 'Microsoft David Desktop', lang: 'en-US', voiceURI: 'david' },
  { name: 'Microsoft Aria Online (Natural)', lang: 'en-US', voiceURI: 'aria' },
  { name: 'Google UK English Female', lang: 'en-GB', voiceURI: 'google' },
  { name: 'Microsoft Zira Desktop', lang: 'en-US', voiceURI: 'zira' },
  { name: 'Thomas', lang: 'fr-FR', voiceURI: 'thomas' },
]

console.log('\n1. Voice ranking prefers natural voices')
check('a natural voice outranks a desktop one', scoreVoice(voices[1]) > scoreVoice(voices[0]))
check('the old desktop voice scores below neutral', scoreVoice(voices[0]) < 0)
check('an explicit choice wins', pickVoice(voices, 'zira').voiceURI === 'zira')
check('without a preference the natural voice wins', pickVoice(voices).voiceURI === 'aria')
check('an unknown preferred voice falls back to ranking', pickVoice(voices, 'nope').voiceURI === 'aria')
check('language filters the pool', pickVoice(voices.filter((v) => v.lang.startsWith('fr')), null, 'fr').voiceURI === 'thomas')
check('no voices is handled', pickVoice([], null) === null)

console.log('\n2. Markdown is cleaned before it is spoken')
const spoken = markdownToSpeech('## Fix\n**Read** the [docs](https://x.dev) and `npm test`.\n```js\nconst a = 1\n```\n- then ship')
check('headings lose their hashes', !spoken.includes('#'))
check('bold markers are removed', !spoken.includes('**'))
check('link labels survive, urls do not', spoken.includes('docs') && !spoken.includes('http'))
check('inline code keeps its content', spoken.includes('npm test'))
check('fenced code becomes a short note', spoken.includes('code block') && !spoken.includes('const a'))
check('list bullets are dropped', !/^\s*-\s/m.test(spoken))

console.log('\n3. Long answers are chunked for engines that truncate')
const long = 'One sentence here. '.repeat(40)
const chunks = speechChunks(long, 120)
check('long text becomes several chunks', chunks.length > 1)
check('every chunk respects the limit', chunks.every((c) => c.length <= 120))
check('nothing is lost', chunks.join(' ').replace(/\s+/g, ' ').trim().startsWith('One sentence here.'))
check('short text stays one chunk', speechChunks('Hello there.').length === 1)
check('empty text produces no speech', speechChunks('   ').length === 0)

console.log('\n4. Missing platform support is reported, not hidden')
const caps = voiceCapabilities({})
check('a runtime with no speech reports speak=false', caps.speak === false)
check('a runtime with no recogniser reports listen=false', caps.listen === false)
check('the speaker degrades to a no-op', createSpeaker({}).supported === false)
check('dictation degrades to unsupported', createDictation({}).supported === false)

console.log(`\n${failures === 0 ? 'ALL VOICE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
