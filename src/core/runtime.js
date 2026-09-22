/**
 * Javelin Core — Runtime
 * ======================
 *
 * The runtime is Javelin's own control loop. It owns:
 *   - the cognitive phase machine (understand → plan → act → verify → repair)
 *   - tool dispatch with approval gating and hard refusals
 *   - failure tracking that prevents repeating a dead action
 *   - memory observation (every attempt is recorded, learnings are distilled)
 *   - verification policy (no unverified "done")
 *
 * It is engine-agnostic: swap the engine and the behaviour is Javelin's, unchanged.
 * It is workspace-agnostic: the web app hands it a virtual workspace, VS Code hands
 * it the real filesystem.
 */

import {
  PHASE,
  PHASE_LABEL,
  buildPhaseMessages,
  nextPhase,
  verificationPolicy,
  classifyCommandResult,
  extractPlan,
  extractPlanSteps,
  extractHypothesis,
  summariseRun,
} from './brain.js'
import { createStandardToolset, RISK, AUTONOMY } from './tools.js'
import { actionSignature, JavelinMemory } from './memory.js'

export const DEFAULT_MAX_STEPS = 30
const MAX_CONSECUTIVE_FAILURES = 3

/**
 * @typedef {object} RunOptions
 * @property {string} task
 * @property {object} workspace
 * @property {import('./engines.js').EngineRegistry} engines
 * @property {AbortSignal} [signal]
 * @property {JavelinMemory} [memory]
 * @property {object} [tools]
 * @property {(cmd: string, signal?: AbortSignal) => Promise<{exitCode:number,stdout:string,stderr:string}>} [runCommand]
 * @property {(evt: object) => void} [onEvent]
 * @property {(req: object) => Promise<{approved: boolean, remember?: boolean}>} [requestApproval]
 * @property {number} [maxSteps]
 * @property {boolean} [autoApproveSafeCommands]
 * @property {'ask'|'auto-edit'|'full'} [autonomy]  how much to act without asking
 * @property {(result: object, events: object[]) => void} [onTrajectory]  called once per run with the finished result (used for training-data capture)
 */

/**
 * Run Javelin against a task.
 * @param {RunOptions} opts
 */
/**
 * Public entry point. Wraps the loop so any pending trajectory capture is settled
 * before the caller regains control — a capture write must never be observed
 * half-done (a test reading the traces dir, or a CLI listing it, would race).
 */
export async function runJavelin(opts) {
  const captured = []
  const result = await runLoop({
    ...opts,
    // Capture the promise the loop produces, so we can await it below.
    _collectCapture: captured,
  })
  if (captured.length) {
    await Promise.allSettled(captured)
  }
  return result
}

