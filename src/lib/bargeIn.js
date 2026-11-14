/**
 * Barge-in
 * ========
 *
 * Live voice without interruption is a monologue: you wait for the whole answer,
 * however long, to ask a follow-up. This listens on the same microphone while the
 * assistant speaks and ends that speech as soon as you start talking.
 *
 * The hard part is not detecting sound, it is not detecting *itself*. The microphone
 * hears the speakers, so a naive gate interrupts on the first word out of the model's
 * mouth. Three things keep it honest:
 *
 *   1. `echoCancellation` on the stream (already requested) removes most of it.
 *   2. The first `calibrationMs` of speech is spent measuring the residual: whatever
 *      the mic hears while the assistant talks without being interrupted becomes the
 *      floor, so its own voice can never cross the line.
 *   3. Onset must be sustained for a few frames. A door slam is not a sentence.
 *
 * The decision itself is a pure function so it can be tested without a microphone.
 */

/** Never trigger on background noise alone, even in a silent room. */
export const ATTACK_FLOOR = 0.02

/** How far above the measured echo floor your voice has to be. */
export const HEADROOM = 2.4

/** Level (RMS) that counts as speech, given the echo floor measured during speech. */
export function bargeThreshold(baseline = 0) {
  return Math.max(ATTACK_FLOOR, Number(baseline || 0) * HEADROOM)
}

export function shouldInterrupt(rms, baseline = 0) {
  return Number(rms) > bargeThreshold(baseline)
}

/**
 * Watch the microphone for an interruption.
 *
 * `start()` is async because the stream is shared with dictation — it may already be
 * open, in which case this is immediate. `stop()` is always safe to call.
 */
export function createBargeIn({
  getStream,
  onInterrupt,
  calibrationMs = 600,
  frameMs = 60,
  framesNeeded = 3,
} = {}) {
  let timer = null
  let context = null
  let running = false

  const stop = () => {
    running = false
    if (timer) clearInterval(timer)
    timer = null
    try {
      context?.close?.()
    } catch {
      // Already closed.
    }
    context = null
  }

  const start = async () => {
    if (running) return true
    running = true
    try {
      const stream = await getStream?.()
      // Stopped while waiting for the stream: do not start a monitor nobody wants.
      if (!running) return false
      const AudioCtx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null
      if (!AudioCtx || !stream) {
        running = false
        return false
      }

      context = new AudioCtx()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const startedAt = Date.now()
      let baseline = 0
      let loudFrames = 0

      timer = setInterval(() => {
        if (!running) return
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
        const rms = Math.sqrt(sum / samples.length)

        if (Date.now() - startedAt < calibrationMs) {
          baseline = Math.max(baseline, rms)
          return
        }
        if (shouldInterrupt(rms, baseline)) loudFrames += 1
        else loudFrames = 0

        if (loudFrames >= framesNeeded) {
          stop()
          onInterrupt?.()
        }
      }, frameMs)
      return true
    } catch {
      stop()
      return false
    }
  }

  return { start, stop, get running() { return running } }
}
