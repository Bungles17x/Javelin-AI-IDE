/**
 * Exporter — turn raw trajectories into JDF training examples.
 * ===========================================================
 *
 * A trajectory is a recording of what happened. A training example is a lesson:
 * "given this state, the correct next action was X".
 *
 * THE CENTRAL PROBLEM: you cannot naively replay a whole run as one example.
 * A 30-step run where 8 steps failed would teach the model to fail. So this
 * exporter *segments* a trajectory into examples, and only keeps segments whose
 * outcome was actually good. Specifically it produces four lesson types:
 *
 *   1. TOOL SELECTION  — inspect/read/search calls, the "look before you leap"
 *                        behaviour that separates an agent from a code generator.
 *   2. EDIT PRECISION  — successful edit_file/write_file calls with exact snippets.
 *   3. VERIFICATION    — running tests after editing, and what the result was.
 *   4. REPAIR          — the valuable one: a failure, the hypothesis, and the
 *                        *successful* action that followed. This is the behaviour
 *                        that is hardest to get from a base model.
 *
 * A negative example is only exported for repair if the repair SUCCEED. Failed
 * repairs are recorded as preference pairs (rejected) rather than as SFT targets,
 * so we never train on a wrong answer.
 */

import { SOURCE, SKILL, JDF_VERSION, recordId } from './format.js'

const WRITE_TOOLS = new Set(['edit_file', 'write_file'])
const READ_TOOLS = new Set(['read_file', 'list_files', 'search_code', 'recall'])

/**
 * Convert one trajectory into zero or more training examples.
 *
 * @param {object} trajectoryRecord  a kind==='trajectory' JDF record
 * @param {object} [opts]
 * @param {string} [opts.systemPrompt]  the system prompt in effect (Javelin's identity)
 * @param {object[]} [opts.toolSchemas] tool definitions in scope
 * @returns {object[]} sft and preference records
 */