async function runLoop(opts) {
  const {
    task,
    workspace,
    engines,
    signal,
    tools = createStandardToolset(),
    runCommand,
    onEvent: userOnEvent = () => { },
    requestApproval = async () => ({ approved: false }),
    maxSteps = DEFAULT_MAX_STEPS,
    autoApproveSafeCommands = true,
    autonomy = AUTONOMY.ASK,
    onTrajectory,
    _collectCapture,
  } = opts
  // Kept only when a capture hook is present, so a normal run retains no extra state.
  const capturedEvents = onTrajectory ? [] : null

  const memory = opts.memory ?? new JavelinMemory()

  /** Session state. Everything the phase machine needs to make a decision. */
  const state = {
    phase: PHASE.UNDERSTAND,
    stepsTaken: 0,
    hasEdited: false,
    planStated: false,
    plan: null,
    consecutiveFailures: 0,
    verificationFailed: false,
    verificationReason: null,
    commandCount: 0,
    verified: false,
  }

  const run = {
    status: 'failed',
    summary: '',
    steps: [],
    checkpoints: [],
    filesTouched: new Set(),
    alwaysAllow: new Set(),
    /** Id of the automatic pre-run checkpoint — the guaranteed revert target. */
    baseline: null,
  }

  const transcript = []
  const failures = []
  const hypotheses = []

  // Single funnel for every emitted event. When capture is on, the same events that
  // drive the UI also become the trajectory's evidence — captured once, not re-derived.
  // Wrap the caller's listener so every emit is recorded, without touching the ~30
  // call sites. The wrapper is the identity when capture is off, so a normal run has
  // exactly the same behaviour and cost as before.
  const onEvent = capturedEvents
    ? (evt) => {
      capturedEvents.push(evt)
      userOnEvent(evt)
    }
    : userOnEvent

  // Record the plan text and note progress while streaming.
  emit(onEvent, { type: 'phase', phase: state.phase, label: PHASE_LABEL[state.phase] })
  emit(onEvent, { type: 'run_started', task })

  // AUTOMATIC BASELINE.
  //
  // The agent is *told* to checkpoint before risky work, but an agent that
  // corrupts a file is exactly the agent that skipped that step. So the safety net
  // is taken here, before the first tool call — the agent cannot forget it, decline
  // it, or run before it exists. This is what makes "revert everything" always
  // available, even after a run that went badly wrong.
  try {
    const baseline = workspace.snapshot(
      `Start of run — ${task.slice(0, 48)}${task.length > 48 ? '…' : ''}`,
    )
    run.checkpoints.push(baseline)
    run.baseline = baseline.id
    emit(onEvent, { type: 'checkpoint', checkpoint: baseline })
  } catch (error) {
    // A workspace we cannot snapshot is a workspace we cannot safely edit.
    run.status = 'failed'
    run.summary =
      `Could not take a safety checkpoint before starting (${error.message}). ` +
      `Nothing was changed — refusing to edit files we cannot revert.`
    return finalise()
  }

  if (signal?.aborted) {
    return finishAborted()
  }

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) {
        return finishAborted()
      }

      const engine = await engines.bestAvailable(state.phase === PHASE.PLAN ? 'plan' : 'primary')

      emit(onEvent, {
        type: 'phase',
        phase: state.phase,
        label: PHASE_LABEL[state.phase],
        engine: engine.label,
      })

      // Before each reasoning turn, refresh the memory block so newly learned
      // facts and failures are visible immediately.
      const memoryBlock = buildMemoryBlock(memory, task, state, failures)

      let response
      try {
        response = await engine.generate({
          messages: buildPhaseMessages({
            task,
            phase: state.phase,
            transcript,
            memoryBlock,
            failures,
            plan: state.plan,
            // The session's real tool surface, so the contract block describes
            // what is genuinely available rather than a remembered toolset.
            toolNames: tools.active().map((t) => t.name),
            canExecuteCommands: Boolean(runCommand),
          }),
          tools: tools.schemas(),
          signal,
          onToken: (delta) => emit(onEvent, { type: 'thinking_delta', delta }),
        })
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          return finishAborted()
        }
        emit(onEvent, { type: 'engine_error', error: err.message })
        run.summary = `Engine failure: ${err.message}`
        run.status = 'failed'
        return finalise()
      }

      const text = response.text ?? ''
      const toolCalls = response.toolCalls ?? []

      if (text.trim()) {
        emit(onEvent, { type: 'thinking', content: text.trim() })
        transcript.push({ role: 'assistant', content: text.trim() })

        // Capture the plan the first time the model states one.
        if (state.phase === PHASE.PLAN && !state.planStated) {
          const plan = extractPlan(text)
          if (plan) {
            state.plan = plan
            state.planStated = true
            // Emit both the raw plan and it parsed into task steps, so the UI can
            // render a checklist it can tick off as the run progresses.
            emit(onEvent, { type: 'plan', plan, steps: extractPlanSteps(plan) })
          }
        }

        // Capture a hypothesis during a repair cycle.
        if (state.phase === PHASE.REPAIR) {
          const h = extractHypothesis(text)
          if (h) {
            hypotheses.push(h)
            state.plan = `Repair hypothesis: ${h}`
            emit(onEvent, { type: 'hypothesis', hypothesis: h })
          }
        }
      }

      // No tool calls: the model is reasoning out loud. Advance the phase or
      // nudge it toward action.
      if (!toolCalls.length) {
        if (state.phase === PHASE.UNDERSTAND) {
          state.phase = PHASE.PLAN
          continue
        }
        if (state.phase === PHASE.PLAN && !state.planStated) {
          // accept prose as an implicit plan and move on
          state.planStated = true
          state.phase = PHASE.ACT
          continue
        }
        // From here on the model was expected to ACT. A turn that only *describes*
        // a change has done nothing — push it to actually call the tool rather than
        // letting prose count as work and drifting to a false "done".
        if (state.phase === PHASE.ACT || state.phase === PHASE.OBSERVE || state.phase === PHASE.VERIFY) {
          transcript.push({
            role: 'user',
            content:
              'You described an action but did not perform it. Do not narrate — call the tool ' +
              'NOW to actually make the change (write_file with the full contents, edit_file ' +
              'with the exact old_string/new_string). Then continue.',
          })
          continue
        }
        // CONCLUDE: only a real finish() ends the run. A model that chats here has
        // not signalled completion, so accept it only if it actually did the work;
        // otherwise keep nudging toward a tool call or an explicit finish.
        if (state.phase === PHASE.CONCLUDE) {
          if (state.stepsTaken > 0 || state.hasEdited) {
            run.status = 'done'
            run.summary = text.trim() || 'Completed.'
            return finalise()
          }
          transcript.push({
            role: 'user',
            content:
              'Nothing has been changed yet, so the task is not complete. Call the tool that ' +
              'makes the change, or call `finish` with an honest statement that you could not.',
          })
          continue
        }
        // Otherwise nudge.
        transcript.push({
          role: 'user',
          content: 'Continue. Call a tool to make progress, or call `finish` if the task is done.',
        })
        continue
      }

      // Execute each requested tool call.
      for (const call of toolCalls) {
        if (signal?.aborted) {
          return finishAborted()
        }

        const signature = actionSignature(call.name, call.args)

        // --- Block an exact repeat of something that already failed ---------
        if (failures.includes(signature)) {
          const note =
            `BLOCKED: you already tried \`${signature}\` and it failed. ` +
            `Repeating it will fail identically. Take a different approach — ` +
            `re-read the file, add more context, or use a different tool.`
          emit(onEvent, { type: 'repeat_blocked', signature, note })
          transcript.push({ role: 'tool', tool_call_id: call.id, content: note })
          state.consecutiveFailures++
          continue
        }

        // --- finish() -------------------------------------------------------
        if (call.name === 'finish') {
          const verdict = verificationPolicy({
            hasEdited: state.hasEdited,
            verificationAvailable: Boolean(runCommand),
            commandCount: state.commandCount,
          })

          // Refuse an unverified finish if we changed files and could have verified.
          if (verdict.required && !state.verified) {
            const refusal =
              `You edited files but never verified them (${verdict.reason}). ` +
              `Run the project's tests or build before finishing, or explain why you cannot.`
            emit(onEvent, { type: 'verification_required', note: refusal })
            transcript.push({ role: 'tool', tool_call_id: call.id, content: refusal })
            state.phase = PHASE.VERIFY
            state.verificationFailed = true
            continue
          }

          run.status = 'done'
          run.summary = call.args?.summary ?? 'Completed.'
          state.verified = Boolean(call.args?.verified)
          state.phase = PHASE.CONCLUDE
          return finalise()
        }

        // --- Hard refusals --------------------------------------------------
        if (tools.isForbidden(call.name, call.args)) {
          const note = `REFUSED: \`${call.name}\` is classified as destructive and cannot run.`
          emit(onEvent, { type: 'tool_refused', name: call.name, note })
          transcript.push({ role: 'tool', tool_call_id: call.id, content: note })
          continue
        }

        // --- Approval gate --------------------------------------------------
        // The tool registry decides whether policy would gate this; the run's
        // autonomy level decides whether the user has already said "just do it".
        const approvalKey = approvalKeyFor(call)
        const gated = tools.approvalNeeded(call.name, call.args, autonomy)
        const needsApproval =
          gated &&
          !(autoApproveSafeCommands && isAutoSafe(tools, call)) &&
          !run.alwaysAllow.has(approvalKey)

        if (needsApproval) {
          const preview = await safePreview(workspace, call)
          const decision = await requestApproval({
            id: call.id,
            name: call.name,
            args: call.args,
            diff: preview,
            path: call.args?.path ?? call.args?.command,
            risk: tools.get(call.name)?.risk,
          })
          if (decision?.remember) {
            run.alwaysAllow.add(approvalKey)
          }
          if (!decision?.approved) {
            const note = `The user DENIED ${call.name}. Do not retry it. Propose an alternative or stop.`
            failures.push(signature)
            memory.observe({
              task,
              signature,
              tool: call.name,
              args: call.args,
              outcome: 'failure',
              detail: 'denied by user',
            })
            emit(onEvent, {
              type: 'tool_result',
              id: call.id,
              name: call.name,
              ok: false,
              output: note,
            })
            transcript.push({ role: 'tool', tool_call_id: call.id, content: note })
            continue
          }
        }

        // --- Execute --------------------------------------------------------
        emit(onEvent, { type: 'tool_call', id: call.id, name: call.name, args: call.args })

        const outcome = await executeTool(call, {
          tools,
          workspace,
          runCommand,
          signal,
          onEvent,
          memory,
          task,
        })

        state.stepsTaken++

        if (RISK.WRITE === tools.get(call.name)?.risk && outcome.ok) {
          state.hasEdited = true
          // No safety checkpoint needed here: the runtime already took an automatic
          // baseline before the run started, so "revert everything" is always possible.
        }

        if (call.name === 'run_command') {
          state.commandCount++
          const classification = classifyCommandResult(call.args?.command ?? '', outcome.exitCode ?? 1)
          if (classification.isVerification) {
            state.verified = classification.passed
            state.verificationFailed = !classification.passed
            state.verificationReason = classification.passed
              ? null
              : `verification command exited non-zero`
          }
        }

        // --- Record the result ---------------------------------------------
        const record = {
          step: state.stepsTaken,
          name: call.name,
          args: call.args,
          ok: outcome.ok,
          output: outcome.output,
          diff: outcome.diff,
          ts: Date.now(),
        }
        run.steps.push(record)

        if (outcome.ok) {
          state.consecutiveFailures = 0
          memory.observe({
            task,
            signature,
            tool: call.name,
            args: call.args,
            outcome: 'success',
            detail: outcome.output?.slice(0, 200),
          })
        } else {
          state.consecutiveFailures++
          if (!failures.includes(signature)) {
            failures.push(signature)
          }
          memory.observe({
            task,
            signature,
            tool: call.name,
            args: call.args,
            outcome: 'failure',
            detail: outcome.output,
          })
        }

        if (outcome.ok && call.args?.path && tools.get(call.name)?.risk === RISK.WRITE) {
          run.filesTouched.add(call.args.path)
        }

        emit(onEvent, {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          ok: outcome.ok,
          output: outcome.output,
          diff: outcome.diff,
        })

        transcript.push({
          role: 'tool',
          tool_call_id: call.id,
          content: truncate(outcome.output, 6000),
        })

        // Learn anything the model explicitly asked us to remember.
        if (call.name === 'remember' && outcome.ok && call.args?.fact) {
          memory.semantic.learn(call.args.fact, { scope: 'project' })
          memory.flush()
        }
      }

      // --- Phase transition ------------------------------------------------
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        run.status = 'failed'
        run.summary =
          `Stopped after ${state.consecutiveFailures} consecutive failures. ` +
          `The last problem was: ${truncate(run.steps.at(-1)?.output ?? 'unknown', 300)}`
        state.phase = PHASE.CONCLUDE
        return finalise()
      }

      if (state.phase === PHASE.REPAIR) {
        // Repair handled; go back and re-verify.
        state.phase = PHASE.VERIFY
        continue
      }

      state.phase = nextPhase(state)
    }

    run.status = 'failed'
    run.summary = `Reached the ${maxSteps}-step limit without finishing.`
    return finalise()
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      return finishAborted()
    }
    run.status = 'failed'
    run.summary = `Unexpected error: ${err.message}`
    emit(onEvent, { type: 'error', error: err.message })
    return finalise()
  }

  // ---------------------------------------------------------------------

  function finalise() {
    const summary = summariseRun({
      status: run.status,
      summary: run.summary,
      steps: run.steps,
      checkpoints: run.checkpoints,
      filesTouched: [...run.filesTouched],
      verified: state.verified,
      verificationReason: state.verificationReason,
    })
    emit(onEvent, {
      type: 'run_finished',
      status: run.status,
      summary,
      verified: state.verified,
      stepCount: run.steps.length,
    })
    memory.flush()
    const result = {
      status: run.status,
      summary,
      rawSummary: run.summary,
      verified: state.verified,
      steps: run.steps,
      checkpoints: run.checkpoints,
      filesTouched: [...run.filesTouched],
      hypotheses,
      baseline: run.baseline,
      memory: memory.snapshot(),
      // Included so an auto-capture hook has the run's own description and plan.
      task,
      plan: state.plan,
    }

    // Fire the capture hook last and never let it affect the result. Capture is an
    // observation; a failure to record is not a failure to complete the task.
    // The hook may be async (it writes a file), so remember its promise and let the
    // caller await it — otherwise a test or CLI could read the directory before the
    // write has landed.
    if (onTrajectory) {
      try {
        const p = Promise.resolve(onTrajectory(result, capturedEvents ?? []))
        if (_collectCapture) {
          _collectCapture.push(p)
        }
      } catch {
        // swallow — see above
      }
    }

    return result
  }

  function finishAborted() {
    run.status = 'aborted'
    run.summary = 'Stopped by user.'
    state.phase = PHASE.CONCLUDE
    return finalise()
  }
}

/** ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function executeTool(call, ctx) {
  const tool = ctx.tools.get(call.name)
  if (!tool) {
    return { ok: false, output: `Unknown tool: ${call.name}` }
  }

  try {
    const result = await tool.execute(call.args ?? {}, {
      workspace: ctx.workspace,
      runCommand: ctx.runCommand,
      emit: ctx.onEvent,
      signal: ctx.signal,
    })

    return result
  } catch (err) {
    return { ok: false, output: `ERROR: ${err.message}` }
  }
}

function safePreview(workspace, call) {
  try {
    const preview = workspace.preview?.(call.name, call.args)
    return preview?.diff ?? null
  } catch {
    return null
  }
}

function approvalKeyFor(call) {
  if (call.name === 'run_command') {
    return `run_command:${String(call.args?.command ?? '').trim()}`
  }
  // Deliberately per-path: "always allow" on deleting one file must never become
  // standing permission to delete a different file.
  if (call.name === 'delete_file') {
    return `delete_file:${String(call.args?.path ?? '')}`
  }
  return call.name
}

function isAutoSafe(tools, call) {
  const tool = tools.get(call.name)
  return Boolean(tool?.autoSafe && tool.risk === RISK.EXECUTE)
}

function buildMemoryBlock(memory, task, state, failures) {
  const base = memory.contextFor(task)
  const bits = []
  if (base) {
    bits.push(base)
  }
  if (state.plan) {
    bits.push(`CURRENT PLAN:\n${state.plan}`)
  }
  if (failures.length) {
    bits.push(`DEAD ACTIONS THIS RUN:\n${failures.map((f) => `- ${f}`).join('\n')}`)
  }
  return bits.length ? bits.join('\n\n') : null
}

function emit(onEvent, evt, sink) {
  if (sink) {
    sink.push(evt)
  }
  try {
    onEvent(evt)
  } catch {
    // A listener must never break the run.
  }
}

function truncate(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) {
    return s
  }
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`
}
