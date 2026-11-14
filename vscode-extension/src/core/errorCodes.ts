/**
 * Stable error codes for the VS Code agent.
 *
 * Kept in sync with `src/engine/errors.js`, which is the source of truth for the IDE.
 * The extension ships as a separate package, so it carries its own copy rather than
 * importing across package boundaries; codes are API and must never be renumbered.
 */
export const ERROR_CODES = {
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
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export const ERROR_TITLES: Record<string, string> = {
    'ER.0101': 'The model endpoint could not be reached',
    'ER.0102': 'The model rejected the credential',
    'ER.0103': 'The model stopped responding',
    'ER.0104': 'The model returned no usable response',
    'ER.0105': 'The model configuration is invalid',
    'ER.0106': 'The model call failed',
    'ER.0201': 'The step limit was reached',
    'ER.0202': 'The model never took a tool action',
    'ER.0203': 'The model repeated the same response',
    'ER.0204': 'Repeated actions made no progress',
    'ER.0205': 'The requested workspace change never happened',
    'ER.0206': 'The run exceeded its time budget',
    'ER.0207': 'The task\u2019s requested files were not all created',
    'ER.0301': 'The run was stopped by the user',
    'ER.0401': 'A tool call failed',
    'ER.0402': 'A tool call had invalid arguments',
    'ER.0403': 'An unsupported tool was requested',
    'ER.0501': 'The user denied the action',
    'ER.0601': 'A write could not be verified',
    'ER.0602': 'The safety checkpoint could not be created',
    'ER.0701': 'An internal engine error occurred',
    'ER.0000': 'The run failed for an unclassified reason',
};

export function errorTitle(code: string | null | undefined): string {
    return (code && ERROR_TITLES[code]) || 'Unknown error';
}

export function isErrorCode(value: unknown): value is ErrorCode {
    return typeof value === 'string' && /^ER\.\d{4}$/.test(value);
}

/** Map a provider/transport failure message onto a code. */
export function classifyModelError(error: unknown): ErrorCode {
    const message = String((error as any)?.message ?? error ?? '');
    if (/requires an api key|api.key|unauthorized|invalid api|401\b|403\b|authentication/i.test(message)) {
        return ERROR_CODES.MODEL_AUTH;
    }
    if (/must use https|no model is selected|not configured|disabled|invalid provider|unknown provider/i.test(message)) {
        return ERROR_CODES.MODEL_CONFIG;
    }
    if (/stopped responding|did not finish within|timed out|timeout|idle/i.test(message)) {
        return ERROR_CODES.MODEL_TIMEOUT;
    }
    if (/could not reach|econnrefused|enotfound|econnreset|eai_again|network|fetch failed|socket hang up/i.test(message)) {
        return ERROR_CODES.MODEL_UNREACHABLE;
    }
    return ERROR_CODES.MODEL_FAILED;
}
