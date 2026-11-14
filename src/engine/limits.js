/**
 * Javelin Engine — hard limits.
 *
 * Every loop in the engine is bounded here, in one place, so no single run can
 * spend an unbounded amount of time or context. Callers may override the step and
 * time budgets per run; the protective limits stay fixed.
 */

/** Maximum model turns in one run. */
// Enough headroom to build a multi-file project (scaffold, several files, verify),
// while still bounding a runaway loop.
export const MAX_STEPS = 40
/** Text-only turns (no tool call) before the run gives up. */
export const MAX_NO_ACTION_TURNS = 3
/** Byte-identical consecutive answers before the run gives up. */
// One repeated reply triggers an escalation (the duplicate is dropped and a tool call is
// required); only a third identical reply confirms the model cannot act.
export const MAX_IDENTICAL_RESPONSES = 3
/** Consecutive blocked duplicate calls before the run gives up. */
export const MAX_REPEATED_ACTIONS = 3
/** Model turns with no workspace change before the run is declared stalled. */
export const MAX_STALLED_STEPS = 16
/** Characters allowed in one write_file / append_file call. Larger files are chunked. */
export const MAX_WRITE_CHARS = 24_000
/** Output budget requested from the model per turn, in tokens. */
export const MAX_OUTPUT_TOKENS = 8_192
/**
 * Output budget for a model running on this machine.
 *
 * Local generation is ~17 tokens/s, so the hosted 8k budget let one rambling turn
 * run for eight minutes. A local turn is capped to something a human will wait for;
 * when a file really is longer, the engine sees finish_reason=length and asks for
 * the continuation.
 */
export const LOCAL_MAX_OUTPUT_TOKENS = 1_200
/** A single tool output kept at full size in memory. */
export const MAX_TOOL_OUTPUT_CHARS = 8_000
/** A single tool result as sent to the model. */
export const MAX_TOOL_RESULT_IN_TRANSCRIPT = 6_000
/** Character budget for the whole request transcript. */
export const DEFAULT_CONTEXT_CHARS = 96_000
/** Wall-clock budget for one run. */
export const DEFAULT_RUN_BUDGET_MS = 15 * 60_000
