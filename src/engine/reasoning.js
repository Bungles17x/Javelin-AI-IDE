/**
 * Javelin Engine — reasoning policy.
 *
 * Prompt construction, plan extraction and the rules that decide when a run may
 * claim success. Kept separate from the loop so the policy can be read, tested and
 * changed without touching scheduling, transport or memory code.
 */

import { sanitizeAssistantOutput } from '../core/assistantOutput.js'

/** Phases surfaced to the UI so the user can see what the agent is doing. */
export const PHASE = {
  INSPECT: 'inspect',
  PLAN: 'plan',
  ACT: 'act',
  VERIFY: 'verify',
  RECOVER: 'recover',
  DONE: 'done',
}

export const FAILURE_REMINDER_PREFIX = 'Actions you have ALREADY TRIED AND FAILED'

export const FINISH_REFUSAL =
  'Finish refused: this task asks for a workspace change, but no file or folder change has succeeded. ' +
  'A file listing or checkpoint alone is not completion. Inspect the relevant files, make the requested change, and verify it before finishing.'

export const VERIFICATION_CLAIM_NOTE =
  'You marked this verified, but no passing test, typecheck, lint or build command ran after your last change. It will be reported as LIKELY, not VERIFIED. Run `verify_project` if a check exists, or set verified: false with an honest account of what you checked.'

export const DIAGNOSIS_NOTE =
  'Two or more actions have now failed. Before your next action, state one line of root-cause analysis: what the failure evidence shows, why the previous approach did not work, and what you will do differently. Then take a different action that tests that hypothesis. Do not repeat a failed call.'

export const FINAL_STEP_NOTE =
  'This is your final step. Either call one more tool that completes the requested work, or call `finish` with an honest summary of what changed and what you verified.'

export const CONTINUE_AFTER_REFUSAL =
  'Continue the requested implementation. Do not create another checkpoint or call finish until a file or folder change succeeds.'

export function noActionNudge(repeated) {
  return (
    (repeated
      ? 'You repeated the same message instead of acting, so it was removed from the conversation. Do not restate it. '
      : 'You described an action but did not perform it. Do not narrate what you would do. ') +
    'Your next reply must be exactly one tool call and no prose. ' +
    'Call a relevant tool now (list_files, read_file, search_code, write_file, edit_file, append_file, create_folder, run_command). ' +
    'If the requested work is genuinely complete and verified, call `finish`.'
  )
}

export const AGENT_SYSTEM_PROMPT = `You are Javelin AI, an autonomous coding agent working inside a user's project. You do not just answer questions — you inspect the codebase, plan, make edits, run tests, and fix your own mistakes.

Operating rules:
1. INVESTIGATE BEFORE EDITING. You must call list_files / read_file / search_code to understand the relevant code before you change anything. Never invent file paths — verify they exist.
2. READ BEFORE YOU WRITE. Always read a file before editing it. Use edit_file with an exact snippet for changes; if that snippet repeats, use the 1-based occurrence number and context provided by the error. Use write_file for new files and create_folder for explicit directories.
2b. BUILDING SOMETHING NEW: call create_project ONLY when the task explicitly asks for a game, 3D scene, web app or landing page; use the matching template (game, 3d, web-app, landing). It writes a complete working project in one call — read the generated files, then customise them with edit_file. For a single named file (for example "create hello.html"), use write_file with that exact path and do not create a project.
3. NEVER OVERWRITE BLINDLY. Do not replace a whole file to change a few lines. Match existing style, imports, and conventions. For a file too large to write in one call, write the first chunk with write_file and extend it with append_file — chunked appends are expected for long files, and are safer than truncating one.
3b. LARGE FILES ARE NORMAL. A file may be thousands of lines. Build it in sections: write_file for the top of the file, then one append_file per following section (150–250 lines, under 24,000 characters per call). Never shrink the requested file to fit one call, never re-emit text you already wrote, and never call a file complete while your last section stopped mid-line — read the tail with read_file to confirm it ends cleanly.
4. PLAN AND ACT IN THE SAME TURN. A plan is never a reply on its own. Your first reply for a change task must contain the tool call that begins the work; at most one short sentence of plan may come before it. If you only describe steps, you have done nothing.
5. USE WORKSPACE-RELATIVE PATHS. Every path is relative to the project root, like \`src/app.js\`. Never prefix it with \`./\`, a drive letter, or an absolute path. Reuse the exact path a tool returned.
6. VERIFY YOUR WORK. Use run_command for project commands (tests, builds, scripts, or development servers) when that tool is available. If a command fails, read the output, fix the cause, and retry.
7. DO NOT REPEAT FAILED STEPS. If an action failed, change your approach. Repeating an identical call that already failed is not allowed.
8. CHECKPOINT BEFORE RISKY WORK. Call create_checkpoint before a batch of related edits.
9. DO NOT CONFUSE INSPECTION WITH COMPLETION. For a task asking you to create, fix, or change something, a file listing or checkpoint is not enough — make a successful file or folder change before finishing. Seeing only a package-lock file is not proof the requested feature cannot be created.
10. STOP WHEN DONE. Call \`finish\` with an honest summary. Set verified: true only if you actually ran tests or a build and they passed.
11. EVIDENCE, NOT GUESSES. Cite the exact file and line for a diagnosis (\`path:line\`). Never invent a file, function, API, dependency, error message or test result. If you have not inspected something, say so instead of filling the gap.\n12. ROOT CAUSE BEFORE FIX. Separate the root cause from its symptoms. On a failure, state a one-line hypothesis ("The failure is caused by X") and test that hypothesis; do not keep retrying variations of the same failed action.\n13. LABEL CONFIDENCE. When you report a diagnosis or a fix, classify it: VERIFIED (direct evidence and a passing check), LIKELY (evidence, not fully tested), or UNVERIFIED (a hypothesis that needs investigation). Never present UNVERIFIED as fact.\n14. USE THE PROJECT MAP. \`project_overview\` and \`find_references\` are indexed from the real workspace: use them to locate architecture and the blast radius of a change instead of loading or guessing the whole project.\n15. VERIFY FOR REAL. After changing code, call \`verify_project\` (or run the project's test/build command) and read the actual result. \`verified: true\` is only honest when that command exited 0 after your last change.\n16. REPORT THE WORK. In your finish summary for a fix, state what was wrong, the root cause, the files changed, what you changed, which commands ran and their real results, and any remaining issues. Keep it concise and do not claim more than the evidence supports.\n\nWork efficiently: request several independent reads in one turn instead of one per turn, make the smallest correct edit, and stop inspecting once you have what you need. Be concise and be honest when something did not work.`

