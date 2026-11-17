/**
 * Javelin Engine — tool layer.
 *
 * Tools are executed here, never by the orchestrator directly, so one place owns:
 *
 *   • canonical names and workspace-relative path arguments
 *   • risk policy (what needs the user's approval, and how \"remember\" is scoped)
 *   • execution against the workspace adapter (sync or async)
 *   • post-write verification: a tool's claim of success is checked on disk
 *
 * The schemas themselves live in `src/lib/agentTools.js` so the model-facing
 * contract has exactly one definition.
 */

import { TOOL_DEFS, normalizeToolArgs, isBlockedCommand, isSafeCommand, writeChunkLimit } from '../lib/agentTools.js'
import { starterFiles, templateNames } from '../lib/projectStarters.js'
import { AUTONOMY, canonicalizeToolCall } from '../core/tools.js'
import { MAX_TOOL_OUTPUT_CHARS } from './limits.js'
import { cacheFileRead, readCachedFile } from './memory.js'
import {
  checkLocalExports,
  detectVerificationCommands,
  findReferences,
  formatProjectOverview,
  isVerificationCommand,
} from './projectIndex.js'

export { TOOL_DEFS }

const REQUIRED_ARGS = new Map(
  TOOL_DEFS.map((tool) => [tool.function.name, tool.function.parameters?.required ?? []]),
)

function missingRequiredArgs(name, args) {
  return (REQUIRED_ARGS.get(name) ?? []).filter((key) => {
    const value = args?.[key]
    if (value === undefined || value === null) return true
    if (typeof value !== 'string') return true
    // An empty file, a deletion replacement or an empty replacement string are valid.
    return !['content', 'new_string'].includes(key) && !value.trim()
  })
}

/** Did a call omit an argument the tool schema requires? */
export function hasMissingRequiredArgs(call) {
  return missingRequiredArgs(call?.name, call?.args).length > 0
}

/** Tools that change the workspace and must be verified after they run. */
export const MUTATING_TOOLS = [
  'create_project',
  'append_file',
  'write_file',
  'create_folder',
  'edit_file',
  'delete_file',
  'rename_file',
  'copy_file',
]

/** Tools that only read, and can therefore run concurrently within one turn. */
export const READ_ONLY_TOOLS = ['list_files', 'read_file', 'search_code', 'project_overview', 'find_references']

export function isReadOnlyTool(name) {
  return READ_ONLY_TOOLS.includes(name)
}

/**
 * Would policy normally gate this call?
 *
 * `AUTONOMY.FULL` trusts the agent with edits and ordinary commands;
 * `AUTONOMY.AUTO_EDIT` trusts edits but still asks before a deletion and before an
 * unusual command. A hard-blocked command is refused during execution at every
 * level, so autonomy never becomes a way to format a disk.
 */
export function requiresApproval(call, autonomy = AUTONOMY.ASK) {
  const mutates = MUTATING_TOOLS.includes(call.name)
  const runsCommand = call.name === 'run_command'
  if (!mutates && !runsCommand) return false
  if (autonomy === AUTONOMY.FULL) return false
  if (autonomy === AUTONOMY.AUTO_EDIT) {
    if (call.name === 'delete_file') return true
    if (call.name === 'verify_project') return false
    return runsCommand && !isSafeCommand(call.args?.command ?? '')
  }
  return true
}

/**
 * What an \"always allow\" decision covers. Commands are keyed by the exact
 * command and deletions by the exact path, so consent for one is never silently
 * reused for another.
 */
export function approvalKeyFor(call) {
  if (call.name === 'run_command') return `run_command:${(call.args?.command ?? '').trim()}`
  if (call.name === 'verify_project') return `verify_project:${(call.args?.checks ?? []).join(',') || 'all'}`
  if (call.name === 'delete_file') return `delete_file:${call.args?.path ?? ''}`
  if (call.name === 'rename_file') return `rename_file:${call.args?.old_path ?? ''}->${call.args?.new_path ?? ''}`
  if (call.name === 'copy_file') return `copy_file:${call.args?.source_path ?? ''}->${call.args?.dest_path ?? ''}`
  return call.name
}

