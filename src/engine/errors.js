/**
 * Stable error codes.
 *
 * Every run that does not finish cleanly reports one of these codes on its result and
 * on its `error` event, so a failure can be identified from a screenshot, a log line
 * or a bug report without guessing which summary text it was.
 *
 * Format: `ER.CCNN` — category, then a sequence number.
 *
 *   01  model transport and provider configuration
 *   02  loop bounds (the run was stopped to prevent a loop)
 *   03  user control (the run was stopped on purpose)
 *   04  tools
 *   05  approvals
 *   06  workspace safety and verification
 *   07  engine internals
 *   00  unknown / not classified
 *
 * Codes are API: never renumber or reuse one. Add a new code instead.
 */

export const ERROR_CODES = Object.freeze({
  MODEL_UNREACHABLE: 'ER.0101',
  MODEL_AUTH: 'ER.0102',
  MODEL_TIMEOUT: 'ER.0103',
  MODEL_EMPTY: 'ER.0104',
  MODEL_CONFIG: 'ER.0105',
  MODEL_FAILED: 'ER.0106',

  STEP_LIMIT: 'ER.0201',
  NO_ACTION: 'ER.0202',
  IDENTICAL_RESPONSES: 'ER.0203',
  REPEATED_ACTIONS: 'ER.0204',
  STALLED: 'ER.0205',
  TIME_BUDGET: 'ER.0206',
  MISSING_FILES: 'ER.0207',

  ABORTED: 'ER.0301',

  TOOL_FAILED: 'ER.0401',
  TOOL_ARGUMENTS: 'ER.0402',
  TOOL_UNSUPPORTED: 'ER.0403',

  APPROVAL_DENIED: 'ER.0501',

  VERIFICATION_FAILED: 'ER.0601',
  CHECKPOINT_FAILED: 'ER.0602',

  ENGINE_ERROR: 'ER.0701',
  UNKNOWN: 'ER.0000',
})

export const ERROR_TITLES = Object.freeze({
  [ERROR_CODES.MODEL_UNREACHABLE]: 'The model endpoint could not be reached',
  [ERROR_CODES.MODEL_AUTH]: 'The model rejected the credential',
  [ERROR_CODES.MODEL_TIMEOUT]: 'The model stopped responding',
  [ERROR_CODES.MODEL_EMPTY]: 'The model returned no usable response',
  [ERROR_CODES.MODEL_CONFIG]: 'The model configuration is invalid',
  [ERROR_CODES.MODEL_FAILED]: 'The model call failed',
  [ERROR_CODES.STEP_LIMIT]: 'The step limit was reached',
  [ERROR_CODES.NO_ACTION]: 'The model never took a tool action',
  [ERROR_CODES.IDENTICAL_RESPONSES]: 'The model repeated the same response',
  [ERROR_CODES.REPEATED_ACTIONS]: 'Repeated actions made no progress',
  [ERROR_CODES.STALLED]: 'The requested workspace change never happened',
  [ERROR_CODES.TIME_BUDGET]: 'The run exceeded its time budget',
  [ERROR_CODES.MISSING_FILES]: 'The task\u2019s requested files were not all created',
  [ERROR_CODES.ABORTED]: 'The run was stopped by the user',
  [ERROR_CODES.TOOL_FAILED]: 'A tool call failed',
  [ERROR_CODES.TOOL_ARGUMENTS]: 'A tool call had invalid arguments',
  [ERROR_CODES.TOOL_UNSUPPORTED]: 'An unsupported tool was requested',
  [ERROR_CODES.APPROVAL_DENIED]: 'The user denied the action',
  [ERROR_CODES.VERIFICATION_FAILED]: 'A write could not be verified',
  [ERROR_CODES.CHECKPOINT_FAILED]: 'The safety checkpoint could not be created',
  [ERROR_CODES.ENGINE_ERROR]: 'An internal engine error occurred',
  [ERROR_CODES.UNKNOWN]: 'The run failed for an unclassified reason',
})

const CODE_PATTERN = /^ER\.\d{4}$/

export function isErrorCode(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value)
}

export function errorTitle(code) {
  return ERROR_TITLES[code] ?? 'Unknown error'
}

/** Display form for a code, e.g. `ER.0203 · The model repeated the same response`. */
export function errorLabel(code) {
  if (!isErrorCode(code)) return ''
  return `${code} · ${errorTitle(code)}`
}

/** Attach a code to a thrown error so the UI and logs can show it. */
export function codeError(error, code) {
  const err = error instanceof Error ? error : new Error(String(error))
  if (isErrorCode(code)) err.code = code
  return err
}

/**
 * Map a transport/provider failure onto a code.
 *
 * Matching is on the message because that is the only stable thing an
 * OpenAI-compatible server gives us; unknown text falls back to a generic code
 * rather than being silently mislabelled.
 */
export function classifyModelError(error) {
  if (isErrorCode(error?.code)) return error.code
  const message = String(error?.message ?? error ?? '')

  if (/requires an api key|api.key|unauthorized|invalid api|401\b|403\b|authentication/i.test(message)) {
    return ERROR_CODES.MODEL_AUTH
  }
  if (/must use https|no model is selected|not configured|disabled|invalid provider|unknown provider/i.test(message)) {
    return ERROR_CODES.MODEL_CONFIG
  }
  if (/stopped responding|did not finish within|timed out|timeout|idle/i.test(message)) {
    return ERROR_CODES.MODEL_TIMEOUT
  }
  if (/could not reach|econnrefused|enotfound|econnreset|eai_again|network|fetch failed|socket hang up|getaddrinfo/i.test(message)) {
    return ERROR_CODES.MODEL_UNREACHABLE
  }
  if (/returned no|empty response|no usable/i.test(message)) {
    return ERROR_CODES.MODEL_EMPTY
  }
  if (/provider error|returned http|http \d\d\d|model call failed/i.test(message)) {
    return ERROR_CODES.MODEL_FAILED
  }
  return ERROR_CODES.MODEL_FAILED
}
