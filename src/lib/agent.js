/**
 * The agent loop.
 *
 * Shape of one run:
 *   1. INSPECT  — the model is told to list/read/search before editing.
 *   2. PLAN     — it states a short plan (surfaced to the UI).
 *   3. ACT      — it calls tools. Risky tools pause for approval.
 *   4. VERIFY   — it runs tests/build and reads the output.
 *   5. RECOVER  — on failure it retries, but the loop refuses to repeat an identical
 *                 failing call. Past failures are fed back as explicit reminders.
 *
 * The loop is provider-agnostic and workspace-agnostic: it drives tools against any
 * runtime that satisfies the workspace interface (real FS in VS Code, virtual in web).
 */

import {
  TOOL_DEFS,
  isSafeCommand,
  isBlockedCommand,
  signatureOf,
} from './agentTools'
import { AUTONOMY } from '../core/tools.js'
import { streamCompletion } from './providers'

export const MAX_STEPS = 24

export const AGENT_SYSTEM_PROMPT = `You are Javelin AI, an autonomous coding agent working inside a user's project. You do not just answer questions — you inspect the codebase, plan, make edits, run tests, and fix your own mistakes.

Operating rules:
1. INVESTIGATE BEFORE EDITING. You must call list_files / read_file / search_code to understand the relevant code before you change anything. Never invent file paths — verify they exist.
2. READ BEFORE YOU WRITE. Always read a file before editing it. Use edit_file with an exact snippet for changes; only use write_file for genuinely new files or a deliberate full replacement.
3. NEVER OVERWRITE BLINDLY. Do not replace a whole file to change a few lines. Match existing style, imports, and conventions.
4. PLAN BRIEFLY. On your first turn, state a 2-5 step plan in plain text, then start executing it.
5. VERIFY YOUR WORK. Run the project's tests/build/lint when they exist. If the command fails, read the error, fix the cause, and run it again.
6. DO NOT REPEAT FAILED STEPS. If an action failed, change your approach. Repeating an identical call that already failed is not allowed.
7. CHECKPOINT BEFORE RISKY WORK. Call create_checkpoint before a batch of related edits.
8. STOP WHEN DONE. Call \`finish\` with an honest summary. Set verified: true only if you actually ran tests or a build and they passed.

Be concise. Do not narrate every tool call at length. Be honest when something did not work.`

/** Phases surfaced to the UI so the user can see what the agent is doing. */
export const PHASE = {
  INSPECT: 'inspect',
  PLAN: 'plan',
  ACT: 'act',
  VERIFY: 'verify',
  RECOVER: 'recover',
  DONE: 'done',
}

/**
 * @typedef {object} AgentEvents
 * @property {(evt: object) => void} emit            stream of UI events
 * @property {(req: object) => Promise<{approved: boolean, remember: boolean}>} requestApproval
 */

/**
 * Run the agent against a task until it finishes, fails, or is aborted.
 *
 * @param {object} opts
 * @param {string} opts.task
 * @param {object} opts.workspace                 VirtualWorkspace or VS Code adapter
 * @param {object} opts.provider                  {providerId, baseUrl, apiKey, model}
 * @param {AbortSignal} opts.signal
 * @param {AgentEvents} opts.events
 * @param {(command: string) => Promise<{exitCode: number, stdout: string, stderr: string}>} [opts.runCommand]
 * @param {object[]} [opts.priorMessages]         conversation context
 * @returns {Promise<{status: 'done'|'aborted'|'failed', summary: string, steps: object[], checkpoints: object[]}>}
 */