/** Sent when the model's reply was cut off by its output-token budget. */
export const OUTPUT_LIMIT_NOTE =
  'Your reply hit the output limit and was cut off. Do not restart the file from the beginning: continue it with append_file, sending only the remaining text (about 150–250 lines), then keep appending until the file is complete.'

/** The user-facing task turn. Informational tasks are told not to invent changes. */
export function buildTaskMessage(task, { requiresChange = false } = {}) {
  return requiresChange
    ? `Task: ${task}\n\nYour first reply must be a tool call that inspects the project (list_files, project_overview, read_file or search_code), not a plan or an explanation. Inspect first, then make the smallest correct change and verify it.`
    : `Task: ${task}\n\nIf this needs project-specific facts, inspect the relevant files first. Otherwise, answer directly. Do not invent workspace changes; finish with your answer.`
}

/**
 * Prior conversation, sanitised.
 *
 * Tool protocol text (`<tool_response>…`) must never reach the model as assistant
 * speech: it teaches the model to emit protocol noise instead of tool calls.
 */
export function sanitizePriorMessages(priorMessages = []) {
  return priorMessages
    .filter((message) => message?.role !== 'assistant' || sanitizeAssistantOutput(message.content))
    .slice(-12)
    .map((message) => ({ role: message.role, content: String(message.content ?? '') }))
    .filter((message) => message.content.trim())
}

/** Parse a short numbered or bulleted plan out of the model's first turn. */
export function extractPlan(text) {
  const steps = []
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.{3,160})$/)
    if (!match) continue
    steps.push(match[1].replace(/\*\*/g, '').trim())
    if (steps.length >= 12) break
  }
  return steps
}

export function isFailureReminder(message) {
  return (
    message?.role === 'system' &&
    typeof message.content === 'string' &&
    message.content.startsWith(FAILURE_REMINDER_PREFIX)
  )
}

export function failureReminder(memory) {
  const failures = [...memory.attempts.entries()]
    .filter(([, value]) => value.failed)
    .map(([signature]) => `- ${signature}`)
  if (!failures.length) return null
  return {
    role: 'system',
    content:
      `${FAILURE_REMINDER_PREFIX} — never repeat these exact calls:\n` +
      failures.join('\n') +
      '\nTake a different approach for each.',
  }
}

/**
 * Put failure memory immediately after the system prompt.
 *
 * Inserting it later can split an assistant `tool_calls` message from its `tool`
 * results, and a provider rejects that transcript — which silently costs the model
 * every result it needs to continue.
 */
export function insertFailureReminder(messages, memory) {
  const kept = messages.filter((message) => !isFailureReminder(message))
  const reminder = failureReminder(memory)
  if (!reminder) return kept
  const [system, ...rest] = kept
  return system ? [system, reminder, ...rest] : [reminder, ...kept]
}

/** Has any file or folder actually changed in this run? */
export function hasSuccessfulMutation(steps, mutatingTools) {
  return steps.some((record) => record.ok && mutatingTools.includes(record.name))
}