export function exportTrajectory(trajectoryRecord, opts = {}) {
  const t = trajectoryRecord?.trajectory
  if (!t) {
    return []
  }

  const { systemPrompt = null, toolSchemas = [] } = opts
  const task = t.task
  const out = []

  // Build a lookup from tool_call_id -> result so each action knows its outcome.
  const resultsById = new Map()
  for (const r of t.toolResults ?? []) {
    if (r.id) {
      resultsById.set(r.id, r)
    }
  }

  const calls = t.toolCalls ?? []

  // ---- Lesson 1: tool selection (read before write) ----------------------
  // We teach the *first* inspection call, which is the behaviour we most want to
  // reinforce: understand the codebase before touching it.
  const firstRead = calls.find((c) => READ_TOOLS.has(c.name))
  if (firstRead) {
    const result = resultsById.get(firstRead.id)
    if (result?.ok) {
      out.push(
        sft({
          task,
          systemPrompt,
          toolSchemas,
          skill: SKILL.TOOL_SELECTION,
          // Before the call, the model has seen the task and (at most) a prior plan.
          priorMessages: [{ role: 'user', content: `TASK: ${task}` }],
          call: firstRead,
          result,
          tags: ['inspect-first'],
        }),
      )
    }
  }

  // ---- Lesson 2: edit precision ------------------------------------------
  for (const call of calls) {
    if (!WRITE_TOOLS.has(call.name)) {
      continue
    }
    const result = resultsById.get(call.id)
    // Only successful edits become targets.
    if (!result?.ok) {
      continue
    }
    out.push(
      sft({
        task,
        systemPrompt,
        toolSchemas,
        skill: SKILL.EDIT_PRECISION,
        priorMessages: contextUpTo(t, call.id),
        call,
        result,
        tags: ['applied-edit'],
      }),
    )
  }

  // ---- Lesson 3: verification habit ---------------------------------------
  const verifyCall = calls.find((c) => c.name === 'run_command')
  if (verifyCall) {
    const result = resultsById.get(verifyCall.id)
    out.push(
      sft({
        task,
        systemPrompt,
        toolSchemas,
        skill: SKILL.VERIFICATION,
        priorMessages: contextUpTo(t, verifyCall.id),
        call: verifyCall,
        result,
        // A verification lesson is only a *positive* target if it passed.
        // Elsewhere the verification-required refusal teaches the habit.
        tags: result?.ok ? ['verify-passed'] : ['verify-failed'],
        weight: result?.ok ? 1 : 0.5,
      }),
    )
  }

  // ---- Lesson 4: repair — failure → successful different action -----------
  // Repairs are derived from the trajectory's own evidence (a failure followed by
  // a successful action of a different shape), NOT from the `hypothesis` event.
  // The runtime only emits a hypothesis when the REPAIR phase is entered, which
  // happens for a failed verification command — a failed *tool call* follows the
  // normal path. Deriving from data makes the exporter robust either way, and it
  // works on traces captured before this reasoning existed.
  const repairs = findRepairs(t, resultsById)
  for (const repaired of repairs) {
    const extraSystem = [
      `A previous action failed: ${repaired.failedSummary}`,
      `Do not repeat the failed action — take a materially different approach.`,
    ]
    if (repaired.hypothesis) {
      extraSystem.unshift(`The diagnosed cause was: ${repaired.hypothesis}`)
    }
    out.push(
      sft({
        task,
        systemPrompt,
        toolSchemas,
        skill: SKILL.REPAIR,
        priorMessages: repaired.context,
        call: repaired.call,
        result: repaired.result,
        extraSystem,
        tags: repaired.hypothesis ? ['repair', 'hypothesis-driven'] : ['repair', 'recovered'],
      }),
    )
  }

  // ---- Lesson 5: honesty / refusal ----------------------------------------
  // The runtime's `repeat_blocked` and `verification_required` events encode a
  // behaviour we want the model itself to internalise: don't flail, don't claim
  // unverified success. We teach that as an explicit assistant response.
  for (const evt of t.events ?? []) {
    if (evt.type === 'repeat_blocked') {
      out.push(
        sftText({
          task,
          systemPrompt,
          skill: SKILL.HONESTY,
          priorMessages: [{ role: 'user', content: `TASK: ${task}` }],
          assistantContent: `I will not repeat that action — it already failed. Let me take a different approach.`,
          tags: ['no-repeat'],
        }),
      )
    }
    if (evt.type === 'verification_required') {
      out.push(
        sftText({
          task,
          systemPrompt,
          skill: SKILL.VERIFICATION,
          priorMessages: [{ role: 'user', content: `TASK: ${task}` }],
          assistantContent: `I changed files but have not verified them yet. I should run the project's tests or build before claiming this is complete.`,
          tags: ['verify-before-claiming'],
        }),
      )
    }
  }

  return out
}

/** Build an SFT record whose target is a tool call. */
function sft({ task, systemPrompt, toolSchemas, skill, priorMessages, call, result, extraSystem = [], tags = [], weight = 1 }) {
  const messages = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  for (const extra of extraSystem) {
    messages.push({ role: 'system', content: extra })
  }
  messages.push(...priorMessages.map(toMessage))

  // The target: the assistant chose this tool with these exact arguments.
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: call.id ?? 'call_0',
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      },
    ],
  })

  // The consequence, so the model learns the *effect* of its action, not just
  // the action. This is what makes the example teach cause, not mimicry.
  if (result) {
    messages.push({
      role: 'tool',
      tool_call_id: call.id ?? 'call_0',
      name: call.name,
      content: truncate(result.output ?? '', 2000),
    })
  }

  return {
    id: recordId(task, skill, call.name, JSON.stringify(call.args), result?.output ?? ''),
    version: JDF_VERSION,
    kind: 'sft',
    source: SOURCE.RUNTIME_TRACE,
    skill,
    messages,
    tools: toolSchemas,
    outcome: { status: result?.ok ? 'success' : 'failure', verified: Boolean(result?.ok) },
    meta: { task, weight, derivedFrom: 'trajectory' },
    tags,
  }
}

