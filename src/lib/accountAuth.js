/**
 * Online Javelin accounts.
 *
 * Passwords are only sent to the Javelin Cloud auth endpoint; they are never
 * stored by the app. The returned session token is kept in local storage so a
 * signed-in user stays signed in on this device.
 */
import { PROVIDERS } from './providers.js'

const envBase = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_JAVELIN_CLOUD_BASE : ''
const cloudBase = String(envBase || PROVIDERS.javelincloud.baseUrl || '').replace(/\/+$/, '')

export const AUTH_BASE_URL = `${cloudBase}/auth`
export const ACCOUNT_SESSION_KEY = 'javelin.accountSession'

export class AccountAuthError extends Error {
  constructor(message, code = 'AUTH_FAILED', status = 0, details = null) {
    super(message)
    this.name = 'AccountAuthError'
    this.code = code
    this.status = status
    this.details = details
  }
}

async function performRequest(path, { method = 'POST', body, token } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`${AUTH_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new AccountAuthError(
        payload?.error?.message || `Account request failed (HTTP ${response.status}).`,
        payload?.error?.code || 'AUTH_FAILED',
        response.status,
        payload?.error || null,
      )
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new AccountAuthError('The account service did not answer. Check your connection and try again.', 'NETWORK_TIMEOUT')
    }
    if (error instanceof AccountAuthError) throw error
    throw new AccountAuthError(
      'Could not reach the account service. Check your connection and try again.',
      'NETWORK_ERROR',
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function request(path, options = {}) {
  try {
    return await performRequest(path, options)
  } catch (error) {
    if (error?.code !== 'NETWORK_ERROR') throw error
    // Electron can occasionally keep a dead TLS/network service after a
    // network change or a stale connection. Reset the desktop connections and
    // retry once before showing the user a connection error.
    try {
      if (typeof window !== 'undefined' && window.javelinDesktop?.resetNetwork) {
        await window.javelinDesktop.resetNetwork()
      }
    } catch {
      /* the retry below still gets a chance */
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
    return performRequest(path, options)
  }
}

export async function signUp({ username, email, password, ownerCode = '' }) {
  const payload = await request('/signup', {
    body: {
      username,
      email,
      password,
      ...(ownerCode ? { ownerCode } : {}),
    },
  })
  return payload.session
}

export async function signIn({ identifier, password }) {
  const payload = await request('/login', { body: { identifier, password } })
  return payload.session
}

export async function requestEmailLogin(email) {
  return request('/email-login/request', { body: { email } })
}

export async function pollEmailLogin({ requestId, pollToken }) {
  return request('/email-login/poll', { body: { requestId, pollToken } })
}

export async function submitEmailCode({ requestId, code }) {
  return request('/email-login/code', { body: { requestId, code } })
}

export async function fetchAccount(token) {
  const payload = await request('/me', { method: 'GET', token })
  return payload.user
}

export async function signOut(token) {
  if (!token) return
  await request('/logout', { token })
}

export async function fetchAuthConfig() {
  return request('/config', { method: 'GET' })
}

/** Read the signed-in account's synced chat history. */
export async function fetchChatHistory(token) {
  return request('/history', { method: 'GET', token })
}

/**
 * Upload this device's snapshot. The Worker merges it with what it already has
 * and returns the merged history, so one request both pushes and pulls.
 */
export async function syncChatHistory(token, history) {
  const payload = await request('/history', { method: 'POST', token, body: history })
  return payload.history
}

export async function resendVerification(token) {
  return request('/verify-email/resend', { token })
}

export async function fetchSecuritySettings(token) {
  return request('/security', { method: 'GET', token })
}

export async function updateSecuritySettings(token, settings) {
  return request('/security', { token, body: settings })
}

export async function lockAccount(token) {
  return request('/security/lock', { token })
}

export async function verifyEmail(token) {
  return request('/verify-email', { body: { token } })
}

export async function requestPasswordReset(email) {
  return request('/password-reset/request', { body: { email } })
}

export async function resetPassword({ token, password }) {
  return request('/password-reset/confirm', { body: { token, password } })
}

export async function fetchAdminUsers(token, query = '') {
  const suffix = query ? `?query=${encodeURIComponent(query)}` : ''
  const payload = await request(`/admin/users${suffix}`, { method: 'GET', token })
  return payload.users ?? []
}

export async function fetchAdminStats(token) {
  return request('/admin/stats', { method: 'GET', token })
}

export async function banAccount(token, { identifier, reason = '', days = 0 }) {
  return request('/admin/ban', { token, body: { identifier, reason, days } })
}

export async function unbanAccount(token, identifier) {
  return request('/admin/unban', { token, body: { identifier } })
}

export async function setAccountRole(token, { identifier, role }) {
  return request('/admin/role', { token, body: { identifier, role } })
}

export function sessionExpired(session) {
  if (!session?.token) return true
  const expires = Date.parse(session.expiresAt || '')
  return Number.isFinite(expires) && expires <= Date.now()
}

export function readStoredAccountSession() {
  try {
    const raw = localStorage.getItem(ACCOUNT_SESSION_KEY)
    if (!raw) return null
    const session = JSON.parse(raw)
    if (!session?.token || !session?.user?.username || sessionExpired(session)) return null
    return session
  } catch {
    return null
  }
}

export function storeAccountSession(session) {
  try {
    if (session) localStorage.setItem(ACCOUNT_SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(ACCOUNT_SESSION_KEY)
  } catch {
    /* storage is optional */
  }
}
