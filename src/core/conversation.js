/**
 * Conversation layer
 * ==================
 *
 * Javelin's identity is an engineering one: investigate, verify, report honestly.
 * That is correct for work and wrong for "lol". A message with three letters would
 * previously fall through to the agent path and get a work summary, which is how an
 * assistant ends up feeling like a build tool with a chat box.
 *
 * This module adds the missing half without touching the engineering half:
 *
 *   - classifyMessage()    what kind of message is this, really?
 *   - isConversational()   should this bypass the workspace agent?
 *   - withConversationContext()  resolve "why?", "you?", "same" against the thread
 *   - isEcho()             did the model just repeat the user instead of answering?
 *
 * The bias throughout is *do not misroute*. Falsely treating a real task as chat
 * loses the user's work; falsely treating chat as a task produces a lecture. Both
 * are bad, so the task matchers stay strict and narrow.
 */

import { isSmallTalk } from './taskIntent.js'

/** How Javelin talks. Appended to the chat system prompt; never to the agent contract. */
export const CONVERSATION_STYLE = `CONVERSATION
You are talking with a person, not filling a ticket.

- Be warm, quick and a little funny. Match their energy: a short casual message gets a
  short casual reply, not a briefing.
- Read the short stuff. "you?", "why?", "really?", "lol", "same", "k" continue the
  thread you are already in. Answer the thing they mean, not the literal characters.
- Jokes, sarcasm and exaggeration are figurative. "I'm dying", "great, another bug",
  "my code is cursed" are not emergencies and not literal claims — react like a person
  would, then be useful if they want help.
- Never refuse a harmless message. "hi", "lol", "you" are not requests to be declined
  and not prompts for a capabilities speech.
- Never answer by repeating their message back. If they say "hi", "hi" is not an answer.
- Ask a follow-up only when it actually moves the conversation forward.
- Keep casual replies to one or two sentences. Spend length on real work.
- If a factual question needs something you cannot verify, say what you know and what
  you are assuming. Never invent endpoints, versions, error causes, or tool results.`

const GREETING = /^(?:hi+|hey+|hello+|yo|hiya|howdy|sup|good (?:morning|afternoon|evening|night))\b[\s!.,?]*$/i
const LAUGH = /^(?:l+o+l+|lmao|lmfao|rofl|haha+|hehe+|hihi+|😂+|🤣+|💀+)[\s!.,?]*$/i
const LAUGH_INLINE = /\b(?:lmao|lmfao|rofl|i(?:'| a)?m (?:dying|crying|dead)|💀|can'?t breathe)\b/i
const THANKS = /^(?:thanks|thank you|thx|ty|appreciate (?:it|you)|cheers)\b[\s!.,?]*$/i
const IDENTITY_Q = /^(?:who are you|what are you|what can you do|are you (?:a |an )?(?:ai|robot|human|real))\b[\s!.,?]*$/i
const REACTION = /^(?:you|u|me|same|really|for real|seriously|no way|what|why|how come|how so|and|so|then|huh|ok(?:ay)?|k|cool|nice|wow|damn|oof|rip|bruh|yeah|yep|yup|nope|nah|sure|right|lol ok)[\s!.,?]*$/i
const CASUAL_Q = /^(?:what'?s up|how(?:'s| is) it going|how are you(?: doing)?|you good|you ok|what do you think|thoughts)\b[\s!.,?]*$/i
const TASK_VERB = /\b(?:create|make|build|implement|add|write|fix|refactor|modify|update|change|generate|scaffold|repair|remove|delete|rename|move|install|deploy|run|test|debug|explain the code|read the file)\b/i

/**
 * Classify a message.
 *
 * @param {string} text
 * @returns {{ kind: 'greeting'|'laugh'|'thanks'|'identity'|'reaction'|'casual'|'task', short: boolean }}
 */
export function classifyMessage(text) {
  const raw = String(text ?? '').trim()
  const short = raw.length > 0 && raw.split(/\s+/).length <= 3

  if (!raw) return { kind: 'casual', short: true }
  if (GREETING.test(raw)) return { kind: 'greeting', short: true }
  if (LAUGH.test(raw)) return { kind: 'laugh', short: true }
  if (THANKS.test(raw)) return { kind: 'thanks', short: true }
  if (IDENTITY_Q.test(raw)) return { kind: 'identity', short: true }
  if (REACTION.test(raw)) return { kind: 'reaction', short: true }
  if (CASUAL_Q.test(raw)) return { kind: 'casual', short: true }

  // Playful exaggeration inside an otherwise normal sentence is still chat.
  if (short && LAUGH_INLINE.test(raw)) return { kind: 'laugh', short: true }
  if (isSmallTalk(raw)) return { kind: 'greeting', short: true }
  if (short && !TASK_VERB.test(raw)) return { kind: 'casual', short: true }

  return { kind: 'task', short }
}

/**
 * Should this bypass the workspace agent entirely?
 *
 * Conservative on purpose: a message with any task verb is a task, even if it is
 * also friendly ("hey, can you fix this").
 */
export function isConversational(text) {
  return classifyMessage(text).kind !== 'task'
}

function normalize(text) {
  return String(text ?? '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Give a short follow-up the context it refers to.
 *
 * "why?" out of nowhere is unanswerable; "why?" after an explanation is obvious. The
 * note is added only for referential messages, and only when there is a previous
 * exchange to point at — inventing context would be worse than asking.
 */
export function withConversationContext(text, messages = []) {
  const raw = String(text ?? '').trim()
  const { kind } = classifyMessage(raw)
  if (kind === 'greeting' || kind === 'identity' || kind === 'task') return raw

  const priorUser = [...messages].reverse().find((m) => m?.role === 'user' && String(m.content ?? '').trim() !== raw)
  const priorAssistant = [...messages].reverse().find((m) => m?.role === 'assistant' && String(m.content ?? '').trim())
  if (!priorUser || !priorAssistant) return raw

  const ask = String(priorUser.content).trim().slice(0, 180)
  const answer = String(priorAssistant.content).trim().slice(0, 220)
  return `${raw}\n\n(Context: continuing the same thread. They asked "${ask}" and you answered "${answer}".)`
}

/**
 * Did the model answer with the user's own message?
 *
 * Only exact echoes (or a near-echo no longer than a few characters) count. A short
 * "hi" inside "Hi! What are you working on?" is a normal greeting, not an echo.
 */
export function isEcho(reply, userText) {
  const r = normalize(reply)
  const u = normalize(userText)
  if (!r || !u || u.length < 2) return false
  if (r === u) return true
  return r.length <= u.length + 4 && r.includes(u)
}

/** Instruction used for the single retry when an echo is detected. */
export const ECHO_RETRY_INSTRUCTION =
  'Your previous reply just repeated the user\'s message. Answer it with something new, in one or two sentences.'