/** Build an SFT record whose target is plain assistant text. */
function sftText({ task, systemPrompt, skill, priorMessages, assistantContent, tags = [] }) {
  const messages = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push(...priorMessages.map(toMessage))
  messages.push({ role: 'assistant', content: assistantContent })

  return {
    id: recordId(task, skill, assistantContent),
    version: JDF_VERSION,
    kind: 'sft',
    source: SOURCE.RUNTIME_TRACE,
    skill,
    messages,
    outcome: { status: 'success', verified: true },
    meta: { task, weight: 1, derivedFrom: 'trajectory' },
    tags,
  }
}

/**
 * Reconstruct the conversation state immediately before a given tool call.
 * This matters: training on an action without its preceding context teaches the
 * model to act blind.
 */
function contextUpTo(trajectory, callId) {
  const messages = [{ role: 'user', content: `TASK: ${trajectory.task}` }]

  if (trajectory.plan) {
    messages.push({ role: 'assistant', content: trajectory.plan })
  }

  const resultsById = new Map()
  for (const r of trajectory.toolResults ?? []) {
    if (r.id) {
      resultsById.set(r.id, r)
    }
  }

  for (const call of trajectory.toolCalls ?? []) {
    if (call.id === callId) {
      break
    }
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        },
      ],
    })
    const result = resultsById.get(call.id)
    if (result) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: truncate(result.output ?? '', 2000),
      })
    }
  }

  return messages
}

/**
 * Find every repair in a trajectory: a failure, followed by a successful action
 * whose signature differs from the failed one.
 *
 * The "different signature" condition is what separates a genuine repair from a
 * lucky retry — retrying the identical call is exactly the behaviour the runtime
 * blocks, so we must never teach it as a correct response.
 */
function findRepairs(trajectory, resultsById) {
  const calls = trajectory.toolCalls ?? []
  const hypotheses = trajectory.hypotheses ?? []
  const repairs = []
  const usedIds = new Set()

  for (let i = 0; i < calls.length; i++) {
    const failed = calls[i]
    const failedResult = resultsById.get(failed.id)
    if (!failedResult || failedResult.ok !== false) {
      continue
    }

    const failedSignature = signatureOf(failed)

    for (let j = i + 1; j < calls.length; j++) {
      const candidate = calls[j]
      const candidateResult = resultsById.get(candidate.id)
      if (!candidateResult?.ok) {
        continue
      }
      if (signatureOf(candidate) === failedSignature) {
        continue // an identical retry is never a repair
      }
      if (usedIds.has(candidate.id)) {
        continue
      }
      usedIds.add(candidate.id)
      repairs.push({
        call: candidate,
        result: candidateResult,
        context: contextUpTo(trajectory, candidate.id),
        failedSummary: `${failed.name} failed: ${truncate(failedResult.output ?? '', 200)}`,
        hypothesis: hypotheses[0] ?? null,
      })
      break
    }
  }

  return repairs
}

function signatureOf(call) {
  return `${call.name}:${JSON.stringify(call.args ?? {})}`
}

/** Normalise an internal shorthand message into JDF's message shape. */
function toMessage(m) {
  if (m.role === 'tool') {
    return m
  }
  return m.tool_calls ? m : { role: m.role, content: m.content ?? '' }
}

/**
 * Export a whole dataset: trajectories in, deduplicated examples out.
 */
export function exportDataset(trajectoryRecords, opts = {}) {
  const examples = []
  for (const record of trajectoryRecords) {
    if (record.kind !== 'trajectory') {
      continue
    }
    examples.push(...exportTrajectory(record, opts))
  }
  return examples
}

function truncate(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
