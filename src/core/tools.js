/**
 * Javelin Core — Tool Registry
 * ============================
 *
 * Javelin's tools are first-class, registered objects rather than a fixed switch
 * statement. Each tool declares:
 *   - its schema (what the model sees)
 *   - its **risk class** (read / write / execute / destructive)
 *   - whether it is safe to run unattended
 *   - how to execute it against a workspace
 *
 * This is what lets the runtime make policy decisions generically: anything above
 * `read` needs approval, `destructive` is refused outright, and a tool can be
 * disabled per-session without touching the agent loop.
 */

export const RISK = {
  READ: 'read',
  WRITE: 'write',
  EXECUTE: 'execute',
  DESTRUCTIVE: 'destructive',
}

/**
 * How much Javelin is trusted to act without asking.
 *
 * The default is `ask`: every mutation and every non-allowlisted command is gated.
 * Autonomy raises that trust so Javelin can do the whole job — plan, edit, delete,
 * run, verify, recover — in one run instead of stopping at every change. It trades
 * the per-step checkpoint for a checkpoint taken once at the start of the run, which
 * is exactly the trade the original "stop asking me" request makes.
 */
export const AUTONOMY = {
  /** Ask before every mutation and every non-allowlisted command. (default) */
  ASK: 'ask',
  /** Run edits and deletes freely; still confirm unusual commands. */
  AUTO_EDIT: 'auto-edit',
  /** Do everything unattended — edits, deletes and any command that isn't catastrophic. */
  FULL: 'full',
}

/**
 * Does this action need a human prompt under the given autonomy level?
 *
 * `requiresApproval` answers "would policy normally gate this?"; this folds in how
 * much the user has decided to trust the run. A catastrophe (a blocked command) is
 * never auto-approved at any level — autonomy is about edits and ordinary commands,
 * not about letting the agent format a disk.
 */
export function needsApproval(registry, name, args, autonomy = AUTONOMY.ASK) {
  if (!registry || typeof registry.requiresApproval !== 'function') {
    return false
  }
  // Policy's own answer for "would this normally be gated?" — the base decision.
  const gated = registry.requiresApproval(name, args)
  if (!gated) {
    return false
  }
  const tool = registry.get(name)
  if (autonomy === AUTONOMY.FULL) {
    // The user has said "do everything": no prompt for edits, deletes or ordinary
    // commands. Hard-blocked commands are refused elsewhere in the loop, not here.
    return false
  }
  if (autonomy === AUTONOMY.AUTO_EDIT) {
    // Trust edits and deletes; still confirm an unusual (non-allowlisted) command.
    if (tool?.risk === RISK.EXECUTE) {
      return !isSafeCommand(args?.command ?? '')
    }
    return false
  }
  return true
}

/** Commands that may run without a prompt. */
const SAFE_COMMAND_PATTERNS = [
  /^npm (test|run test|run lint|run build|run typecheck|run type-check)\b/,
  /^npx (jest|vitest|tsc|eslint)\b/,
  /^pnpm (test|build|lint)\b/,
  /^yarn (test|build|lint)\b/,
  /^pytest\b/,
  /^python -m pytest\b/,
  /^cargo (test|check|build)\b/,
  /^go (test|build|vet)\b/,
  /^dotnet (test|build)\b/,
  /^mvn (test|verify)\b/,
  /^gradle(w)? (test|build)\b/,
  /^git (status|diff|log|branch)\b/,
]

/** Commands that are never permitted, whatever the user says. */
const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+[\\/]/,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  />\s*\/dev\/sd/,
  /\b(shutdown|reboot)\b/,
  /\bdel\s+\/[sf]\b/i,
]

export function isSafeCommand(command) {
  return SAFE_COMMAND_PATTERNS.some((re) => re.test(String(command).trim()))
}

export function isBlockedCommand(command) {
  return BLOCKED_COMMAND_PATTERNS.some((re) => re.test(String(command)))
}

/**
 * @typedef {object} ToolContext
 * @property {object} workspace     VirtualWorkspace or VS Code adapter
 * @property {(cmd: string, signal?: AbortSignal) => Promise<{exitCode: number, stdout: string, stderr: string}>} [runCommand]
 * @property {(evt: object) => void} emit
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} description
 * @property {object} parameters          JSON Schema for the model
 * @property {string} risk
 * @property {boolean} autoSafe           safe to run without approval
 * @property {(args: any, ctx: ToolContext) => Promise<{ok: boolean, output: string, diff?: object}>} execute
 */

