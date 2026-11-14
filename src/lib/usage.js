/**
 * Token allowance shared by the account UI and the request paths.
 *
 * Providers report exact usage in different shapes, and some local providers do
 * not report it at all. The app therefore prefers the server's total and falls
 * back to a readable character estimate instead of pretending a missing count is
 * zero.
 */
export const MEMBER_TOKEN_LIMIT = 100_000_000

const numberFormatter = new Intl.NumberFormat('en-US')

export function formatTokenCount(value) {
  const number = Number(value)
  return numberFormatter.format(Math.max(0, Math.round(Number.isFinite(number) ? number : 0)))
}

/** Exact token count from an OpenAI-style usage object, or 0 when unavailable. */
export function tokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0
  const total = Number(usage.total_tokens)
  if (Number.isFinite(total) && total > 0) return Math.ceil(total)
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens)
  const completion = Number(usage.completion_tokens ?? usage.output_tokens)
  const sum = (Number.isFinite(prompt) ? Math.max(0, prompt) : 0) +
    (Number.isFinite(completion) ? Math.max(0, completion) : 0)
  return Math.ceil(sum)
}

/** Roughly four characters per token, including JSON-ish message overhead. */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text ? Math.ceil(text.length / 4) : 0
}

export function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return estimateTokens(messages)
  return messages.reduce((total, message) => {
    if (!message) return total
    return total + estimateTokens(message.content) + 4
  }, 0)
}

/**
 * Prefer exact usage. When a provider omits it, count the text that actually
 * crossed the request: the prepared history plus the generated answer.
 */
export function tokensForExchange({ usage, inputTokens, outputTokens }) {
  const exact = tokensFromUsage(usage)
  if (exact > 0) return exact
  return Math.max(0, Math.ceil(Number(inputTokens) || 0) + Math.ceil(Number(outputTokens) || 0))
}
