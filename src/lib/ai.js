import { streamCompletion, PROVIDERS, DEFAULT_PROVIDER } from './providers'

// Legacy exports kept so existing imports (SettingsDialog, App) keep working.
// Models/provider now come from the provider layer.
export const MODELS = PROVIDERS.groq.models

export const DEFAULT_MODEL = PROVIDERS.groq.defaultModel

export { PROVIDERS, DEFAULT_PROVIDER }

import { renderModelIdentity } from '../core/identity.js'

/**
 * Chat mode uses the same identity as agent mode, plus chat-specific output
 * conventions. Defining it once means the model's character does not change
 * depending on which mode the user happens to be in — and it means a fine-tune
 * trained on this identity behaves consistently across both.
 */
export const SYSTEM_PROMPT = [
  renderModelIdentity(),
  '',
  'RESPONSE FORMAT',
  '- Answer in GitHub-flavored Markdown, fenced with a language tag.',
  '- Follow the conventions of the language and framework in use.',
  '- No tools are available in this mode: you can read, reason and explain, but you',
  '  cannot inspect the user\'s files or make changes. Do not imply otherwise.',
  '- When something is ambiguous, state the assumption briefly and proceed.',
  '- Do not pad answers with unnecessary explanation.',
].join('\n')

const MAX_HISTORY_MESSAGES = 20

/**
 * Backwards-compatible chat helper used by the simple chat view.
 * Delegates to the provider layer so local/keyless models work here too.
 */
export async function streamChat({
  apiKey,
  model,
  messages,
  onToken,
  signal,
  providerId = DEFAULT_PROVIDER,
  baseUrl,
}) {
  const result = await streamCompletion({
    providerId,
    baseUrl,
    apiKey,
    model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.slice(-MAX_HISTORY_MESSAGES)],
    onToken,
    signal,
  })
  return result.content
}