export async function runAgent({
  task,
  workspace,
  provider,
  signal,
  events,
  runCommand,
  priorMessages = [],
  autonomy = AUTONOMY.ASK,
}) {
  const emit = events?.emit ?? (() => { })
  const requestApproval = events?.requestApproval ?? (async () => ({ approved: false }))

  /** Structured memory of everything attempted, so we never repeat a failed step. */
  const memory = {
    steps: [],
    attempts: new Map(), // signature -> { count, failed }
    checkpoints: [],
    filesTouched: new Set(),
    // Per-run "always allow" decisions, keyed by tool name or exact command.
    alwaysAllow: new Set(),
  }

  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...priorMessages.slice(-12),
    {
      role: 'user',
      content: `Task: ${task}\n\nStart by inspecting the project, then state a short plan and execute it.`,
    },
  ]

  emit({ type: 'phase', phase: PHASE.INSPECT })
  emit({ type: 'status', text: 'Inspecting the codebase…' })

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) {
      emit({ type: 'aborted' })
      return { status: 'aborted', summary: 'Stopped by user.', steps: memory.steps, checkpoints: memory.checkpoints }
    }

    let result
    try {
      result = await streamCompletion({
        ...provider,
        messages: buildRequestMessages(messages, memory),
        tools: TOOL_DEFS,
        signal,
        onToken: (delta) => {
          // Streamed reasoning text is shown live, but tool calls drive the loop.
          emit({ type: 'assistant_delta', delta })
        },
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        emit({ type: 'aborted' })
        return { status: 'aborted', summary: 'Stopped by user.', steps: memory.steps, checkpoints: memory.checkpoints }
      }
      emit({ type: 'error', error: err.message })
      return { status: 'failed', summary: err.message, steps: memory.steps, checkpoints: memory.checkpoints }
    }

    const { content, toolCalls } = result

    // Record the assistant turn, including tool calls, in the running transcript.
    messages.push({
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length
        ? {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        }
        : {}),
    })

    if (content?.trim()) {
      emit({ type: 'assistant_message', content: content.trim() })
      if (step === 0) emit({ type: 'phase', phase: PHASE.PLAN })
    }

    // No tool call means the model is just talking. Nudge it to act or finish.
    if (!toolCalls.length) {
      const finished = /^(done|finished|complete)/i.test(content ?? '')
      // Only accept a bare "done" once real work has happened. A model that opens
      // with "Done." before touching anything has not done the task.
      if ((finished && memory.steps.length > 0) || step === MAX_STEPS - 1) {
        emit({ type: 'phase', phase: PHASE.DONE })
        return {
          status: 'done',
          summary: content?.trim() || 'Completed.',
          steps: memory.steps,
          checkpoints: memory.checkpoints,
        }
      }
      messages.push({
        role: 'user',
        content:
          'You described an action but did not perform it. Do not narrate what you would do — ' +
          'call the tool NOW to actually do it (e.g. write_file with the full file content, or ' +
          'edit_file with the exact old_string/new_string). If the task is genuinely complete, ' +
          'call `finish`.',
      })
      continue
    }

    // Execute each requested tool call in order.
    for (const call of toolCalls) {
      const signature = signatureOf(call.name, call.args)

      // Failure memory: block an exact repeat of a call that already failed.
      const prior = memory.attempts.get(signature)
      if (prior?.failed) {
        const note =
          `You already tried \`${signature}\` and it failed. Do not repeat it. ` +
          `Change your approach — read the file again, use more context, or try a different method.`
        emit({ type: 'reminder', text: note, signature })
        messages.push({ role: 'tool', tool_call_id: call.id, content: note })
        continue
      }
      memory.attempts.set(signature, { count: (prior?.count ?? 0) + 1, failed: false })

      if (call.name === 'finish') {
        const summary = call.args?.summary ?? 'Completed.'
        emit({ type: 'phase', phase: PHASE.DONE })
        emit({ type: 'finish', summary, verified: Boolean(call.args?.verified) })
        return { status: 'done', summary, steps: memory.steps, checkpoints: memory.checkpoints }
      }

      emit({ type: 'tool_call', name: call.name, args: call.args, id: call.id })

      // Approval gate for anything that changes the workspace or runs a command.
      // The run's autonomy level decides whether the user has already said "go ahead".
      const approvalKey = approvalKeyFor(call)
      const needsApproval = requiresApproval(call, autonomy) && !memory.alwaysAllow.has(approvalKey)
      if (needsApproval) {
        const approved = await gateTool(call, { emit, requestApproval, workspace })
        if (approved.remember) memory.alwaysAllow.add(approvalKey)
        if (!approved.approved) {
          const note = `The user DENIED this action: ${call.name}. Do not retry it. Propose an alternative or stop and ask.`
          memory.attempts.set(signature, { count: 1, failed: true })
          emit({ type: 'tool_result', id: call.id, name: call.name, ok: false, output: note })
          messages.push({ role: 'tool', tool_call_id: call.id, content: note })
          continue
        }
      }

      const outcome = await executeTool(call, {
        workspace,
        runCommand,
        memory,
        emit,
        signal,
      })

      if (!outcome.ok) {
        memory.attempts.set(signature, { count: (prior?.count ?? 0) + 1, failed: true })
        emit({ type: 'phase', phase: PHASE.RECOVER })
      }
      if (call.name === 'run_command') {
        emit({ type: 'phase', phase: PHASE.VERIFY })
      }

      const record = {
        step: step + 1,
        name: call.name,
        args: call.args,
        ok: outcome.ok,
        output: outcome.output,
        diff: outcome.diff,
        timestamp: Date.now(),
      }
      memory.steps.push(record)
      emit({ type: 'tool_result', id: call.id, name: call.name, ok: outcome.ok, output: outcome.output })

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncate(outcome.output, 6000),
      })
    }
  }

  const summary = `Stopped after ${MAX_STEPS} steps without an explicit finish.`
  emit({ type: 'error', error: summary })
  return { status: 'failed', summary, steps: memory.steps, checkpoints: memory.checkpoints }
}