export function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`
}

/** Surface invented local APIs / undeclared packages without blocking the write. */
async function noteExportWarnings(workspace, projectIndex, memory, emit, path, content) {
  try {
    const warnings = await checkLocalExports(workspace, projectIndex, path, content)
    if (!warnings.length) return
    const known = new Set((memory.verificationWarnings ?? []).map((warning) => warning.message))
    const fresh = warnings.filter((warning) => !known.has(warning.message))
    if (!fresh.length) return
    memory.verificationWarnings = [...(memory.verificationWarnings ?? []), ...fresh]
    emit({ type: 'reminder', text: `API check: ${fresh.map((warning) => warning.message).join(' ')}` })
  } catch {
    // A best-effort static check must never fail the write itself.
  }
}

/** Read a file through the run's content cache when it is still current. */
function readFileWithCache(memory, workspace, path, start, end) {
  if (start == null && end == null) {
    const cached = readCachedFile(memory, path)
    if (cached !== null) {
      memory.metrics.cachedReads += 1
      return cached
    }
  }
  const content = workspace.read(path, start, end)
  if (start == null && end == null) cacheFileRead(memory, path, content)
  return content
}

/**
 * Execute one tool call against the workspace.
 *
 * @returns {Promise<{ok: boolean, output: string, diff?: object, progress?: boolean, invalidated?: string[]}>}
 */
export async function executeTool(call, { workspace, runCommand, memory, emit, signal, projectIndex }) {
  call = normalizeToolArgs(canonicalizeToolCall(call))
  const args = call.args ?? {}
  if (args.__parseError) {
    return {
      ok: false,
      output:
        'Your tool-call arguments were not valid JSON, so nothing was executed. Re-issue the call with a well-formed arguments object.',
    }
  }

  const missing = missingRequiredArgs(call.name, args)
  if (missing.length) {
    const required = missing.map((key) => `"${key}"`).join(' and ')
    let output =
      `INVALID ARGUMENTS: ${call.name} requires ${required}. Nothing was executed. ` +
      `Re-issue ${call.name} with ${required}, using a real workspace path. Do not repeat the same call.`
    if (call.name === 'read_file' && workspace?.list) {
      try {
        if (typeof workspace.toJSON === 'function') {
          const files = Object.keys(workspace.toJSON() ?? {}).filter(Boolean).slice(0, 40)
          if (files.length) output += `\n\nAvailable files:\n${files.join('\n')}`
        } else if (typeof workspace.tree === 'function') {
          const tree = await workspace.tree('')
          if (typeof tree === 'string' && tree.trim()) output += `\n\nProject files:\n${tree.slice(0, 4000)}`
        } else {
          const entries = await workspace.list('')
          const files = (Array.isArray(entries) ? entries : [])
            .filter((entry) => entry?.type !== 'dir')
            .map((entry) => entry.path)
            .filter(Boolean)
            .slice(0, 40)
          if (files.length) output += `\n\nAvailable files:\n${files.join('\n')}`
        }
      } catch {
        // A missing path is already actionable; a listing is only a hint.
      }
    }
    return { ok: false, output }
  }

  try {
    switch (call.name) {
      case 'list_files': {
        const entries = await workspace.list(args.path ?? '')
        if (typeof entries === 'string') return { ok: true, output: entries }
        const output = entries.length
          ? entries.map((entry) => (entry.type === 'dir' ? `${entry.path}/` : entry.path)).join('\n')
          : '(empty — no files at this path)'
        return { ok: true, output }
      }

      case 'read_file': {
        const content = String((await readFileWithCache(memory, workspace, args.path, args.start, args.end)) ?? '')
        memory?.evidence?.filesRead?.add(args.path)
        // A truncated read is only useful if the model knows how to ask for the rest.
        const MAX_READ_CHARS = 24000
        if (content.length <= MAX_READ_CHARS) return { ok: true, output: content }
        const lineCount = content.split('\n').length
        return {
          ok: true,
          output:
            `${content.slice(0, MAX_READ_CHARS)}\n… [${content.length - MAX_READ_CHARS} characters omitted; ` +
            `the file has ${lineCount} lines. Call read_file with start/end to read a specific line range.]`,
        }
      }

      case 'search_code': {
        const hits = await workspace.search(args.query, args.isRegex)
        memory?.evidence?.searches?.push({ query: args.query, hits: Array.isArray(hits) ? hits.length : null, at: Date.now() })
        if (typeof hits === 'string') return { ok: true, output: hits }
        const output = hits.length
          ? hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join('\n')
          : `No matches for "${args.query}".`
        return { ok: true, output }
      }

      case 'project_overview': {
        if (!projectIndex) return { ok: false, output: 'The project index is not available in this run. Use list_files and read_file instead.' }
        return { ok: true, output: formatProjectOverview(projectIndex, args.path ?? '') }
      }

      case 'find_references': {
        if (!projectIndex) return { ok: false, output: 'The project index is not available in this run. Use search_code instead.' }
        return { ok: true, output: await findReferences(projectIndex, workspace, args.name) }
      }

      case 'verify_project': {
        if (!runCommand) {
          return { ok: false, output: 'Command execution is not available in this environment, so the project cannot be verified automatically.' }
        }
        const available = detectVerificationCommands(projectIndex)
        if (!available.length) {
          return {
            ok: false,
            output:
              'No verification commands were detected in this project (looked for package.json scripts test, typecheck, lint and build). ' +
              'Explain that it was not verified, or run an appropriate command explicitly.',
          }
        }
        const wanted = Array.isArray(args.checks) && args.checks.length ? new Set(args.checks) : null
        const selected = wanted ? available.filter((check) => wanted.has(check.id)) : available
        if (!selected.length) {
          return { ok: false, output: `None of the requested checks exist. Detected: ${available.map((check) => check.id).join(', ')}.` }
        }

        const sections = []
        let allPassed = true
        for (const check of selected) {
          emit({ type: 'command_started', command: check.command })
          let result
          try {
            result = await runCommand(check.command, signal, (chunk) => {
              emit({ type: 'command_output', id: call.id, command: check.command, ...chunk })
            })
          } catch (error) {
            result = { exitCode: -1, stdout: '', stderr: error?.message ?? 'command failed' }
          }
          const passed = result?.exitCode === 0
          allPassed = allPassed && passed
          memory?.evidence?.commands?.push({
            command: check.command,
            exitCode: result?.exitCode ?? null,
            ok: passed,
            verification: true,
            at: Date.now(),
          })
          const section = [
            `$ ${check.command}`,
            `exit code: ${result?.exitCode ?? 'unknown'}`,
            passed ? 'PASS' : 'FAIL',
            result?.stdout ? `--- stdout ---\n${truncate(result.stdout, 3000)}` : '',
            result?.stderr ? `--- stderr ---\n${truncate(result.stderr, 3000)}` : '',
          ]
            .filter(Boolean)
            .join('\n')
          sections.push(section)
          emit({ type: 'command_finished', command: check.command, exitCode: result?.exitCode ?? null, output: section })
          if (!passed) break
        }
        return {
          ok: allPassed,
          output: `${sections.join('\n\n')}\n\nVERIFICATION ${allPassed ? 'PASSED' : 'FAILED'} — report these real results, not an assumption.`,
        }
      }

      case 'write_file': {
        const tooLarge = writeChunkLimit(args.content)
        if (tooLarge) return { ok: false, output: tooLarge }
        const existed = workspace.exists(args.path)
        const outcome = await workspace.write(args.path, args.content, Boolean(args.overwrite))
        memory.filesTouched.add(outcome.path)
        emit({ type: 'file_changed', ...outcome })
        await noteExportWarnings(workspace, projectIndex, memory, emit, outcome.path, outcome.after)
        const verb = outcome.before ? 'Rewrote' : 'Created'
        return {
          ok: true,
          diff: outcome.diff,
          progress: !existed || outcome.before !== outcome.after,
          invalidated: [outcome.path],
          output: `${verb} ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
        }
      }

      case 'append_file': {
        const tooLarge = writeChunkLimit(args.content)
        if (tooLarge) return { ok: false, output: tooLarge }
        const existed = workspace.exists(args.path)
        const outcome = await workspace.append(args.path, args.content)
        memory.filesTouched.add(outcome.path)
        emit({ type: 'file_changed', ...outcome })
        await noteExportWarnings(workspace, projectIndex, memory, emit, outcome.path, outcome.after)
        return {
          ok: true,
          diff: outcome.diff,
          progress: true,
          invalidated: [outcome.path],
          output: `${existed ? 'Appended to' : 'Created'} ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
        }
      }

      case 'create_project': {
        const template = String(args.template ?? '').trim()
        const files = starterFiles(template, args.path)
        if (!files) {
          return {
            ok: false,
            output: `Unknown template "${template}". Available templates: ${templateNames().join(', ')}.`,
          }
        }
        const existing = files.filter((file) => workspace.exists(file.path))
        if (existing.length && !args.overwrite) {
          return {
            ok: false,
            output:
              `These files already exist: ${existing.map((file) => file.path).join(', ')}. ` +
              'Choose a different path, or pass overwrite true to replace them.',
          }
        }
        const written = []
        for (const file of files) {
          const outcome = await workspace.write(file.path, file.content, Boolean(args.overwrite))
          memory.filesTouched.add(outcome.path)
          emit({ type: 'file_changed', ...outcome })
          written.push(outcome.path)
        }
        return {
          ok: true,
          progress: true,
          invalidated: written,
          files: written,
          output:
            `Created the ${template} starter: ${written.join(', ')}. ` +
            'Read these files before changing them; they already run.',
        }
      }

      case 'create_folder': {
        const outcome = await workspace.createDirectory(args.path)
        if (outcome.created.length) memory.filesTouched.add(outcome.path)
        emit({ type: 'folder_created', ...outcome })
        return {
          ok: true,
          progress: outcome.created.length > 0,
          output: outcome.created.length ? `Created folder ${outcome.path}.` : `Folder ${outcome.path} already exists.`,
        }
      }

      case 'edit_file': {
        const outcome = await workspace.edit(
          args.path,
          args.old_string,
          args.new_string,
          Boolean(args.replace_all),
          args.occurrence,
        )
        memory.filesTouched.add(outcome.path)
        emit({ type: 'file_changed', ...outcome })
        await noteExportWarnings(workspace, projectIndex, memory, emit, outcome.path, outcome.after)
        return {
          ok: true,
          diff: outcome.diff,
          invalidated: [outcome.path],
          output: `Edited ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
        }
      }

      case 'delete_file': {
        const outcome = await workspace.delete(args.path)
        memory.filesTouched.add(outcome.path)
        emit({ type: 'file_changed', ...outcome })
        return {
          ok: true,
          diff: outcome.diff,
          invalidated: [outcome.path],
          output: `Deleted ${outcome.path} (-${outcome.diff.removed} lines).`,
        }
      }

      case 'rename_file': {
        const outcome = await workspace.rename(args.old_path, args.new_path)
        memory.filesTouched.add(outcome.new_path)
        emit({ type: 'file_changed', ...outcome })
        return {
          ok: true,
          diff: outcome.diff,
          invalidated: [outcome.old_path, outcome.new_path],
          output: `Renamed ${outcome.old_path} to ${outcome.new_path}.`,
        }
      }

      case 'copy_file': {
        const outcome = await workspace.copy(args.source_path, args.dest_path)
        memory.filesTouched.add(outcome.dest_path)
        emit({ type: 'file_changed', ...outcome })
        return {
          ok: true,
          diff: outcome.diff,
          invalidated: [outcome.dest_path],
          output: `Copied ${outcome.source_path} to ${outcome.dest_path}.`,
        }
      }

      case 'create_checkpoint': {
        const checkpoint = await workspace.snapshot(args.label ?? 'checkpoint')
        memory.checkpoints.push(checkpoint)
        emit({ type: 'checkpoint', checkpoint })
        return { ok: true, output: `Checkpoint "${checkpoint.label}" created (${checkpoint.fileCount} files).` }
      }

      case 'run_command': {
        const command = args.command ?? ''
        if (isBlockedCommand(command)) {
          return { ok: false, output: 'Blocked: this command is on the never-run list for safety.' }
        }
        if (!runCommand) {
          return {
            ok: false,
            output: 'Command execution is not available in this environment. Explain what should be run instead.',
          }
        }
        emit({ type: 'command_started', command })
        const result = await runCommand(command, signal, (chunk) => {
          emit({ type: 'command_output', id: call.id, command, ...chunk })
        })
        const output = [
          `$ ${command}`,
          `exit code: ${result.exitCode}`,
          result.stdout ? `--- stdout ---\n${truncate(result.stdout, 4000)}` : '',
          result.stderr ? `--- stderr ---\n${truncate(result.stderr, 4000)}` : '',
        ]
          .filter(Boolean)
          .join('\n')
        memory?.evidence?.commands?.push({
          command,
          exitCode: result.exitCode,
          ok: result.exitCode === 0,
          verification: isVerificationCommand(command),
          at: Date.now(),
        })
        emit({ type: 'command_finished', command, exitCode: result.exitCode, output })
        return { ok: result.exitCode === 0, output }
      }

      default:
        return {
          ok: false,
          output: `Unsupported tool "${call.name}". Available tools: ${TOOL_DEFS.map((tool) => tool.function.name).join(', ')}. Use write_file with path and content to create a file, or create_folder with path to create a directory.`,
        }
    }
  } catch (error) {
    return { ok: false, output: `ERROR: ${error.message}` }
  }
}

