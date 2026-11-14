/**
 * Local speech recognition
 * ========================
 *
 * Chromium's `SpeechRecognition` is a thin front-end for a Google service and a key
 * Electron does not have — it exists, then fails with `network`. This module removes
 * that dependency: it records the microphone and transcribes the audio **in the app**
 * with Whisper running on ONNX, so voice input needs no account, no key and no cloud.
 *
 * Cost of that independence: the model (about 40 MB quantised) is downloaded once and
 * cached by the browser, and transcription takes a beat. That is the honest trade.
 *
 * Split on purpose: the audio maths (`downsample`, `toMono16k`) is pure and tested;
 * the recording and model plumbing is the shell.
 */

export const WHISPER_MODEL = 'Xenova/whisper-tiny.en'
export const TARGET_RATE = 16000

let transcriberPromise = null

/**
 * Load (once per process) the Whisper pipeline.
 *
 * `dtype: 'q8'` keeps the download and memory small; wasm is used because this
 * machine has no GPU the wasm backend can rely on. The loader is shared so pressing
 * the mic twice never downloads the model twice.
 */
export function getTranscriber({ onProgress } = {}) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      // Remote models only: there is nothing useful on this machine's disk.
      env.allowLocalModels = false
      // Single-threaded, no proxy worker. Both defaults spawn a worker whose module
      // is imported from a blob: URL, which a locked-down CSP blocks — and the
      // bundled build has no server-side file layout for it to fall back to.
      env.backends.onnx.wasm.numThreads = 1
      env.backends.onnx.wasm.proxy = false
      // Load the runtime from this app instead of letting it synthesise a blob: URL
      // (blocked in a packaged shell) or reach for a CDN (no offline). The files live
      // in public/ort and are copied into the build.
      if (typeof location !== 'undefined') {
        env.backends.onnx.wasm.wasmPaths = new URL('ort/', location.href).href
      }
      return pipeline('automatic-speech-recognition', WHISPER_MODEL, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (event) => onProgress?.(event),
      })
    })().catch((error) => {
      transcriberPromise = null
      throw error
    })
  }
  return transcriberPromise
}

/** Average stereo (or more) channels into one mono track. */
export function toMono(channels) {
  if (!channels?.length) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const length = Math.min(...channels.map((c) => c.length))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    out[i] = sum / channels.length
  }
  return out
}

/**
 * Resample to 16 kHz mono. Whisper is trained at 16 kHz; feeding it 48 kHz audio
 * produces confident nonsense rather than an error, which is the worst failure mode.
 */
export function downsample(input, fromRate, toRate = TARGET_RATE) {
  if (!input?.length) return new Float32Array(0)
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = sum / Math.max(1, end - start)
  }
  return out
}

/** AudioBuffer (browser) → Float32Array at 16 kHz, without any DOM assumptions. */
export function bufferToPcm16k(audioBuffer) {
  if (!audioBuffer) return new Float32Array(0)
  const channels = []
  for (let i = 0; i < audioBuffer.numberOfChannels; i++) channels.push(audioBuffer.getChannelData(i))
  return downsample(toMono(channels), audioBuffer.sampleRate, TARGET_RATE)
}

function recorderMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  if (typeof MediaRecorder === 'undefined') return ''
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? ''
}

/**
 * Generation options for the loaded checkpoint.
 *
 * English-only checkpoints (`.en`) carry their language in the weights and reject
 * `language`/`task` outright — passing them fails the whole request with "Cannot
 * specify `task` or `language` for an English-only model". Multilingual ones need
 * them to avoid auto-detecting a language from a two-second clip.
 */
export function transcriptionOptions(model = WHISPER_MODEL) {
  return String(model).endsWith('.en') ? {} : { language: 'en', task: 'transcribe' }
}

/**
 * Press-to-talk with local transcription.
 *
 *   const dictation = createLocalDictation({ onFinal, onError, onState })
 *   await dictation.start()   // opens the microphone
 *   await dictation.stop()    // stops, transcribes, calls onFinal
 */
