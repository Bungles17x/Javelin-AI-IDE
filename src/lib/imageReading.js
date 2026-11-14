/**
 * Read an image for a text-only model.
 * ====================================
 *
 * The free default model accepts text, not image parts. Rather than refusing the
 * attachment, turn the image into text first:
 *
 *  - OCR runs **in this browser** with Tesseract, so screenshots, code, forms and
 *    documents keep their actual words.
 *  - A short caption comes from AI Horde's anonymous interrogation endpoint. It
 *    covers photos and illustrations where OCR has nothing to read.
 *
 * No API key and no account are needed. Tesseract's worker/core/language files are
 * fetched from a CDN once and cached by the browser; the caption request is the only
 * part of this module that sends the image off the device. If either half fails, the
 * other half is still used, and a failure never blocks the message.
 */

const CAPTION_ENDPOINT = 'https://aihorde.net/api/v2/interrogate/async'
const CAPTION_STATUS = 'https://aihorde.net/api/v2/interrogate/status'
const ANONYMOUS_KEY = '0000000000'
const CLIENT_AGENT = 'Javelin:1.0:(https://bungles17x.github.io)'
const OCR_LANG = 'eng'
const OCR_MAX_CHARS = 8_000
const CAPTION_MAX_CHARS = 600

let workerPromise = null
let progressHandler = null
let recognizeChain = Promise.resolve()

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Strip the data: prefix; the Horde API wants the payload, not a data URL. */
export function base64Payload(dataUrl) {
  const value = String(dataUrl ?? '')
  const comma = value.indexOf(',')
  return comma >= 0 ? value.slice(comma + 1) : value
}

function ocrWorker(onProgress) {
  if (onProgress) progressHandler = onProgress
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      return createWorker(OCR_LANG, 1, {
        // Pin these so a future package release cannot silently change the CDN
        // layout. The language file is the traineddata used by Tesseract 4/5.
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
        logger: (event) => {
          if (event?.status === 'recognizing text') {
            progressHandler?.(Math.round((Number(event.progress) || 0) * 100))
          } else if (event?.status) {
            progressHandler?.(0)
          }
        },
      })
    })().catch((error) => {
      workerPromise = null
      throw error
    })
  }
  return workerPromise
}

/** OCR is serialized: one worker cannot safely recognize two images at once. */
export async function extractOcrText(dataUrl, { onProgress } = {}) {
  const run = async () => {
    const worker = await ocrWorker(onProgress)
    const result = await worker.recognize(dataUrl)
    return normalizeText(result?.data?.text).slice(0, OCR_MAX_CHARS)
  }
  const next = recognizeChain.catch(() => {}).then(run)
  recognizeChain = next.catch(() => {})
  return next
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Ask AI Horde for a one-line description. The service works anonymously, but it is
 * a shared public queue: a slow answer is normal, and a failure is non-fatal.
 */
export async function requestCaption(dataUrl, { signal, timeoutMs = 25_000 } = {}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(CAPTION_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ANONYMOUS_KEY,
        'Client-Agent': CLIENT_AGENT,
      },
      body: JSON.stringify({
        source_image: base64Payload(dataUrl),
        forms: [{ name: 'caption' }],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`caption service returned ${response.status}`)
    const queued = await response.json()
    if (!queued?.id) throw new Error('caption service did not return a job id')

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const statusResponse = await fetch(`${CAPTION_STATUS}/${queued.id}`, {
        headers: { apikey: ANONYMOUS_KEY, 'Client-Agent': CLIENT_AGENT },
        signal: controller.signal,
      })
      if (!statusResponse.ok) throw new Error(`caption status returned ${statusResponse.status}`)
      const status = await statusResponse.json()
      if (status?.state === 'done') {
        const form = (status.forms || []).find((entry) => entry?.form === 'caption')
        const caption = normalizeText(form?.result?.caption).slice(0, CAPTION_MAX_CHARS)
        if (caption) return caption
        throw new Error('caption service returned an empty description')
      }
      if (status?.state === 'faulted') throw new Error('caption service could not read the image')
      await wait(1_000, controller.signal)
    }
    throw new Error('caption service timed out')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Build the text block that stands in for an image. The model is told explicitly
 * that this is extracted material, so it does not pretend to have seen the pixels.
 */
export function formatImageReading({ name, ocr, caption }) {
  const sections = []
  if (caption) sections.push(`Description: ${caption}`)
  if (ocr) sections.push(`Visible text:\n${ocr}`)
  if (!sections.length) {
    sections.push('No readable text or description could be extracted automatically.')
  }
  return `Image "${name || 'attachment'}" was read automatically:\n${sections.join('\n\n')}`
}

/**
 * @returns {Promise<{ analysis: string, ocr: string, caption: string }>}
 */
export async function readImageForTextModel(attachment, { signal, onStage } = {}) {
  if (!attachment?.dataUrl) throw new Error('There is no image data to read.')
  const name = attachment.name || 'attachment'
  let caption = ''
  let ocr = ''
  let lastStage = ''
  const stage = (value) => {
    if (value && value !== lastStage) {
      lastStage = value
      onStage?.(value)
    }
  }

  stage('Reading the image…')
  const captionTask = requestCaption(attachment.dataUrl, { signal })
    .catch(() => '')
  const ocrTask = extractOcrText(attachment.dataUrl, {
    onProgress: (percent) => stage(percent > 0 ? `Reading the image… ${percent}%` : 'Reading the image…'),
  }).catch(() => '')

  const [captionResult, ocrResult] = await Promise.all([captionTask, ocrTask])
  caption = normalizeText(captionResult).slice(0, CAPTION_MAX_CHARS)
  ocr = normalizeText(ocrResult).slice(0, OCR_MAX_CHARS)
  stage('')
  return { analysis: formatImageReading({ name, ocr, caption }), ocr, caption }
}

/** Test seam: drop the cached worker so a fresh one can be created. */
export function resetImageReaderForTests() {
  workerPromise = null
  progressHandler = null
  recognizeChain = Promise.resolve()
}