async function readBack(workspace, path) {
  try {
    const content = await workspace.read(path)
    return typeof content === 'string' ? content : null
  } catch {
    return null
  }
}

function comparableContent(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '')
}

async function fileExists(workspace, path) {
  if (typeof workspace.exists !== 'function') return null
  try {
    return Boolean(await workspace.exists(path))
  } catch {
    return false
  }
}

/**
 * Verify that a mutation actually landed.
 *
 * A tool reporting success is not proof: the adapter could drop the write, save a
 * truncated buffer, or fail silently. Reading the file back turns that into a
 * retryable tool failure instead of a false success the model builds on.
 */
export async function verifyMutation(call, workspace, outcome) {
  const args = call.args ?? {}
  const canCheck = typeof workspace.exists === 'function'
  if (!canCheck) return { ok: true }

  try {
    switch (call.name) {
      case 'write_file': {
        const path = outcome.path ?? args.path
        if (!(await fileExists(workspace, path))) {
          return { ok: false, reason: `write_file reported success but ${path} does not exist in the workspace. Write it again.` }
        }
        const actual = await readBack(workspace, path)
        if (actual === null) return { ok: true }
        const expected = comparableContent(args.content)
        if (comparableContent(actual) !== expected) {
          return {
            ok: false,
            reason: `write_file reported success but ${path} does not match the content you sent (${comparableContent(actual).length} vs ${expected.length} characters). Read the file and write it again.`,
          }
        }
        return { ok: true }
      }

      case 'edit_file': {
        const path = outcome.path ?? args.path
        if (!(await fileExists(workspace, path))) {
          return { ok: false, reason: `edit_file reported success but ${path} does not exist in the workspace.` }
        }
        const actual = await readBack(workspace, path)
        if (actual === null) return { ok: true }
        const normalizedActual = actual.replace(/\r\n/g, '\n')
        const before = String(outcome.before ?? '').replace(/\r\n/g, '\n')
        if (before !== '' && normalizedActual === before) {
          return { ok: false, reason: `edit_file reported success but ${path} is unchanged. Re-read the file and apply a different old_string.` }
        }
        const replacement = String(args.new_string ?? '').replace(/\r\n/g, '\n')
        if (replacement && !normalizedActual.includes(replacement)) {
          return { ok: false, reason: `edit_file reported success but the new text is not present in ${path}. Re-read the file and retry with an exact snippet.` }
        }
        return { ok: true }
      }

      case 'delete_file': {
        const path = outcome.path ?? args.path
        if (await fileExists(workspace, path)) {
          return { ok: false, reason: `delete_file reported success but ${path} still exists.` }
        }
        return { ok: true }
      }

      case 'rename_file': {
        const oldPath = outcome.old_path ?? args.old_path
        const newPath = outcome.new_path ?? args.new_path
        if (!(await fileExists(workspace, newPath))) {
          return { ok: false, reason: `rename_file reported success but ${newPath} does not exist.` }
        }
        if (await fileExists(workspace, oldPath)) {
          return { ok: false, reason: `rename_file reported success but ${oldPath} still exists.` }
        }
        return { ok: true }
      }

      case 'copy_file': {
        const destPath = outcome.dest_path ?? args.dest_path
        if (!(await fileExists(workspace, destPath))) {
          return { ok: false, reason: `copy_file reported success but ${destPath} does not exist.` }
        }
        if (typeof outcome.after !== 'string') return { ok: true }
        const actual = await readBack(workspace, destPath)
        if (actual !== null && comparableContent(actual) !== comparableContent(outcome.after)) {
          return { ok: false, reason: `copy_file reported success but ${destPath} does not contain the copied content.` }
        }
        return { ok: true }
      }

      case 'append_file': {
        const path = outcome.path ?? args.path
        if (!(await fileExists(workspace, path))) {
          return { ok: false, reason: `append_file reported success but ${path} does not exist.` }
        }
        const actual = await readBack(workspace, path)
        if (actual === null) return { ok: true }
        const appended = String(args.content ?? '').replace(/\r\n/g, '\n')
        if (appended && !actual.replace(/\r\n/g, '\n').includes(appended)) {
          return { ok: false, reason: `append_file reported success but the appended text is not present in ${path}.` }
        }
        const before = String(outcome.before ?? '')
        if (actual.length < before.length) {
          return { ok: false, reason: `append_file reported success but ${path} is shorter than before.` }
        }
        return { ok: true }
      }

      case 'create_project': {
        const files = outcome.files ?? []
        for (const path of files) {
          if (!(await fileExists(workspace, path))) {
            return { ok: false, reason: `create_project reported success but ${path} does not exist.` }
          }
        }
        return { ok: true }
      }

      case 'create_folder': {
        const path = outcome.path ?? args.path
        if (typeof workspace.isDirectory !== 'function') return { ok: true }
        if (!(await workspace.isDirectory(path))) {
          return { ok: false, reason: `create_folder reported success but ${path} is not a directory in the workspace.` }
        }
        return { ok: true }
      }

      default:
        return { ok: true }
    }
  } catch (error) {
    return { ok: false, reason: `${call.name} could not be verified: ${error?.message ?? 'unknown error'}` }
  }
}

export { MAX_TOOL_OUTPUT_CHARS }
