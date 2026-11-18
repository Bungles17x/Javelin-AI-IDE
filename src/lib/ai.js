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
  '- Default to plain text for conversation and short explanations. Do not use Markdown headings, bold, italics, bullet lists, numbered lists, tables, or blockquotes unless they are genuinely needed.',
  '- Use GitHub-flavored Markdown only when the answer contains code, is a long-form essay or document, or the user explicitly asks for Markdown, formatted text, or copyable output.',
  '- Always fence code blocks with a language tag.',
  '- Follow the conventions of the language and framework in use.',
  '- No tools are available in this mode: you can read, reason and explain, but you',
  '  cannot inspect the user\'s files or make changes. Do not imply otherwise.',
  '- When something is ambiguous, state the assumption briefly and proceed.',
  '- Do not pad answers with unnecessary explanation.',
].join('\n')

// Keep the request small enough to start quickly. Sixteen turns cover a normal
// back-and-forth; the character budget keeps pasted files and long answers from
// turning every follow-up into a large prefill.
const MAX_HISTORY_MESSAGES = 16
const MAX_HISTORY_CHARS = 32_000
// A chat answer is bounded so a rambling model cannot monopolise the UI. Agent
// mode keeps its larger budget because it must write whole files. A model running
// on this computer is capped lower again: local generation is far slower.
export const CHAT_MAX_OUTPUT_TOKENS = 3_072
export const LOCAL_CHAT_MAX_OUTPUT_TOKENS = 1_200

function messageCharCount(message) {
  const content = message?.content
  return typeof content === 'string' ? content.length : JSON.stringify(content ?? '').length
}

/** Keep the most recent turns within both the message and character budgets. */
export function trimChatHistory(messages, {
  maxMessages = MAX_HISTORY_MESSAGES,
  maxChars = MAX_HISTORY_CHARS,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const kept = []
  let chars = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (kept.length >= maxMessages) break
    const size = messageCharCount(message)
    // Always keep the newest message, even if it is one large pasted file.
    if (kept.length > 0 && chars + size > maxChars) break
    kept.unshift(message)
    chars += size
  }
  return kept
}

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
  maxTokens,
}) {
  const history = trimChatHistory(messages)
  const provider = PROVIDERS[providerId] ?? PROVIDERS[DEFAULT_PROVIDER]
  const outputLimit = maxTokens ?? (provider.hosted ? CHAT_MAX_OUTPUT_TOKENS : LOCAL_CHAT_MAX_OUTPUT_TOKENS)
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
    maxTokens: outputLimit,
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
