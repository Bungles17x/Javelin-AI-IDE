// Keyless image generation for the static app. The prompt is screened before it
// leaves the browser and the request carries generic originality constraints.
//
// There is no reliable way to prove that a diffusion model's output is free of
// every existing work. This screen blocks the obvious cases (known characters,
// franchises, brands, artists, real people, and "copy this" requests), then adds
// an originality suffix and a negative prompt. The UI labels the result as an
// AI-generated image and tells the user to check it before commercial use.
const IMAGE_ENDPOINT = 'https://image.pollinations.ai/prompt/'
const HORDE_ENDPOINT = 'https://aihorde.net/api/v2'
const HORDE_ANON_KEY = '0000000000'
const HORDE_CLIENT_AGENT = 'Javelin:1.0:(https://bungles17x.github.io)'
const MAX_PROMPT_CHARS = 1_200
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000

const COPYRIGHT_TERMS = [
  // Studios and franchises
  'disney', 'pixar', 'dreamworks', 'warner bros', 'marvel', 'avengers', 'dc comics',
  'star wars', 'star trek', 'harry potter', 'hogwarts', 'lord of the rings', 'hobbit',
  'game of thrones', 'jurassic park', 'back to the future', 'ghostbusters',
  'stranger things', 'the simpsons', 'simpsons', 'family guy', 'south park', 'rick and morty',
  'studio ghibli', 'ghibli', 'totoro', 'spirited away', 'looney tunes', 'grinch',
  'nintendo', 'sega', 'capcom', 'mattel', 'hasbro', 'dc universe', 'lotr',
  // Characters
  'mickey mouse', 'minnie mouse', 'donald duck', 'winnie the pooh', 'snoopy',
  'bugs bunny', 'tom and jerry', 'batman', 'superman', 'spider-man', 'spiderman',
  'iron man', 'captain america', 'wolverine', 'x-men', 'deadpool', 'hulk',
  'pikachu', 'pokemon', 'pokémon', 'mario', 'luigi', 'zelda', 'sonic the hedgehog', 'sonic',
  'kirby', 'metroid',
  'hello kitty', 'sanrio', 'barbie', 'peppa pig', 'paw patrol', 'bluey',
  'spongebob', 'scooby doo', 'shrek', 'minions', 'elsa', 'moana', 'ariel',
  'homer simpson', 'bart simpson', 'goku', 'naruto', 'luffy', 'sailor moon',
  'minecraft', 'fortnite', 'roblox', 'among us', 'pac-man', 'tetris', 'genshin impact',
  'lego', 'transformers', 'jurassic world', 'the little mermaid', 'sleeping beauty',
  // Brands and products
  'coca-cola', 'coca cola', 'pepsi', 'nike', 'adidas', 'apple logo', 'google logo',
  'microsoft logo', 'playstation', 'xbox', 'ferrari', 'lamborghini', 'netflix',
  'instagram', 'facebook', 'tiktok', 'youtube logo', 'starbucks logo',
  // Artists and famous existing works
  'pablo picasso', 'picasso', 'vincent van gogh', 'van gogh', 'claude monet',
  'leonardo da vinci', 'michelangelo', 'banksy', 'andy warhol', 'salvador dali',
  'frida kahlo', 'bob ross', 'hayao miyazaki', 'walt disney', 'mona lisa',
  'the starry night', 'the great wave', 'girl with a pearl earring',
  // Public figures (avoid real-person likenesses)
  'taylor swift', 'beyonce', 'beyoncé', 'elon musk', 'donald trump', 'joe biden',
  'barack obama', 'kanye west', 'kim kardashian', 'mrbeast', 'lionel messi',
  'cristiano ronaldo',
]

const COPYRIGHT_PATTERNS = [
  /\blogo\b/i,
  /\btrademark(?:ed)?\b/i,
  /\bcopyright(?:ed)?\b/i,
  /\bbrand name\b/i,
  /\b(?:in the style of|inspired by|exactly like|looks exactly like|copy of|replica of|clone of)\b/i,
  /\b(?:movie|film|game|book|comic) (?:still|cover|poster)\b/i,
  /\b(?:album|book) cover\b/i,
  /\b(?:screenshot|frame) from\b/i,
  /\b(?:real person|real people|celebrity|famous person|public figure|selfie)\b/i,
  /\b(?:photo|photograph|portrait) of (?:me|my|a real)\b/i,
]

