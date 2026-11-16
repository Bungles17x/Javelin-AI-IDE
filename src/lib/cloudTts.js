/**
 * Cloud text-to-speech
 * ====================
 *
 * The system voices in Electron are SAPI voices from another era. These providers
 * produce voices that sound like a person, at the cost of a key and a network round
 * trip. The system voice stays as the fallback so speech never stops working when a
 * key expires, a free tier runs out, or the network is down.
 *
 * Two shapes cover the useful options:
 *   - `openai`      → POST {base}/audio/speech, Bearer key, returns audio bytes
 *   - `elevenlabs`  → POST {base}/text-to-speech/{voice}, xi-api-key
 *
 * The request builders are pure and unit-tested; only `fetchSpeech` touches the
 * network, so a wrong header is caught by a test rather than by silence.
 */

import { markdownToSpeech } from './voice.js'

export const TTS_PROVIDERS = {
  system: {
    id: 'system',
    label: 'System voice (offline, free)',
    voices: [],
    defaultVoice: null,
    help: 'Uses the voices installed on this computer. Robotic, but instant and free.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (natural)',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    model: 'gpt-4o-mini-tts',
    voices: ['nova', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'sage', 'shimmer', 'verse'],
    defaultVoice: 'nova',
    help: 'Natural and expressive. Billed per character on your own OpenAI key.',
  },
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs (most human)',
    baseUrl: 'https://api.elevenlabs.io/v1',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    model: 'eleven_turbo_v2_5',
    voices: [
      { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel' },
      { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' },
      { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni' },
      { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam' },
    ],
    defaultVoice: '21m00Tcm4TlvDq8ikWAM',
    help: 'The most human-sounding of the three. Free tier is small; paid is per character.',
  },
}

export function ttsProvider(id) {
  return TTS_PROVIDERS[id] ?? TTS_PROVIDERS.system
}

export function isCloudVoice(id) {
  return Boolean(TTS_PROVIDERS[id]) && id !== 'system'
}

/** Voice list normalised to `{ id, label }` whatever shape the provider config uses. */
export function voicesFor(id) {
  const provider = ttsProvider(id)
  return (provider.voices ?? []).map((voice) =>
    typeof voice === 'string' ? { id: voice, label: voice } : voice,
  )
}

/**
 * Split text to a provider-safe size, on sentence boundaries where possible.
 * OpenAI rejects long inputs outright; ElevenLabs truncates.
 */
export function chunkForSpeech(text, max = 3500) {
  const clean = markdownToSpeech(text)
  if (!clean) return []
  const sentences = clean.match(/[^.!?\n]+[.!?]*\s*/g) ?? [clean]
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > max) {
      if (current.trim()) chunks.push(current.trim())
      current = ''
      for (let i = 0; i < sentence.length; i += max) {
        chunks.push(sentence.slice(i, i + max).trim())
      }
      continue
    }
    if ((current + sentence).length > max) {
      if (current.trim()) chunks.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(Boolean)
}

/**
 * Build the HTTP request for one chunk. Pure: no fetch, no globals.
 */
export function buildTtsRequest({ providerId, text, voice, baseUrl, apiKey }) {
  const provider = ttsProvider(providerId)
  if (!isCloudVoice(providerId)) throw new Error(`${providerId} is not a cloud voice provider`)
  const base = String(baseUrl || provider.baseUrl).replace(/\/$/, '')
  const chosen = voice || provider.defaultVoice

  if (providerId === 'elevenlabs') {
    return {
      url: `${base}/text-to-speech/${chosen}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'xi-api-key': apiKey,
      },
      body: {
        text,
        model_id: provider.model,
        voice_settings: { stability: 0.4, similarity_boost: 0.75 },
      },
    }
  }

  return {
    url: `${base}/audio/speech`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model: provider.model,
      voice: chosen,
      input: text,
      response_format: 'mp3',
    },
  }
}

/** Fetch the audio for one chunk. Throws a readable error on failure. */
export async function fetchSpeech(options) {
  const { url, headers, body } = buildTtsRequest(options)
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 200)
    } catch {
      // Body already consumed or unreadable.
    }
    throw new Error(`${response.status}${detail ? `: ${detail}` : ''}`)
  }
  return response.blob()
}

/**
 * Speak `text` through a cloud voice.
 *
 * Chunks are fetched and played in order so a long answer starts speaking quickly
 * instead of waiting for the whole audio file. Returns `true` when everything played,
 * `false` when there was nothing to say. Throws when the provider fails, which is
 * what lets the caller fall back to the system voice.
 */
/** The clip currently being played, so an interruption can silence it mid-sentence. */
let activeAudio = null
let speechAudio = null
let silentAudioUrl = null

/** One shared element, so the silent unlock performed inside a tap also blesses
 * the real clip that arrives after the network round trip. */
function getSpeechAudio() {
  if (speechAudio) return speechAudio
  if (typeof Audio === 'undefined') return null
  speechAudio = new Audio()
  speechAudio.preload = 'auto'
  speechAudio.setAttribute?.('playsinline', '')
  return speechAudio
}

/** A tiny silent WAV, generated locally rather than shipped as another asset. */
function makeSilentAudioUrl() {
  if (silentAudioUrl) return silentAudioUrl
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof DataView === 'undefined') return null
  const sampleRate = 8000
  const samples = 400
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const ascii = (offset, value) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }
  const u16 = (offset, value) => view.setUint16(offset, value, true)
  const u32 = (offset, value) => view.setUint32(offset, value, true)
  ascii(0, 'RIFF')
  u32(4, 36 + samples)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  u32(16, 16)
  u16(20, 1)
  u16(22, 1)
  u32(24, sampleRate)
  u32(28, sampleRate)
  u16(32, 1)
  u16(34, 8)
  ascii(36, 'data')
  u32(40, samples)
  bytes.fill(0x80, 44)
  silentAudioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
  return silentAudioUrl
}

/**
 * Allow a later, async cloud clip to play on mobile. Call synchronously from a
 * tap/click; iOS attaches the permission to this element, not to the network
 * response that eventually supplies the audio.
 */
export function primeCloudSpeech() {
  const audio = getSpeechAudio()
  if (!audio || activeAudio === audio) return Promise.resolve(false)
  const url = makeSilentAudioUrl()
  if (!url) return Promise.resolve(false)
  try {
    audio.pause()
    audio.currentTime = 0
    audio.volume = 0
    audio.src = url
    const playback = audio.play()
    const restore = () => {
      try {
        audio.pause()
        audio.currentTime = 0
        audio.volume = 1
      } catch {
        // The element is still usable even if resetting it failed.
      }
    }
    if (playback?.then) {
      return playback.then(() => {
        restore()
        return true
      }).catch(() => {
        audio.volume = 1
        return false
      })
    }
    restore()
    return Promise.resolve(true)
  } catch {
    try {
      audio.volume = 1
    } catch {
      // Nothing else to repair.
    }
    return Promise.resolve(false)
  }
}

/** Silence cloud speech immediately. Safe when nothing is playing. */
export function stopCloudSpeech() {
  const audio = activeAudio
  activeAudio = null
  if (!audio) return
  try {
    audio.pause()
    audio.currentTime = 0
  } catch {
    // Already finished or never started.
  }
}

export async function speakCloud(options) {
  const chunks = chunkForSpeech(options.text)
  if (!chunks.length) return false
  const { signal } = options
  const audio = getSpeechAudio()
  if (!audio) throw new Error('audio playback is not available here')

  for (const chunk of chunks) {
    if (signal?.aborted) return false
    const blob = await fetchSpeech({ ...options, text: chunk })
    if (signal?.aborted) return false
    const url = URL.createObjectURL(blob)
    try {
      await new Promise((resolve, reject) => {
        let settled = false
        let onAbort
        const cleanup = () => {
          signal?.removeEventListener?.('abort', onAbort)
          audio.onended = null
          audio.onpause = null
          audio.onerror = null
          if (activeAudio === audio) activeAudio = null
        }
        const finish = () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }
        const fail = (error) => {
          if (settled) return
          settled = true
          cleanup()
          try {
            audio.pause()
          } catch {
            // Already stopped.
          }
          reject(error)
        }
        onAbort = () => {
          stopCloudSpeech()
          fail(Object.assign(new Error('speech interrupted'), { name: 'AbortError' }))
        }
        activeAudio = audio
        audio.volume = 1
        audio.src = url
        audio.onended = finish
        audio.onpause = () => {
          if (signal?.aborted) fail(Object.assign(new Error('speech interrupted'), { name: 'AbortError' }))
        }
        audio.onerror = () => fail(new Error('audio playback failed'))
        signal?.addEventListener?.('abort', onAbort, { once: true })
        audio.play().catch(fail)
      })
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  return true
}
