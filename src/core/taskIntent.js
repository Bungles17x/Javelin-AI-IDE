const SMALL_TALK = /^(?:hi|hello|hey|how are you(?: doing)?|good morning|good afternoon|good evening|thanks|thank you|what(?:'s| is) up|who are you|what can you do)[.!?]*$/i

export function isSmallTalk(text) {
  return SMALL_TALK.test(String(text ?? '').trim())
}

const WORKSPACE_CHANGE_REQUEST = /\b(create|make|build|implement|add|write|fix|refactor|modify|update|change|generate|scaffold|repair|remove|delete|rename|move)\b/i
const ACTION_VERBS = 'create|make|build|implement|add|write|fix|refactor|modify|update|change|generate|scaffold|repair|remove|delete|rename|move'
const DIRECT_WORKSPACE_ACTION = new RegExp(
  `(?:^|\\n)\\s*(?:(?:step\\s+\\d+|[-*]|\\d+)[.):]\\s*)?(?:please\\s+)?(?:${ACTION_VERBS})\\b`,
  'i',
)
const POLITE_WORKSPACE_ACTION = new RegExp(
  `\\b(?:can|could|would)\\s+you\\s+(?:please\\s+)?(?:${ACTION_VERBS})\\b|\\b(?:i want|i need)\\s+you\\s+to\\s+(?:${ACTION_VERBS})\\b`,
  'i',
)
const CONTINUATION_REQUEST = /^(?:(?:please\s+)?(?:continue|go on|keep going|carry on|proceed|resume|try again|keep working|finish it)(?:\s+(?:the task|with it|with that|from where you left off|where you left off))?|fix this and continue)[.!?\s]*$/i

export function taskRequiresWorkspaceChange(text) {
  return WORKSPACE_CHANGE_REQUEST.test(String(text ?? ''))
}

export function shouldRunWorkspaceAgent(text) {
  const prompt = String(text ?? '').replace(/```[\s\S]*?```/g, ' ')
  return DIRECT_WORKSPACE_ACTION.test(prompt) || POLITE_WORKSPACE_ACTION.test(prompt)
}

export function resolveContinuationTask(task, priorMessages = []) {
  const currentTask = String(task ?? '').trim()
  if (!CONTINUATION_REQUEST.test(currentTask)) return currentTask

  const previousRequest = [...priorMessages]
    .reverse()
    .find((message) => message?.role === 'user' && String(message.content ?? '').trim() &&
      !CONTINUATION_REQUEST.test(String(message.content).trim()))
  if (!previousRequest) return currentTask

  return `Continue the previous user request: ${String(previousRequest.content).trim()}\n\nLatest user message: ${currentTask}`
}

export function normalizeAssistantText(text) {
  return String(text ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}