/**
 * Tools that mutate the workspace or execute something need a human gate — unless
 * the run is autonomous. `AUTONOMY.FULL` trusts Javelin to run any command it is
 * not hard-blocked from (the blocked list is still enforced in executeTool);
 * `AUTONOMY.AUTO_EDIT` trusts code edits, but still asks before deleting a file and
 * before an unusual command.
 */
function requiresApproval(call, autonomy = AUTONOMY.ASK) {
  const mutates = call.name === 'write_file' || call.name === 'edit_file' || call.name === 'delete_file'
  const deletesFile = call.name === 'delete_file'
  const runsCommand = call.name === 'run_command'
  if (!mutates && !runsCommand) {
    return false
  }
  if (autonomy === AUTONOMY.FULL) {
    return false
  }
  if (autonomy === AUTONOMY.AUTO_EDIT) {
    // auto-edit trusts edits, not deletions. Removing a whole file stays gated
    // unless the run is explicitly `full`.
    if (deletesFile) {
      return true
    }
    return runsCommand && !isSafeCommand(call.args?.command ?? '')
  }
  return true
}

/**
 * What an "always allow" decision for this call would cover.
 * Commands are keyed by the exact command and deletions by the exact path, so
 * consent for one is never silently reused for another.
 */
function approvalKeyFor(call) {
  if (call.name === 'run_command') return `run_command:${(call.args?.command ?? '').trim()}`
  if (call.name === 'delete_file') return `delete_file:${call.args?.path ?? ''}`
  return call.name
}

/**
 * Ask the user before a risky action. We attach a *preview diff* of exactly what
 * would change so the decision is informed, never a blind yes.
 */
async function gateTool(call, { emit, requestApproval, workspace }) {
  let preview = { diff: null }
  try {
    preview = workspace.preview?.(call.name, call.args) ?? { diff: null }
  } catch {
    preview = { diff: null }
  }

  const request = {
    id: call.id,
    name: call.name,
    args: call.args,
    diff: preview.diff,
    path: call.args?.path,
  }
  emit({ type: 'approval_requested', ...request })
  const decision = await requestApproval(request)
  return { approved: Boolean(decision?.approved), remember: Boolean(decision?.remember) }
}