const IMAGE_REQUEST_PREFIX = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:create|generate|make|draw|paint|render|design|illustrate|sketch)\s+(?:me\s+)?(?:an?|some|the)?\s*(?:image|picture|illustration|drawing|artwork|visual)\b\s*(?:(?:of|showing|with|that|depicting)\s+|$)/i
const DRAW_REQUEST_PREFIX = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:draw|paint|illustrate|sketch)\s+(?:me\s+)?(?:an?|the)?\s*/i
// Image mode is also entered by typing a plain instruction such as "Make a city".
// Strip the verb there too, otherwise the image model receives a command instead of
// the subject it is meant to draw.
const IMAGE_MODE_PREFIX = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:create|generate|make|draw|paint|render|design|illustrate|sketch)\s+(?:me\s+)?(?:an?|the)?\s*/i

const PERSON_TERMS = /\b(?:person|people|human|man|woman|boy|girl|child|kid|portrait|face|selfie|character|knight|soldier|warrior|crowd|family|couple|superhero|mascot)\b/i

/** True for requests such as "draw a lighthouse" or "create an image of a fox". */
export function isImageRequest(prompt) {
  const text = String(prompt ?? '').trim()
  if (!text) return false
  if (IMAGE_REQUEST_PREFIX.test(text)) {
    return Boolean(text.replace(IMAGE_REQUEST_PREFIX, '').trim())
  }
  return DRAW_REQUEST_PREFIX.test(text) && Boolean(text.replace(DRAW_REQUEST_PREFIX, '').trim())
}

/** Strip the conversational instruction so the model gets the subject, not a command. */
export function imageRequestSubject(prompt) {
  const text = String(prompt ?? '').trim()
  const withoutImagePrefix = text.replace(IMAGE_REQUEST_PREFIX, '').trim()
  if (withoutImagePrefix !== text) return withoutImagePrefix
  const withoutDrawPrefix = text.replace(DRAW_REQUEST_PREFIX, '').trim()
  if (withoutDrawPrefix !== text) return withoutDrawPrefix
  const withoutCommand = text.replace(IMAGE_MODE_PREFIX, '').trim()
  return withoutCommand || text
}

function normalisePrompt(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsBlockedTerm(text, term) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text)
}

/** Return a user-facing reason when a prompt is not safe to send. */
export function imagePromptIssue(prompt) {
  const text = String(prompt ?? '').trim()
  if (!text) return 'Describe the image you want to create.'
  if (text.length > MAX_PROMPT_CHARS) {
    return `Keep the image description under ${MAX_PROMPT_CHARS.toLocaleString()} characters.`
  }

  const normalised = normalisePrompt(text)
  for (const term of COPYRIGHT_TERMS) {
    if (containsBlockedTerm(normalised, normalisePrompt(term))) {
      return 'That names a protected character, franchise, brand, artist, or real person. Describe an original subject instead.'
    }
  }
  if (COPYRIGHT_PATTERNS.some((pattern) => pattern.test(normalised))) {
    return 'Use an original description instead of copying an existing work, logo, or real person.'
  }
  return ''
}

/** The screened prompt that is actually sent to the image model. */
export function buildImagePrompt(prompt) {
  const subject = String(prompt ?? '').trim().replace(/[.!?]+$/, '')
  // Subject first. A generic "character design" suffix biased a previous prompt for
  // "Make a city" toward a portrait, so the originality wording stays neutral.
  return [
    `${subject}.`,
    'Original composition with a generic setting.',
    'No text, no logos, no brand marks, no trademarks, no recognizable copyrighted characters, no real person likeness.',
  ].join(' ')
}

/** Keep a portrait out of a non-portrait request without blocking people when asked. */
export function buildNegativePrompt(prompt) {
  const base = [
    'logo', 'trademark', 'brand name', 'copyrighted character', 'existing character',
    'celebrity', 'real person likeness', 'text', 'watermark', 'signature',
  ]
  if (!PERSON_TERMS.test(String(prompt ?? ''))) {
    base.push('person', 'portrait', 'face', 'human', 'character')
  }
  return base.join(', ')
}

function randomSeed() {
  return 1 + Math.floor(Math.random() * 2_147_483_646)
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('The generated image could not be read.'))
    reader.readAsDataURL(blob)
  })
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
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

function hordeHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: HORDE_ANON_KEY,
    'Client-Agent': HORDE_CLIENT_AGENT,
  }
}

/**
 * Anonymous AI Horde backup. It uses a 512px Stable Diffusion worker instead of
 * Flux, but it is a separate queue, so a Pollinations per-IP cooldown does not
 * leave the user waiting for a timer.
 */
