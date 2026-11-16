/**
 * Decide when a chat reply gets rich text.
 *
 * Normal conversation is plain text. Markdown is reserved for code, long-form
 * writing, and explicit requests, so the interface does not turn every short
 * answer into a document.
 */

const RICH_REQUEST = /\b(?:markdown|md|formatted|formatting|copy|copyable|code|snippet|script|program|essay|article|blog|report|document|write[- ]?up|long[- ]?form|outline|table|bullets?|list|email|letter|story|poem|plan|proposal)\b/i
const FENCED_CODE = /```[\s\S]*?```/
const INLINE_CODE = /`[^`\n]+`/

/** True for a long, multi-paragraph answer rather than a short explanation. */
export function isLongForm(text) {
  const body = String(text ?? '').trim()
  if (!body) return false
  const words = body.split(/\s+/).length
  const paragraphs = body.split(/\n\s*\n/).filter((part) => part.trim()).length
  return words >= 300 && paragraphs >= 2
}

/** True when this reply should be rendered as Markdown and made copyable. */
export function shouldUseMarkdown(text, request = '') {
  const body = String(text ?? '')
  if (!body.trim()) return false
  if (RICH_REQUEST.test(String(request ?? ''))) return true
  if (FENCED_CODE.test(body) || INLINE_CODE.test(body)) return true
  return isLongForm(body)
}

/**
 * Remove the common Markdown decorations for the plain-text renderer. This is
 * deliberately conservative: code replies never reach it, and normal prose
 * keeps its words, links and line breaks.
 */
export function plainTextFromMarkdown(text) {
  return String(text ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^\w*])\*([A-Za-z][^*\n]{0,80})\*(?![\w*])/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*>\s?/gm, '')
    .trim()
}