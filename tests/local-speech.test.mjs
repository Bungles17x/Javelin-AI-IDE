import { toMono, downsample, bufferToPcm16k, createLocalDictation, transcriptionOptions, WHISPER_MODEL } from '../src/lib/localSpeech.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Audio is reduced to the shape Whisper expects')
const stereo = [new Float32Array([1, 1, 1, 1]), new Float32Array([0, 0, 0, 0])]
const mono = toMono(stereo)
check('stereo is averaged, not truncated', mono.length === 4 && mono.every((v) => v === 0.5))
check('a single channel passes through untouched', toMono([new Float32Array([0.25, -0.5])])[0] === 0.25)
check('empty input is handled', toMono([]).length === 0)
check('mismatched channel lengths use the shorter one', toMono([new Float32Array(6), new Float32Array(4)]).length === 4)

const at48k = new Float32Array(48000).fill(0.5)
const at16k = downsample(at48k, 48000, 16000)
check('48 kHz becomes 16 kHz', at16k.length === 16000, String(at16k.length))
check('resampling preserves level', Math.abs(at16k[0] - 0.5) < 1e-6)

const sameRate = downsample(new Float32Array([1, 2, 3]), 16000, 16000)
check('already-16 kHz audio is not resampled', sameRate.length === 3 && sameRate[1] === 2)
check('empty audio downsamples to empty', downsample(new Float32Array(0), 48000).length === 0)

const fakeBuffer = {
  numberOfChannels: 2,
  sampleRate: 44100,
  length: 44100,
  getChannelData: (i) => (i === 0 ? new Float32Array(44100).fill(0.2) : new Float32Array(44100).fill(0.2)),
}
const pcm = bufferToPcm16k(fakeBuffer)
check('an AudioBuffer becomes 16 kHz mono', pcm.length === 16000, String(pcm.length))
check('a missing buffer yields no samples', bufferToPcm16k(null).length === 0)

console.log('\n2. English-only checkpoints are not sent language options')
const enOptions = transcriptionOptions('Xenova/whisper-tiny.en')
check('an .en model gets no language or task', !('language' in enOptions) && !('task' in enOptions))
check('the default model is treated as English-only', Object.keys(transcriptionOptions()).length === 0)
const multiOptions = transcriptionOptions('Xenova/whisper-tiny')
check('a multilingual model is pinned to English', multiOptions.language === 'en' && multiOptions.task === 'transcribe')
check('an .en suffix in the middle does not count', transcriptionOptions('Xenova/whisper-en-tiny').language === 'en')

console.log('\n3. The model and the fallback are explicit')
check('the local model is Whisper tiny (English)', WHISPER_MODEL === 'Xenova/whisper-tiny.en')
const dictation = createLocalDictation({})
check('a runtime without a microphone reports unsupported', dictation.supported === false)
check('stopping when nothing started is harmless', (await dictation.stop()) === '')

console.log(`\n${failures === 0 ? 'ALL LOCAL SPEECH CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
