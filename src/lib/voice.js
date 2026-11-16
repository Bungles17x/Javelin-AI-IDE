/**
 * Voice
 * =====
 *
 * Speech in and speech out, using the platform's own engines so it works with no
 * account, no key and no network:
 *
 *   - Output: `speechSynthesis`. Voice quality depends entirely on what the OS
 *     ships. Windows exposes SAPI voices (some marked "Natural"), macOS and Chrome
 *     ship better ones. We rank what exists rather than pretending a robotic voice
 *     is a human one.
 *   - Input: `SpeechRecognition`. Chromium's implementation needs a Google backend
 *     key and is often absent inside Electron — `supported` reports the truth so the
 *     UI can say "not available here" instead of showing a dead microphone.
 *
 * Everything here is a thin shell. The interesting logic — voice ranking and
 * turning Markdown into something worth hearing — is pure and unit-tested.
 */

const NATURAL_HINTS = [
  /natural/i,
  /neural/i,
  /enhanced/i,
  /premium/i,
  /aria/i,
  /jenny/i,
  /guy/i,
  /sonia/i,
  /libby/i,
  /samantha/i,
  /ava/i,
  /allison/i,
  /serena/i,
  /daniel/i,
  /karen/i,
  /google/i,
]

const ROBOTIC_HINTS = [/zira/i, /david/i, /mark/i, /hazel/i, /desktop/i, /compact/i, /espeak/i]

/** What this runtime can actually do. Never optimistic. */
export function voiceCapabilities(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return { speak: false, listen: false, voices: [] }
  const synth = win.speechSynthesis
  const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition
  return {
    speak: Boolean(synth && typeof synth.speak === 'function'),
    listen: Boolean(Recognition),
    voices: synth && typeof synth.getVoices === 'function' ? synth.getVoices() ?? [] : [],
  }
}

/**
 * Score a voice for "sounds human".
 *
 * Higher is better. The weights are deliberately blunt: a voice the platform labels
 * Natural/Neural is almost always better than one it does not, and the old SAPI
 * desktop voices are the ones that make an assistant sound like a 1998 GPS.
 */
export function scoreVoice(voice) {
  if (!voice) return -Infinity
  const name = String(voice.name ?? '')
  let score = 0
  for (const hint of NATURAL_HINTS) if (hint.test(name)) score += 50
  for (const hint of ROBOTIC_HINTS) if (hint.test(name)) score -= 40
  if (/^en/i.test(String(voice.lang ?? ''))) score += 10
  if (voice.localService === false) score += 5 // server voices are usually the better ones
  if (voice.default) score += 2
  return score
}

/** Best available voice, honouring an explicit choice first. */
export function pickVoice(voices = [], preferredURI = null, lang = 'en') {
  const list = [...(voices ?? [])]
  if (!list.length) return null
  if (preferredURI) {
    const chosen = list.find((v) => v.voiceURI === preferredURI || v.name === preferredURI)
    if (chosen) return chosen
  }
  const matching = list.filter((v) => String(v.lang ?? '').toLowerCase().startsWith(lang.toLowerCase()))
  const pool = matching.length ? matching : list
  return pool.reduce((best, v) => (scoreVoice(v) > scoreVoice(best) ? v : best), pool[0])
}

/**
 * Turn a Markdown reply into something that sounds right when read aloud.
 *
 * Code read character by character is unbearable, so fenced blocks become a short
 * spoken note and inline code keeps only its text. Links keep their label. Markdown
 * punctuation is removed so the synthesiser does not pronounce asterisks.
 */
