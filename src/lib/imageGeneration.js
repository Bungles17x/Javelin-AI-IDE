// Keyless image generation for the static app. The prompt is screened before it
// leaves the browser and the request carries generic originality constraints.
//
// There is no reliable way to prove that a diffusion model's output is free of
// every existing work. This screen blocks the obvious cases (known characters,
// franchises, brands, artists, real people, and "copy this" requests), then adds
// an originality suffix and a negative prompt. The UI labels the result as an
// AI-generated image and tells the user to check it before commercial use.
const IMAGE_ENDPOINT = 'https://image.pollinations.ai/prompt/'
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

const NEGATIVE_PROMPT = [
  'logo', 'trademark', 'brand name', 'copyrighted character', 'existing character',
  'celebrity', 'real person likeness', 'text', 'watermark', 'signature',
].join(', ')

const IMAGE_REQUEST_PREFIX = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:create|generate|make|draw|paint|render|design|illustrate|sketch)\s+(?:me\s+)?(?:an?|some|the)?\s*(?:image|picture|illustration|drawing|artwork|visual)\b\s*(?:(?:of|showing|with|that|depicting)\s+|$)/i
const DRAW_REQUEST_PREFIX = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:draw|paint|illustrate|sketch)\s+(?:me\s+)?(?:an?|the)?\s*/i

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
  return text.replace(DRAW_REQUEST_PREFIX, '').trim()
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
  return [
    'An entirely original image.',
    String(prompt ?? '').trim(),
    'Original character design and generic setting.',
    'No text, no logos, no brand marks, no trademarks, no recognizable copyrighted characters, no real person likeness.',
  ].join(' ')
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

/**
 * Generate one image from an already-screened prompt. The caller owns the
 * AbortController and should abort it from the Stop button.
 */
export async function generateImage({ prompt, signal }) {
  const seed = randomSeed()
  const params = new URLSearchParams({
    width: '1024',
    height: '1024',
    seed: String(seed),
    model: 'flux',
    safe: 'true',
    nologo: 'true',
    private: 'true',
    negative_prompt: NEGATIVE_PROMPT,
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
    if (timedOut) throw new Error('The image service took too long. Try a shorter description.')
    throw new Error('Could not reach the image service. Check your connection and try again.')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }

  if (!response.ok) {
    if (response.status === 402) {
      const retry = Number(response.headers.get('retry-after')) || 45
      throw new Error(`The free image service is cooling down. Try again in ${retry} seconds.`)
    }
    if (response.status === 429) {
      throw new Error('The image service is busy. Wait a moment and try again.')
    }
    throw new Error(`The image service returned ${response.status}. Try again or use a different description.`)
  }

  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) {
    throw new Error('The image service did not return an image. Try a different description.')
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error('The generated image was too large to save. Try a simpler description.')
  }
  const dataUrl = await readBlobAsDataUrl(blob)
  return {
    dataUrl,
    mime: blob.type,
    bytes: blob.size,
    seed,
    prompt: String(prompt ?? '').trim(),
  }
}
