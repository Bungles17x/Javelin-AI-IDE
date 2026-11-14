import { streamCompletion, PROVIDERS, DEFAULT_PROVIDER, DEFAULT_CLOUD_PROVIDER } from './providers.js'

// Legacy exports remain available to older imports, backed by the local model.
export const MODELS = PROVIDERS.javelin.models

export const DEFAULT_MODEL = PROVIDERS.javelin.defaultModel

export { PROVIDERS, DEFAULT_PROVIDER, DEFAULT_CLOUD_PROVIDER }

import { renderModelIdentity } from '../core/identity.js'
import { CONVERSATION_STYLE, withConversationContext } from '../core/conversation.js'
import { estimateMessageTokens, estimateTokens } from './usage.js'

/**
 * Chat mode uses the same identity as agent mode, plus chat-specific output
 * conventions. Defining it once means the model's character does not change
 * depending on which mode the user happens to be in — and it means a fine-tune
 * trained on this identity behaves consistently across both.
 */
export const SYSTEM_PROMPT = [
  renderModelIdentity(),
  '',
  CONVERSATION_STYLE,
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
  onUsage,
  signal,
  providerId = DEFAULT_PROVIDER,
  baseUrl,
}) {
  const history = messages.slice(-MAX_HISTORY_MESSAGES)
  const lastUserIndex = history.map((m) => m?.role).lastIndexOf('user')

  // Resolve "why?", "you?", "same" against the thread instead of answering the
  // literal characters. Only the final user message is rewritten, and only when
  // there is a real previous exchange to point at.
  const prepared = history.map((message, index) => {
    if (index !== lastUserIndex) return message
    const prior = history.slice(0, index)
    if (Array.isArray(message?.content)) {
      const textPart = message.content.find((part) => part?.type === 'text')
      if (!textPart || !String(textPart.text ?? '').trim()) return message
      return {
        ...message,
        content: message.content.map((part) => (
          part === textPart
            ? { ...part, text: withConversationContext(textPart.text, prior) }
            : part
        )),
      }
    }
    if (!String(message?.content ?? '').trim()) return message
    return { ...message, content: withConversationContext(message.content, prior) }
  })

  const result = await streamCompletion({
    providerId,
    baseUrl,
    apiKey,
    model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...prepared],
    onToken,
    signal,
  })
  onUsage?.({
    usage: result.usage ?? null,
    inputTokens: estimateMessageTokens([{ role: 'system', content: SYSTEM_PROMPT }, ...prepared]),
    outputTokens: estimateTokens(result.content),
  })
  return result.content
}