async function generateImageWithHorde({ prompt, signal }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  signal?.addEventListener?.('abort', onAbort, { once: true })

  try {
    const queuedResponse = await fetch(`${HORDE_ENDPOINT}/generate/async`, {
      method: 'POST',
      headers: hordeHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        prompt: `${buildImagePrompt(prompt)}###${buildNegativePrompt(prompt)}`,
        params: {
          width: 512,
          height: 512,
          steps: 20,
          cfg_scale: 7,
          sampler_name: 'k_euler',
          n: 1,
        },
        nsfw: false,
        censor_nsfw: true,
        models: ['stable_diffusion'],
        r2: true,
      }),
    })
    if (!queuedResponse.ok) {
      throw new Error(`backup image service returned ${queuedResponse.status}`)
    }
    const queued = await queuedResponse.json()
    if (!queued?.id) throw new Error('backup image service did not return a job id')

    const deadline = Date.now() + REQUEST_TIMEOUT_MS
    while (Date.now() < deadline) {
      await wait(1_000, controller.signal)
      const checkResponse = await fetch(`${HORDE_ENDPOINT}/generate/check/${queued.id}`, {
        headers: hordeHeaders(),
        signal: controller.signal,
      })
      if (!checkResponse.ok) throw new Error(`backup status returned ${checkResponse.status}`)
      const status = await checkResponse.json()
      if (status?.done) break
      if (status?.faulted) throw new Error('backup image service could not generate this image')
    }

    const statusResponse = await fetch(`${HORDE_ENDPOINT}/generate/status/${queued.id}`, {
      headers: hordeHeaders(),
      signal: controller.signal,
    })
    if (!statusResponse.ok) throw new Error(`backup image result returned ${statusResponse.status}`)
    const status = await statusResponse.json()
    if (!status?.done || status?.faulted) throw new Error('backup image service did not finish')
    const generation = status.generations?.[0]
    if (!generation?.img) throw new Error('backup image service returned no image')

    const imageResponse = await fetch(generation.img, { signal: controller.signal })
    if (!imageResponse.ok) throw new Error(`backup image download returned ${imageResponse.status}`)
    const blob = await imageResponse.blob()
    if (!blob.type.startsWith('image/')) throw new Error('backup image service returned a non-image')
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('backup image was too large to save')
    return {
      dataUrl: await readBlobAsDataUrl(blob),
      mime: blob.type || 'image/webp',
      bytes: blob.size,
      seed: Number(generation.seed) || randomSeed(),
      prompt: String(prompt ?? '').trim(),
      provider: 'aihorde',
    }
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    if (timedOut) throw new Error('The backup image service took too long. Try a shorter description.')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Generate one image from an already-screened prompt. The caller owns the
 * AbortController and should abort it from the Stop button.
 */
async function generateImageWithPollinations({ prompt, signal }) {
  const seed = randomSeed()
  const params = new URLSearchParams({
    width: '1024',
    height: '1024',
    seed: String(seed),
    model: 'flux',
    safe: 'true',
    nologo: 'true',
    private: 'true',
    negative_prompt: buildNegativePrompt(prompt),
  })
  const url = `${IMAGE_ENDPOINT}${encodeURIComponent(buildImagePrompt(prompt))}?${params.toString()}`
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })

  let response
  try {
    response = await fetch(url, { signal: controller.signal })
  } catch (error) {
    if (signal?.aborted) throw error
    const serviceError = new Error(
      timedOut
        ? 'The image service took too long.'
        : 'Could not reach the image service.',
    )
    serviceError.canFallback = true
    throw serviceError
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }

  if (!response.ok) {
    const error = new Error(`The image service returned ${response.status}.`)
    error.status = response.status
    // A per-IP queue limit or a temporary upstream failure gets the independent
    // Horde queue instead of a visible cooldown. Policy/validation errors do not.
    error.canFallback = [402, 429, 500, 502, 503, 504].includes(response.status)
    if (!error.canFallback) {
      error.message = `The image service returned ${response.status}. Try again or use a different description.`
    }
    throw error
  }

  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) {
    const error = new Error('The image service did not return an image.')
    error.canFallback = true
    throw error
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    const error = new Error('The generated image was too large to save.')
    error.canFallback = true
    throw error
  }
  const dataUrl = await readBlobAsDataUrl(blob)
  return {
    dataUrl,
    mime: blob.type,
    bytes: blob.size,
    seed,
    prompt: String(prompt ?? '').trim(),
    provider: 'pollinations',
  }
}

/**
 * Generate one image from an already-screened prompt. The caller owns the
 * AbortController and should abort it from the Stop button.
 *
 * Pollinations is the quality-first path. If its anonymous per-IP queue is full,
 * switch immediately to the independent AI Horde queue rather than telling the
 * user to wait for a cooldown. A content/policy rejection is not retried elsewhere.
 */
export async function generateImage({ prompt, signal }) {
  try {
    return await generateImageWithPollinations({ prompt, signal })
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    if (!error?.canFallback) throw error
    try {
      return await generateImageWithHorde({ prompt, signal })
    } catch (backupError) {
      if (signal?.aborted || backupError?.name === 'AbortError') throw backupError
      throw new Error('The free image services are busy right now. Try again.')
    }
  }
}
