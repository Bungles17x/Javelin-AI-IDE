/**
 * In-app support requests.
 *
 * The IDE sends the form to Javelin's backend, which delivers it to the
 * support inbox. Nothing is handed to the user's mail client.
 */
import { PROVIDERS, installId } from './providers.js'

const envBase = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_JAVELIN_CLOUD_BASE : ''
const cloudBase = String(envBase || PROVIDERS.javelincloud.baseUrl || '').replace(/\/+$/, '')

export const SUPPORT_ENDPOINT = `${cloudBase}/support`

export class SupportRequestError extends Error {
  constructor(message, code = 'SUPPORT_FAILED', status = 0) {
    super(message)
    this.name = 'SupportRequestError'
    this.code = code
    this.status = status
  }
}

export async function sendSupportMessage({ topic, email, message, context = {} }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(SUPPORT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-javelin-install': installId(),
      },
      body: JSON.stringify({
        topic,
        email,
        message,
        appVersion: context.appVersion,
        mode: context.mode,
        provider: context.provider,
        platform: context.platform,
      }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new SupportRequestError(
        payload?.error?.message || `Support request failed (HTTP ${response.status}).`,
        payload?.error?.code || 'SUPPORT_FAILED',
        response.status,
      )
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new SupportRequestError('The support service did not answer. Check your connection and try again.', 'NETWORK_TIMEOUT')
    }
    if (error instanceof SupportRequestError) throw error
    throw new SupportRequestError('Could not reach the support service. Check your connection and try again.', 'NETWORK_ERROR')
  } finally {
    clearTimeout(timeout)
  }
}
