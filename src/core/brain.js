/**
 * Javelin Core — The Brain
 * ========================
 *
 * This is Javelin's own reasoning lifecycle. It is deliberately separate from any
 * model: the brain decides *what* to do, and the engine layer supplies the raw
 * language ability to do it.
 *
 * A run moves through explicit cognitive phases, each with its own prompt lens:
 *
 *   UNDERSTAND → PLAN → ACT → OBSERVE → VERIFY → (REPAIR → VERIFY)* → CONCLUDE
 *
 * Two mechanisms make it self-correcting rather than merely retrying:
 *
 *   1. **Failure memory.** A failed action is recorded by signature. The runtime
 *      refuses to re-execute an identical failed call and instead injects the
 *      failure back into the reasoning context as a constraint.
 *   2. **Diagnosis.** When verification fails, Javelin enters a REPAIR phase where
 *      it must state a *hypothesis* about the cause before acting again. That
 *      prevents the classic agent failure mode of blindly flailing at a symptom.
 */

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import { RISK } from './tools.js'

export const PHASE = {
  UNDERSTAND: 'understand',
  PLAN: 'plan',
  ACT: 'act',
  OBSERVE: 'observe',
  VERIFY: 'verify',
  REPAIR: 'repair',
  CONCLUDE: 'conclude',
}

export const PHASE_LABEL = {
  understand: 'Understanding the task and project',
  plan: 'Planning',
  act: 'Making changes',
  observe: 'Reading results',
  verify: 'Verifying',
  repair: 'Diagnosing a failure',
  conclude: 'Wrapping up',
}

import {
  composeIdentity,
  renderModelIdentity,
  renderAgentContract,
  identityFingerprint,
  IDENTITY_VERSION,
} from './identity.js'

export {
  composeIdentity,
  renderModelIdentity,
  renderAgentContract,
  identityFingerprint,
  IDENTITY_VERSION,
}

/**
 * The identity block is the model's character and is now defined in identity.js,
 * so training and inference cannot drift apart. Tool names are NOT baked in here —
 * they are injected per session by `buildPhaseMessages`, which keeps the model's
 * identity independent of the harness it happens to be running in.
 */
export const JAVELIN_IDENTITY = renderModelIdentity()

/** ------------------------------------------------------------------ *
 * Prompt lenses per phase
 * ------------------------------------------------------------------ */

const PHASE_DIRECTIVES = {
  [PHASE.UNDERSTAND]: `PHASE: UNDERSTAND.
Before planning, ground yourself in the actual project. Read the files that matter and search for the symbols involved. Do not propose changes yet — gather facts.`,
  [PHASE.PLAN]: `PHASE: PLAN.
State a short, numbered plan (2-5 steps) naming the specific files you will touch. Then begin executing step 1.`,
  [PHASE.ACT]: `PHASE: ACT.
Execute your plan one action at a time. Prefer the smallest change that achieves the goal.`,
  [PHASE.OBSERVE]: `PHASE: OBSERVE.
Read the tool results carefully. Did the action do what you intended? If not, adjust before continuing.`,
  [PHASE.VERIFY]: `PHASE: VERIFY.
Now confirm the work actually holds. Run the project's tests, build or linter. If there are none, re-read the changed code and check the logic manually. Do not call finish(verified: true) without having run something.`,
  [PHASE.REPAIR]: `PHASE: REPAIR.
Your previous verification FAILED. First state a one-line hypothesis: "The failure is caused by X."
Then act on that hypothesis specifically. Do NOT repeat an action from the failure list — it already did not work.`,
  [PHASE.CONCLUDE]: `PHASE: CONCLUDE.
Call \`finish\` with an honest summary of what changed and whether you verified it.`,
}

/**
 * Build the message list for a given phase, injecting memory and failure context.
 * Memory injection is what makes Javelin feel like it knows the project and
 * remembers its own mistakes, rather than starting cold each turn.
 */
export function buildPhaseMessages(
  { task, phase, transcript, memoryBlock, failures, plan, toolNames = [], canExecuteCommands = true },
) {
  const messages = [
    { role: 'system', content: JAVELIN_IDENTITY },
    // The contract is a separate block describing THIS session's tools. Keeping it
    // distinct from the identity is what lets the identity survive a harness change.
    {
      role: 'system',
      content: renderAgentContract(toolNames, {
        canExecuteCommands,
        canWriteFiles: toolNames.some((n) => /write|edit/.test(n)),
      }),
    },
  ]

  if (memoryBlock) {
    messages.push({ role: 'system', content: memoryBlock })
  }

  if (failures?.length) {
    messages.push({
      role: 'system',
      content:
        'ACTIONS THAT ALREADY FAILED — never repeat these exact calls, they will fail again:\n' +
        failures.map((f) => `- ${f}`).join('\n') +
        '\nFor each, take a materially different approach.',
    })
  }

  if (plan) {
    messages.push({ role: 'system', content: `Your current plan:\n${plan}` })
  }

  messages.push({ role: 'user', content: `TASK: ${task}` })

  // Replay the working transcript so the model sees its own history this run.
  messages.push(...transcript.slice(-24))

  messages.push({ role: 'user', content: PHASE_DIRECTIVES[phase] ?? '' })

  return messages
}

