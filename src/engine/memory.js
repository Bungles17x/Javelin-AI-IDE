/**
 * Javelin Engine — memory.
 *
 * Four small stores, each with one job:
 *
 *   transcript   what the model sees, bounded and protocol-valid
 *   attempts     what has already been tried, so nothing repeats blindly
 *   files        content recently read, so re-reads are free
 *   metrics      what the run cost, for honest reporting and tuning
 *
 * The transcript is pruned by *shortening message content*, never by removing
 * messages. That matters: an assistant `tool_calls` message must keep its `tool`
 * results adjacent, or the provider rejects the whole request.
 */

import { MAX_TOOL_OUTPUT_CHARS } from './limits.js'

/** Rough token estimate: English and code average ~4 characters per token. */
export function estimateTokens(value) {
  return Math.ceil(String(value ?? '').length / 4)
}

export function createMemory() {
  return {
    /** Running transcript (system, prior conversation, task, turns). */
    transcript: [],
    /** Per-path revision counters, so the read cache stays valid where it can. */
    fileRevisions: new Map(),
    /** Completed tool records, in execution order. */
    steps: [],
    /** signature -> { count, failed, denied, progressVersion } */
    attempts: new Map(),
    /** path -> { content, revision, at } */
    files: new Map(),
    checkpoints: [],
    filesTouched: new Set(),
    /** Per-run "always allow" decisions, keyed by tool name or exact command/path. */
    alwaysAllow: new Set(),
    /** Bumped on every successful workspace change. */
    progressVersion: 0,
    /** Bumped on every workspace change; used to invalidate cached file contents. */
    revision: 0,
    plan: { text: '', steps: [] },
    /** Indexed view of the project, rebuilt from the workspace. */
    projectIndex: null,
    /** The effective task, used by project tools and confidence reporting. */
    task: '',
    /** Facts the run actually observed, not claims the model made. */
    evidence: {
      filesRead: new Set(),
      searches: [],
      commands: [],
    },
    metrics: {
      modelCalls: 0,
      attempts: 0,
      retries: 0,
      toolCalls: 0,
      toolFailures: 0,
      cachedReads: 0,
      duplicatesBlocked: 0,
      prunedMessages: 0,
      tokensIn: 0,
      tokensOut: 0,
      modelLatencyMs: 0,
      startedAt: Date.now(),
    },
    loop: {
      lastText: '',
      identicalResponses: 0,
      noActionTurns: 0,
      repeatedActions: 0,
      lastBlockedSignature: null,
      finishRefusals: 0,
      consecutiveFailures: 0,
      diagnosisSent: false,
      signatureWindow: [],
    },
  }
}

/** Normalise text so cosmetic differences do not look like new progress. */
export function normalizeText(text) {
  return String(text ?? '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** A file read is reusable while its revision is current. */
const CACHE_TTL_MS = 60_000

export function cacheFileRead(memory, path, content) {
  memory.files.set(path, {
    content,
    revision: memory.fileRevisions.get(path) ?? 0,
    at: Date.now(),
  })
}

export function readCachedFile(memory, path) {
  const entry = memory.files.get(path)
  if (!entry) return null
  // Revisions are per path: editing one file must not discard the content of
  // another file the model is still working from.
  if (entry.revision !== (memory.fileRevisions.get(path) ?? 0)) return null
  if (Date.now() - entry.at > CACHE_TTL_MS) return null
  return entry.content
}

/** Invalidate exactly the paths a mutation touched (never the whole cache). */
export function invalidateFiles(memory, paths = []) {
  memory.revision += 1
  for (const path of paths) {
    if (!path) continue
    memory.fileRevisions.set(path, (memory.fileRevisions.get(path) ?? 0) + 1)
    memory.files.delete(path)
  }
}

export function noteProgress(memory, paths = []) {
  memory.progressVersion += 1
  // A real workspace change answers the reason finish was refused earlier.
  memory.loop.finishRefusals = 0
  invalidateFiles(memory, paths)
}

export function canAttempt(memory, signature, { allowRepeat = false } = {}) {
  const prior = memory.attempts.get(signature)
  if (!prior) return { allowed: true, prior: null }
  // Reading the same file again is safe and often necessary after older tool output
  // has been trimmed from the transcript. Serve it again instead of calling it a loop.
  if (allowRepeat && !prior.denied && !prior.failed) return { allowed: true, prior, repeat: true }
  if (prior.denied) {
    return {
      allowed: false,
      prior,
      reason:
        `BLOCKED: \`${signature}\` was already attempted with this unchanged workspace. ` +
        `The user denied it; do not retry it. Propose an alternative or stop and ask.`,
    }
  }
  if (prior.progressVersion === memory.progressVersion) {
    return {
      allowed: false,
      prior,
      reason: prior.failed
        ? `BLOCKED: \`${signature}\` already failed against this unchanged workspace. ` +
          `Change the approach instead of repeating it.`
        : `BLOCKED: \`${signature}\` already succeeded and the workspace has not changed since. ` +
          `Do not repeat it: use the result in context and call \`finish\` if the task is complete.`,
    }
  }
  return { allowed: true, prior }
}

export function recordAttempt(memory, signature, { failed = false, denied = false } = {}) {
  const prior = memory.attempts.get(signature)
  memory.attempts.set(signature, {
    count: (prior?.count ?? 0) + 1,
    failed,
    denied: Boolean(denied || prior?.denied),
    progressVersion: memory.progressVersion,
  })
}

/** Remember the signature window so a repeating *pattern* is visible, not just a call. */
export function noteSignature(memory, signature) {
  memory.loop.signatureWindow.push(signature)
  if (memory.loop.signatureWindow.length > 12) memory.loop.signatureWindow.shift()
}

/**
 * Detect the same short sequence of calls recurring. A model that cycles
 * read → list → read → list is looping even though no single call repeats.
 */
export function repeatingSequence(memory, size = 4, repeats = 3) {
  const window = memory.loop.signatureWindow
  if (window.length < size * repeats) return null
  const tail = window.slice(-size)
  for (let offset = 1; offset < repeats; offset++) {
    const start = window.length - size * (offset + 1)
    if (start < 0) return null
    const candidate = window.slice(start, start + size)
    if (candidate.join('|') !== tail.join('|')) return null
  }
  return tail
}

/**
 * Remove the most recent assistant text message.
 *
 * A small model that sees its own last sentence tends to repeat it. Dropping the echo
 * before the forced retry breaks that loop without touching the task or tool results.
 */
export function dropLastAssistantText(memory) {
  for (let index = memory.transcript.length - 1; index >= 0; index--) {
    const message = memory.transcript[index]
    if (message.role === 'system') return false
    // Nudges that followed the reply do not protect it; keep walking back to the
    // assistant message itself.
    if (message.role !== 'assistant') continue
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) return false
    if (typeof message.content !== 'string' || !message.content.trim()) return false
    memory.transcript.splice(index, 1)
    return true
  }
  return false
}

export function truncateOutput(text, max = MAX_TOOL_OUTPUT_CHARS) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const head = value.slice(0, Math.max(0, max - 1500))
  const tail = value.slice(-1200)
  return `${head}\n… [${value.length - head.length - tail.length} characters omitted] …\n${tail}`
}

