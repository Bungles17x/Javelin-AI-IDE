/**
 * Local owner access.
 *
 * This is a local gate for the desktop app, not a server-side account system:
 * the passphrase never leaves this computer and only a salted PBKDF2 hash is
 * stored. Anyone with control of the machine and its DevTools can still bypass
 * a client-side gate, so it protects normal app use rather than the filesystem.
 */

export const OWNER_USERNAME = 'Bungles17x'
export const GUEST_DAILY_LIMIT = 10
export const OWNER_ITERATIONS = 150_000

const encoder = new TextEncoder()

function toBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value) {
  const binary = atob(String(value ?? ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function derive(passphrase, salt, iterations) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure local authentication is not available in this runtime.')
  }
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(String(passphrase).normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    256,
  )
  return new Uint8Array(bits)
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}

export async function createOwnerCredential(passphrase) {
  const cleaned = String(passphrase ?? '')
  if (cleaned.length < 8) throw new Error('Use at least 8 characters for the owner passphrase.')
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random generation is not available in this runtime.')
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(cleaned, salt, OWNER_ITERATIONS)
  return {
    version: 1,
    username: OWNER_USERNAME,
    salt: toBase64(salt),
    hash: toBase64(hash),
    iterations: OWNER_ITERATIONS,
    createdAt: new Date().toISOString(),
  }
}

export async function verifyOwnerPassphrase(credential, passphrase) {
  if (!credential?.salt || !credential?.hash) return false
  try {
    const salt = fromBase64(credential.salt)
    const expected = fromBase64(credential.hash)
    const actual = await derive(passphrase, salt, Number(credential.iterations) || OWNER_ITERATIONS)
    return equalBytes(actual, expected)
  } catch {
    return false
  }
}

export function todayKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
