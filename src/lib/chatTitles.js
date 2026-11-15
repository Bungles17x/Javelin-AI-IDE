/**
 * AI-generated conversation titles.
 *
 * A title is cosmetic: if the provider is unavailable, too slow or returns
 * something unusable, the caller keeps the first-message fallback title.
 */
import { streamCompletion } from './providers.js'

const TITLE_SYSTEM_PROMPT = [
  'You name chat conversations.',
  'Reply with only a title of 2 to 6 words.',
  'Use title case, no quotes, no markdown, no trailing punctuation.',
  'Describe the user\'s actual topic, not the fact that they asked a question.',
].join(' ')

export function cleanSuggestedTitle(value) {
  let text = String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? ''
  text = text
    .replace(/^(?:chat\s+)?title\s*:\s*/i, '')
    .replace(/^#+\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?:;,]+$/, '')
  if (!text) return ''
  const words = text.split(' ').filter(Boolean)
  if (words.length > 7) text = words.slice(0, 7).join(' ')
  if (text.length > 56) text = `${text.slice(0, 55).trimEnd()}…`
  if (!/[a-z0-9]/i.test(text) || /^new chat$/i.test(text)) return ''
  return text
}

export function titleTranscript(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => ['user', 'assistant'].includes(message?.role))
    .filter((message) => String(message.content ?? '').trim())
    .slice(0, 8)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${String(message.content).replace(/\s+/g, ' ').trim().slice(0, 1_200)}`)
    .join('\n')
    .slice(0, 7_000)
}

export async function generateChatTitle({
  providerId,
  baseUrl,
  apiKey,
  model,
  messages,
  signal,
}) {
  const transcript = titleTranscript(messages)
  if (!transcript) return null
  let streamed = ''
  const result = await streamCompletion({
    providerId,
    baseUrl,
    apiKey,
    model,
    temperature: 0.4,
    signal,
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: `Conversation to name:\n${transcript}` },
    ],
    onToken: (delta) => {
      streamed += delta
    },
  })
  const title = cleanSuggestedTitle(streamed || result?.content)
  return title ? { title, usage: result?.usage ?? null } : null
}