export function recordStep(memory, record) {
  memory.steps.push(record)
  memory.metrics.toolCalls += 1
  if (!record.ok) memory.metrics.toolFailures += 1
}

/**
 * Build the message list for a request within a character budget.
 *
 * Oversized tool output is compacted first; if the conversation is still too
 * large, the oldest content is replaced with a short marker while every message
 * and every tool-call pairing stays in place.
 */
export function buildTranscript(memory, { maxChars = 96_000 } = {}) {
  const copy = memory.transcript.map((message) => ({ ...message }))
  let total = copy.reduce((sum, message) => sum + String(message.content ?? '').length, 0)

  for (const message of copy) {
    if (message.role !== 'tool') continue
    const content = String(message.content ?? '')
    if (content.length <= MAX_TOOL_OUTPUT_CHARS) continue
    const next = truncateOutput(content)
    total -= content.length - next.length
    message.content = next
    memory.metrics.prunedMessages += 1
  }

  // Keep the system prompt and the original task; shorten turns oldest first.
  const protectedIndex = copy.findIndex((message) => message.role === 'user')
  for (let index = 1; index < copy.length && total > maxChars; index++) {
    if (index === protectedIndex) continue
    const message = copy[index]
    const content = typeof message.content === 'string' ? message.content : ''
    if (content.length <= 240) continue
    const replacement =
      message.role === 'tool' ? '(earlier tool output omitted to fit the context budget)' : '(earlier message omitted)'
    message.content = replacement
    total -= content.length - replacement.length
    memory.metrics.prunedMessages += 1
  }

  // Last resort: even the newest results must fit. Shrink the largest remaining
  // content to a readable head instead of overflowing the model's context.
  for (let guard = 0; total > maxChars && guard < copy.length * 2; guard++) {
    let largest = -1
    for (let index = 1; index < copy.length; index++) {
      if (index === protectedIndex) continue
      const content = typeof copy[index].content === 'string' ? copy[index].content : ''
      if (content.length <= 240) continue
      if (largest === -1 || content.length > String(copy[largest].content).length) largest = index
    }
    if (largest === -1) break
    const content = copy[largest].content
    const replacement = `${content.slice(0, 120)}\n… [${content.length - 120} characters omitted to fit the context budget]`
    total -= content.length - replacement.length
    copy[largest].content = replacement
    memory.metrics.prunedMessages += 1
  }

  return copy
}

/**
 * Guarantee one tool result per tool call id, in order.
 *
 * Providers reject a transcript where an assistant `tool_calls` message has no
 * matching `tool` message, so a gap is filled rather than losing the run.
 */
export function ensureToolResultPairing(messages) {
  const out = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    out.push(message)
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue

    const answered = new Set()
    let next = index + 1
    while (next < messages.length && messages[next]?.role === 'tool') {
      answered.add(messages[next].tool_call_id)
      out.push(messages[next])
      next++
    }
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue
      out.push({ role: 'tool', tool_call_id: call.id, content: 'No result was recorded for this call.' })
    }
    index = next - 1
  }
  return out
}

export function snapshotMetrics(memory) {
  const metrics = memory.metrics
  return {
    ...metrics,
    durationMs: Date.now() - metrics.startedAt,
  }
}