export function markdownToSpeech(text) {
  let out = String(text ?? '')
  out = out.replace(/```[\s\S]*?```/g, ' (code block) ')
  out = out.replace(/`([^`]+)`/g, '$1')
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  out = out.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, '')
  out = out.replace(/^\s{0,3}>\s?/gm, '')
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2')
  out = out.replace(/(\*|_)(.*?)\1/g, '$2')
  out = out.replace(/<[^>]+>/g, ' ')
  out = out.replace(/[|]{2,}/g, ' ')
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/ ?\n ?/g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/**
 * Split speech into utterance-sized pieces.
 *
 * Some engines silently truncate long utterances — Chrome has historically cut off
 * around 15 seconds — so long replies are queued as sentences instead of handed over
 * as one giant string.
 */
export function speechChunks(text, maxChars = 180) {
  const clean = markdownToSpeech(text)
  if (!clean) return []
  const sentences = clean.match(/[^.!?\n]+[.!?]*\s*/g) ?? [clean]
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current.trim()) chunks.push(current.trim())
      current = ''
      for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars).trim())
      continue
    }
    if ((current + sentence).length > maxChars) {
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
 * Speak a reply, in order, cancelling cleanly.
 * Returns `false` when the runtime has no speech synthesis.
 */
export function createSpeaker(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win?.speechSynthesis) {
    return {
      supported: false,
      speak: async () => false,
      stop: () => {},
      speaking: () => false,
      unlock: async () => false,
      isUnlocked: () => false,
      lastError: () => null,
    }
  }
  const synth = win.speechSynthesis
  let runId = 0
  let unlocked = false
  let unlocking = null
  let lastError = null
  const liveUtterances = new Set()

  const stop = () => {
    runId += 1
    try {
      synth.cancel()
    } catch {
      // Nothing to cancel.
    }
    liveUtterances.clear()
  }

  /**
   * Open the speech session from inside a tap/click.
   *
   * iOS Safari only relaxes its speech autoplay restriction when the first
   * `speak()` happens on the synchronous click stack. A silent utterance here
   * lets the answer arrive later and still be spoken. Chrome Android applies a
   * similar first-play restriction.
   */
  const unlock = () => {
    if (unlocked) return Promise.resolve(true)
    if (unlocking) return unlocking
    let utterance
    try {
      utterance = new win.SpeechSynthesisUtterance(' ')
    } catch {
      return Promise.resolve(false)
    }
    unlocking = new Promise((resolve) => {
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        liveUtterances.delete(utterance)
        unlocking = null
        if (ok) unlocked = true
        resolve(ok)
      }
      utterance.volume = 0
      utterance.rate = 10
      utterance.pitch = 1
      utterance.lang = 'en'
      utterance.onend = () => finish(true)
      utterance.onerror = () => finish(false)
      liveUtterances.add(utterance)
      try {
        synth.speak(utterance)
        // Some engines do not emit events for an empty utterance.
        win.setTimeout?.(() => finish(true), 300)
      } catch (error) {
        lastError = String(error?.message ?? error)
        finish(false)
      }
    })
    return unlocking
  }

  const speak = (text, { voiceURI = null, rate = 1, pitch = 1, lang = 'en' } = {}) =>
    new Promise((resolve) => {
      const chunks = speechChunks(text)
      if (!chunks.length) return resolve(false)
      const myRun = ++runId
      lastError = null
      // A new reply replaces anything already queued. resume() matters on iOS:
      // a previous cancel can leave the shared engine paused.
      try {
        synth.cancel()
        synth.resume?.()
      } catch {
        // The engine will report the failure when speak() is called.
      }
      const voice = pickVoice(synth.getVoices?.() ?? [], voiceURI, lang)
      let index = 0
      let settled = false

      const finish = (ok) => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      const next = () => {
        if (settled) return
        if (myRun !== runId) return finish(false)
        if (index >= chunks.length) return finish(true)
        let utterance
        try {
          utterance = new win.SpeechSynthesisUtterance(chunks[index++])
        } catch (error) {
          lastError = String(error?.message ?? error)
          return finish(false)
        }
        if (voice) utterance.voice = voice
        utterance.rate = rate
        utterance.pitch = pitch
        utterance.lang = voice?.lang || lang
        liveUtterances.add(utterance)
        utterance.onend = () => {
          liveUtterances.delete(utterance)
          next()
        }
        utterance.onerror = (event) => {
          liveUtterances.delete(utterance)
          const reason = String(event?.error ?? '')
          if (myRun !== runId || reason === 'interrupted' || reason === 'canceled') return finish(false)
          lastError = reason || 'speech failed'
          finish(false)
        }
        try {
          synth.speak(utterance)
          synth.resume?.()
        } catch (error) {
          lastError = String(error?.message ?? error)
          finish(false)
        }
      }

      next()
    })

  return {
    supported: true,
    speak,
    stop,
    speaking: () => Boolean(synth.speaking),
    unlock,
    isUnlocked: () => unlocked,
    lastError: () => lastError,
  }
}

/**
 * Dictation. `onFinal` fires with the transcript, `onPartial` while the user talks.
 * `supported` is false when the runtime has no recogniser — in Electron that is the
 * normal case, and the UI is expected to say so rather than fail silently.
 */
export function createDictation({ lang = 'en-US', onPartial, onFinal, onError, onEnd } = {}) {
  const win = typeof window !== 'undefined' ? window : undefined
  const Recognition = win?.SpeechRecognition || win?.webkitSpeechRecognition
  if (!Recognition) return { supported: false, start: () => false, stop: () => {} }

  let recognition = null
  let active = false

  const start = () => {
    if (active) return true
    try {
      recognition = new Recognition()
    } catch (error) {
      onError?.(error)
      return false
    }
    recognition.lang = lang
    recognition.continuous = false
    recognition.interimResults = true
    recognition.onresult = (event) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) final += result[0].transcript
        else interim += result[0].transcript
      }
      if (interim) onPartial?.(interim)
      if (final.trim()) onFinal?.(final.trim())
    }
    recognition.onerror = (event) => {
      active = false
      onError?.(event?.error ?? 'speech error')
    }
    recognition.onend = () => {
      active = false
      onEnd?.()
    }
    try {
      recognition.start()
      active = true
      return true
    } catch (error) {
      onError?.(error)
      return false
    }
  }

  const stop = () => {
    try {
      recognition?.stop()
    } catch {
      // Already stopped.
    }
    active = false
  }

  return { supported: true, start, stop, active: () => active }
}