/**
 * Open the microphone once and keep it.
 *
 * Live mode needs the stream while recording *and* while the assistant speaks, so the
 * stream is owned by the session rather than by one recording. A blocked or busy device
 * can leave getUserMedia pending forever, so this rejects on its own after `timeoutMs`
 * instead of leaving a dead microphone button.
 */
export async function openMicStream({ timeoutMs = 8000 } = {}) {
  return Promise.race([
    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('microphone timeout'), { name: 'TimeoutError' })), timeoutMs),
    ),
  ])
}

export function createLocalDictation({ onFinal, onEmpty, onError, onState, onProgress, autoStop = false, getStream } = {}) {
  const supported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined'

  let recorder = null
  let stream = null
  let chunks = []
  let analyserTimer = null
  let audioContext = null
  const stopRef = { current: null }

  const clearAnalyser = () => {
    if (analyserTimer) clearInterval(analyserTimer)
    analyserTimer = null
    audioContext?.close?.().catch?.(() => {})
    audioContext = null
  }

  const cleanup = () => {
    clearAnalyser()
    // A borrowed stream belongs to the live session and outlives this recording.
    if (!getStream) stream?.getTracks?.().forEach((track) => track.stop())
    stream = null
    recorder = null
    chunks = []
  }

  /**
   * Hands-free mode needs to know when the user stopped talking. A simple RMS gate
   * over an AnalyserNode is enough: 1.2 s of near-silence after at least a second of
   * speech ends the turn. No wake word, no key, no cloud.
   */
  const watchSilence = () => {
    if (!autoStop) return
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return
    try {
      audioContext = new AudioCtx()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      const started = Date.now()
      let heardSpeech = false
      let lastLoud = Date.now()

      analyserTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms = Math.sqrt(sum / data.length)
        if (rms > 0.012) {
          heardSpeech = true
          lastLoud = Date.now()
        }
        const silentFor = Date.now() - lastLoud
        const ranFor = Date.now() - started
        if ((heardSpeech && silentFor > 1200) || ranFor > 20000) {
          clearAnalyser()
          stopRef.current?.()
        }
      }, 100)
    } catch {
      // Analyser unavailable: the user can still stop the recording by hand.
    }
  }

  const start = async () => {
    if (!supported) {
      onError?.('This runtime has no microphone API.')
      return false
    }
    try {
      onState?.('requesting')
      // A blocked or busy device can leave getUserMedia pending forever — neither
      // granted nor rejected. Waiting silently is worse than failing clearly.
      stream = getStream ? await getStream() : await openMicStream()
      const mimeType = recorderMime()
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunks = []
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data)
      }
      recorder.start()
      onState?.('recording')
      watchSilence()
      return true
    } catch (error) {
      cleanup()
      const label =
        error?.name === 'NotAllowedError'
          ? 'not-allowed'
          : error?.name === 'TimeoutError'
            ? 'timeout'
            : String(error?.message ?? error)
      onError?.(label)
      return false
    }
  }

  const stop = async () => {
    if (!recorder) return ''
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve
    })
    try {
      recorder.stop()
    } catch {
      // Already stopped.
    }
    await stopped
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
    cleanup()

    if (blob.size < 1200) {
      onState?.('idle')
      // Nothing was said. Live mode uses this to keep listening instead of
      // leaving the microphone off after a pause.
      onEmpty?.()
      return ''
    }

    try {
      onState?.('transcribing')
      const arrayBuffer = await blob.arrayBuffer()
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      const context = new AudioCtx()
      const decoded = await context.decodeAudioData(arrayBuffer)
      const pcm = bufferToPcm16k(decoded)
      await context.close()

      const transcriber = await getTranscriber({ onProgress })
      const result = await transcriber(pcm, transcriptionOptions())
      onState?.('idle')
      const text = String(result?.text ?? '').trim()
      if (text) onFinal?.(text)
      else onEmpty?.()
      return text
    } catch (error) {
      onState?.('idle')
      onError?.(String(error?.message ?? error))
      return ''
    }
  }

  stopRef.current = stop

  return { supported, start, stop, cancel: cleanup }
}