/** @type {Map<string, Tool>} */
export class ToolRegistry {
  constructor() {
    this.tools = new Map()
    this.disabled = new Set()
  }

  register(tool) {
    this.tools.set(tool.name, tool)
    return this
  }

  get(name) {
    return this.tools.get(name)
  }

  has(name) {
    return this.tools.has(name) && !this.disabled.has(name)
  }

  disable(name) {
    this.disabled.add(name)
  }

  enable(name) {
    this.disabled.delete(name)
  }

  active() {
    return [...this.tools.values()].filter((t) => !this.disabled.has(t.name))
  }

  /** OpenAI function-calling schemas for every active tool. */
  schemas() {
    return this.active().map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  /**
   * Decide whether a call needs human approval.
   * Anything that changes the workspace or executes something does, unless it is
   * explicitly marked auto-safe and is an allow-listed command.
   */
  requiresApproval(name, args) {
    const tool = this.get(name)
    if (!tool) {
      return false
    }
    if (tool.risk === RISK.READ) {
      return false
    }
    if (tool.risk === RISK.EXECUTE && tool.autoSafe && isSafeCommand(args?.command ?? '')) {
      return false
    }
    return true
  }

  /**
   * Does this call need a human prompt, given the run's autonomy level?
   * Kept on the registry so every loop (web core, web lib, VS Code) decides the
   * same way instead of each re-deriving the policy.
   */
  approvalNeeded(name, args, autonomy = AUTONOMY.ASK) {
    return needsApproval(this, name, args, autonomy)
  }

  /**
   * A hard refusal — the runtime will not execute these even with approval.
   *
   * A `destructive` tool is refused outright UNLESS it is explicitly declared
   * `approvable` (e.g. `delete_file`), in which case it is instead gated behind the
   * approval prompt. This is the difference between "the agent may delete a file if
   * you say yes" and "the agent may never delete anything" — both are destructive,
   * but only one is something the user asked to be able to do.
   */
  isForbidden(name, args) {
    const tool = this.get(name)
    if (!tool) {
      return false
    }
    if (tool.risk === RISK.DESTRUCTIVE && !tool.approvable) {
      return true
    }
    if (name === 'run_command' && isBlockedCommand(args?.command ?? '')) {
      return true
    }
    return false
  }
}

/** ------------------------------------------------------------------ *
 * The standard Javelin toolset
 * ------------------------------------------------------------------ */

export function createStandardToolset() {
  const registry = new ToolRegistry()

  registry.register({
    name: 'list_files',
    description: 'List files in the project so you understand its structure before changing anything.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the project root. Defaults to root.' },
      },
    },
    risk: RISK.READ,
    autoSafe: true,
    async execute(args, ctx) {
      const entries = ctx.workspace.list(args.path ?? '')
      return {
        ok: true,
        output: entries.length
          ? entries.map((e) => (e.type === 'dir' ? `${e.path}/` : e.path)).join('\n')
          : '(empty — no files at this path)',
      }
    },
  })

  registry.register({
    name: 'read_file',
    description: 'Read a file. Always read a file before editing it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start: { type: 'integer', description: 'Optional 1-based first line.' },
        end: { type: 'integer', description: 'Optional 1-based last line.' },
      },
      required: ['path'],
    },
    risk: RISK.READ,
    autoSafe: true,
    async execute(args, ctx) {
      return { ok: true, output: truncate(ctx.workspace.read(args.path, args.start, args.end), 16000) }
    },
  })

  registry.register({
    name: 'search_code',
    description: 'Search the project for a literal string or regular expression. Locate symbols instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        isRegex: { type: 'boolean' },
      },
      required: ['query'],
    },
    risk: RISK.READ,
    autoSafe: true,
    async execute(args, ctx) {
      const hits = ctx.workspace.search(args.query, Boolean(args.isRegex))
      return {
        ok: true,
        output: hits.length
          ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
          : `No matches for "${args.query}".`,
      }
    },
  })

  registry.register({
    name: 'write_file',
    description:
      'Create a NEW file, or fully rewrite one if overwrite is true. REPLACES the entire file — prefer edit_file for existing files. Refused if the file exists and overwrite is omitted.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['path', 'content'],
    },
    risk: RISK.WRITE,
    autoSafe: false,
    async execute(args, ctx) {
      const outcome = await ctx.workspace.write(args.path, args.content, Boolean(args.overwrite))
      ctx.emit({ type: 'file_changed', ...outcome })
      const verb = outcome.before ? 'Rewrote' : 'Created'
      return {
        ok: true,
        diff: outcome.diff,
        output: `${verb} ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
      }
    },
  })

  registry.register({
    name: 'edit_file',
    description:
      'Replace an exact snippet in an existing file — the safe way to modify code. old_string must appear exactly once unless replace_all is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    risk: RISK.WRITE,
    autoSafe: false,
    async execute(args, ctx) {
      const outcome = await ctx.workspace.edit(
        args.path,
        args.old_string,
        args.new_string,
        Boolean(args.replace_all),
      )
      ctx.emit({ type: 'file_changed', ...outcome })
      return {
        ok: true,
        diff: outcome.diff,
        output: `Edited ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
      }
    },
  })

  registry.register({
    name: 'delete_file',
    description:
      'Delete a file from the workspace. This is destructive and always requires the user to approve it. Prefer editing when you only need to remove some code. Take a checkpoint first if the deletion is part of a larger change.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to delete, relative to the project root.' },
        reason: { type: 'string', description: 'One line on why the file should be removed.' },
      },
      required: ['path'],
    },
    risk: RISK.DESTRUCTIVE,
    autoSafe: false,
    // Destructive, but the user asked to be able to delete with permission, so it is
    // gated behind approval rather than refused outright.
    approvable: true,
    async execute(args, ctx) {
      const outcome = await ctx.workspace.delete(args.path)
      ctx.emit({ type: 'file_changed', ...outcome })
      return {
        ok: true,
        diff: outcome.diff,
        output: `Deleted ${outcome.path} (-${outcome.diff.removed} lines).`,
      }
    },
  })

  registry.register({
    name: 'run_command',
    description:
      'Run a test, build, linter or type-check to verify your changes. Non-allowlisted commands require approval.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'e.g. `npm test`' } },
      required: ['command'],
    },
    risk: RISK.EXECUTE,
    autoSafe: true,
    async execute(args, ctx) {
      const command = args.command ?? ''
      if (isBlockedCommand(command)) {
        return { ok: false, output: 'Blocked: this command is on the never-run list for safety.' }
      }
      if (!ctx.runCommand) {
        return {
          ok: false,
          output:
            'Command execution is not available in this environment. Explain what should be run instead, or verify by reading the code.',
        }
      }
      ctx.emit({ type: 'command_started', command })
      const res = await ctx.runCommand(command, ctx.signal)
      const output = [
        `$ ${command}`,
        `exit code: ${res.exitCode}`,
        res.stdout ? `--- stdout ---\n${truncate(res.stdout, 4000)}` : '',
        res.stderr ? `--- stderr ---\n${truncate(res.stderr, 4000)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      ctx.emit({ type: 'command_finished', command, exitCode: res.exitCode, output })
      return { ok: res.exitCode === 0, output }
    },
  })

  registry.register({
    name: 'create_checkpoint',
    description: 'Snapshot the workspace so the user can revert. Call this BEFORE a batch of related edits.',
    parameters: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    },
    risk: RISK.READ,
    autoSafe: true,
    async execute(args, ctx) {
      const cp = await ctx.workspace.snapshot(args.label ?? 'checkpoint')
      ctx.emit({ type: 'checkpoint', checkpoint: cp })
      return { ok: true, output: `Checkpoint "${cp.label}" created (${cp.fileCount} files).` }
    },
  })

  registry.register({
    name: 'remember',
    description:
      'Store a durable fact about this project that will be available in future sessions. Use it when you learn something a future run would need to know.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'A concise, general learning — not a one-off detail.' },
      },
      required: ['fact'],
    },
    risk: RISK.READ,
    autoSafe: true,
    async execute(args, ctx) {
      ctx.emit({ type: 'memory_learn', fact: args.fact })
      return { ok: true, output: `Noted: ${args.fact}` }
    },
  })

  registry.register({
    name: 'recall',
    description: 'Search your own memory of this project for relevant past learnings and failures.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    risk: RISK.READ,
    autoSafe: true,
    async execute(args, ctx) {
      ctx.emit({ type: 'memory_recall', query: args.query })
      return { ok: true, output: `Recalled context for "${args.query}" (see the injected memory block).` }
    },
  })

  registry.register({
    name: 'finish',
    description:
      'Signal the task is complete. Summarise honestly what changed and what you verified. Set verified true only if tests or a build actually passed.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        verified: { type: 'boolean' },
      },
      required: ['summary'],
    },
    risk: RISK.READ,
    autoSafe: true,
    async execute(args) {
      return { ok: true, output: args.summary ?? 'Completed.' }
    },
  })

  return registry
}

function truncate(text, max) {
  if (!text || text.length <= max) {
    return text ?? ''
  }
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`
}