async function executeTool(call, { workspace, runCommand, memory, emit, signal }) {
  const args = call.args ?? {}
  try {
    switch (call.name) {
      case 'list_files': {
        const entries = workspace.list(args.path ?? '')
        const output = entries.length
          ? entries.map((e) => (e.type === 'dir' ? `${e.path}/` : e.path)).join('\n')
          : '(empty — no files at this path)'
        return { ok: true, output }
      }

      case 'read_file': {
        const content = workspace.read(args.path, args.start, args.end)
        return { ok: true, output: truncate(content, 16000) }
      }

      case 'search_code': {
        const hits = workspace.search(args.query, args.isRegex)
        const output = hits.length
          ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
          : `No matches for "${args.query}".`
        return { ok: true, output }
      }

      case 'write_file': {
        const outcome = workspace.write(args.path, args.content, Boolean(args.overwrite))
        memory.filesTouched.add(outcome.path)
        emit({ type: 'file_changed', ...outcome })
        const verb = outcome.before ? 'Rewrote' : 'Created'
        return {
          ok: true,
          diff: outcome.diff,
          output: `${verb} ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
        }
      }

      case 'edit_file': {
        const outcome = workspace.edit(args.path, args.old_string, args.new_string, Boolean(args.replace_all))
        memory.filesTouched.add(outcome.path)
        emit({ type: 'file_changed', ...outcome })
        return {
          ok: true,
          diff: outcome.diff,
          output: `Edited ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
        }
      }

      case 'delete_file': {
        const outcome = workspace.delete(args.path)
        memory.filesTouched.add(outcome.path)
        emit({ type: 'file_changed', ...outcome })
        return {
          ok: true,
          diff: outcome.diff,
          output: `Deleted ${outcome.path} (-${outcome.diff.removed} lines).`,
        }
      }

      case 'create_checkpoint': {
        const cp = workspace.snapshot(args.label ?? 'checkpoint')
        memory.checkpoints.push(cp)
        emit({ type: 'checkpoint', checkpoint: cp })
        return { ok: true, output: `Checkpoint "${cp.label}" created (${cp.fileCount} files).` }
      }

      case 'run_command': {
        const command = args.command ?? ''
        if (isBlockedCommand(command)) {
          return { ok: false, output: `Blocked: this command is on the never-run list for safety.` }
        }
        if (!runCommand) {
          return {
            ok: false,
            output:
              'Command execution is not available in this environment. Explain what should be run instead.',
          }
        }
        emit({ type: 'command_started', command })
        const res = await runCommand(command, signal)
        const output = [
          `$ ${command}`,
          `exit code: ${res.exitCode}`,
          res.stdout ? `--- stdout ---\n${truncate(res.stdout, 4000)}` : '',
          res.stderr ? `--- stderr ---\n${truncate(res.stderr, 4000)}` : '',
        ]
          .filter(Boolean)
          .join('\n')
        emit({ type: 'command_finished', command, exitCode: res.exitCode, output })
        return { ok: res.exitCode === 0, output }
      }

      default:
        return { ok: false, output: `Unknown tool: ${call.name}` }
    }
  } catch (err) {
    return { ok: false, output: `ERROR: ${err.message}` }
  }
}

/** Inject failure memory into the request so the model sees what it must not repeat. */
function buildRequestMessages(messages, memory) {
  const failures = [...memory.attempts.entries()]
    .filter(([, v]) => v.failed)
    .map(([sig]) => `- ${sig}`)
  if (!failures.length) return messages

  const reminder = {
    role: 'system',
    content:
      'Actions you have ALREADY TRIED AND FAILED — never repeat these exact calls:\n' +
      failures.join('\n') +
      '\nTake a different approach for each.',
  }
  // Keep it near the end so it stays salient, but after the system prompt.
  const [system, ...rest] = messages
  return [system, ...rest.slice(0, -2), reminder, ...rest.slice(-2)]
}

function truncate(text, max) {
  if (!text || text.length <= max) return text ?? ''
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`
}