/**
 * Decide the next phase based on what has happened.
 * Keeping this as an explicit function (rather than implicit control flow) means
 * the reasoning lifecycle is inspectable and testable.
 */
export function nextPhase(state) {
  const { phase, stepsTaken, hasEdited, verificationFailed, consecutiveFailures, planStated } = state

  if (consecutiveFailures >= 3) {
    return PHASE.CONCLUDE // give up gracefully rather than loop forever
  }
  if (verificationFailed) {
    return PHASE.REPAIR
  }
  if (phase === PHASE.UNDERSTAND) {
    return stepsTaken >= 1 ? PHASE.PLAN : PHASE.UNDERSTAND
  }
  if (phase === PHASE.PLAN) {
    return planStated ? PHASE.ACT : PHASE.PLAN
  }
  if (phase === PHASE.ACT) {
    return hasEdited ? PHASE.VERIFY : PHASE.ACT
  }
  if (phase === PHASE.VERIFY) {
    return PHASE.CONCLUDE
  }
  if (phase === PHASE.REPAIR) {
    return PHASE.VERIFY
  }
  return PHASE.CONCLUDE
}

/**
 * Should we demand verification before allowing finish()?
 * A run that edited files but never ran anything is not "verified", and we make
 * that explicit rather than letting the model assert success.
 */
export function verificationPolicy({ hasEdited, verificationAvailable, commandCount }) {
  if (!hasEdited) {
    return { required: false, reason: 'no files were changed' }
  }
  if (!verificationAvailable) {
    return {
      required: false,
      reason: 'no test/build command is available in this environment — manual review needed',
    }
  }
  if (commandCount === 0) {
    return { required: true, reason: 'files changed but nothing was executed to verify them' }
  }
  return { required: false, reason: 'verification was attempted' }
}

/**
 * Detect whether a command is a *verification* command and whether it passed.
 * Used to decide whether we are in a REPAIR loop.
 */
export function classifyCommandResult(command, exitCode) {
  const isVerification = /test|build|lint|typecheck|type-check|check|vet|compile/i.test(command)
  return {
    isVerification,
    passed: exitCode === 0,
    failedVerification: isVerification && exitCode !== 0,
  }
}

/**
 * Extract a plan statement from free text, so we can surface it in the UI and
 * feed it back as a standing instruction.
 */
export function extractPlan(text) {
  if (!text) {
    return null
  }
  const lines = text.split('\n')
  const numbered = lines.filter((l) => /^\s*(\d+[.)]|[-*])\s+\S/.test(l))
  if (numbered.length >= 2) {
    return numbered.slice(0, 8).join('\n')
  }
  return null
}

/**
 * Parse a stated plan into individual task steps, in order.
 *
 * `extractPlan` returns one blob of text, which can only be displayed. Splitting the
 * plan into steps lets the UI show a real checklist and tick steps off as the run
 * progresses — so "what will it do" and "what has it done" are the same view.
 */
export function extractPlanSteps(text) {
  if (!text) {
    return []
  }
  const steps = []
  for (const raw of text.split('\n')) {
    const match = raw.match(/^\s*(?:\d+[.)]|[-*\u2022])\s+(\S.*)$/)
    if (!match) continue
    // Strip an optional bold wrapper so the text reads as a task, not markdown source.
    const step = match[1].replace(/\*\*/g, '').trim()
    if (step) steps.push(step)
  }
  return steps.slice(0, 12)
}

/**
 * A one-line hypothesis extractor for the REPAIR phase.
 * We look for the model explicitly naming a cause; if absent, we synthesise a
 * generic instruction so the next action is still hypothesis-driven.
 */
export function extractHypothesis(text) {
  if (!text) {
    return null
  }
  const match = text.match(/(?:cause|caused by|because|the (?:bug|issue|problem) is|hypothesis:?)\s*(.{10,200})/i)
  if (match) {
    return match[1].trim()
  }
  return null
}

/** Summarise a run for the user, honestly reflecting what was and was not verified. */
export function summariseRun({ status, summary, steps, checkpoints, filesTouched, verified, verificationReason }) {
  const bits = []
  bits.push(summary || (status === 'done' ? 'Completed.' : 'Run ended.'))

  if (filesTouched?.length) {
    bits.push(`Changed ${filesTouched.length} file(s): ${filesTouched.join(', ')}.`)
  } else if (status === 'done') {
    bits.push('No files were changed.')
  }

  if (checkpoints?.length) {
    bits.push(`${checkpoints.length} checkpoint(s) available to revert.`)
  }

  if (verified) {
    bits.push('Verification passed.')
  } else if (verificationReason) {
    bits.push(`Not verified — ${verificationReason}.`)
  }

  const failedSteps = steps.filter((s) => s.ok === false).length
  if (failedSteps) {
    bits.push(`${failedSteps} action(s) failed and were worked around.`)
  }

  return bits.join(' ')
}

/** Tools that mutate state — used to gate approval and to know when to verify. */
export function isMutating(risk) {
  return risk === RISK.WRITE || risk === RISK.EXECUTE
}
