/**
 * Tool layer the agent can call.
 *
 * Tools are defined in OpenAI function-calling format so any OpenAI-compatible
 * model (local or cloud) can drive them. The web build gets a *virtual* workspace
 * held in memory (a browser cannot touch the real disk); the VS Code build swaps
 * these primitives for real filesystem + task primitives. The agent loop itself is
 * identical in both.
 */

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the project so you can understand its structure before changing anything.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list, relative to the project root. Defaults to root.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Always read a file before editing it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          start: { type: 'integer', description: 'Optional 1-based first line to read.' },
          end: { type: 'integer', description: 'Optional 1-based last line to read.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        'Search the project for a literal string or regular expression. Use this to locate symbols and usages instead of guessing.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex to search for.' },
          isRegex: { type: 'boolean', description: 'Treat query as a regular expression.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a NEW file, or fully rewrite an existing one. This REPLACES the entire file. Prefer `edit_file` for existing files. Refused if the file exists and overwrite is omitted.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          overwrite: {
            type: 'boolean',
            description: 'Must be true to intentionally replace an existing file. Omit for new files.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact snippet in an existing file. This is the safe way to modify code. The old_string must appear exactly once unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to find, including indentation.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a file from the workspace. Destructive — the user must approve it before it happens. Prefer edit_file when you only need to remove some code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to delete, relative to the project root.' },
          reason: { type: 'string', description: 'One line on why the file should be removed.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a test, build, linter or type-check command. Use it to verify your changes. Only allow-listed, non-destructive commands run without approval.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run, e.g. `npm test`.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_checkpoint',
      description:
        'Snapshot the current workspace state so the user can revert. Call this BEFORE a batch of related edits.',
      parameters: {
        type: 'object',
        properties: { label: { type: 'string' } },
        required: ['label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        'Signal that the task is complete. Summarise what changed and what you verified. Call this only when the work is done and verified.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          verified: { type: 'boolean', description: 'True only if you ran tests/build and they passed.' },
        },
        required: ['summary'],
      },
    },
  },
]

/** Commands that are safe to run without an approval prompt. */
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
]

/** Commands that are never allowed, even with approval. */
const BLOCKED_COMMANDS = [
  /\brm\s+-rf\s+[\\/]/,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  />\s*\/dev\/sd/,
]

export function isSafeCommand(command) {
  const cmd = command.trim()
  return SAFE_COMMAND_PATTERNS.some((re) => re.test(cmd))
}

export function isBlockedCommand(command) {
  return BLOCKED_COMMANDS.some((re) => re.test(command))
}

/** Compute a line-level diff between two strings. */
export function computeDiff(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const m = a.length
  const n = b.length

  // LCS table. Diffs here are file-sized, so O(m*n) is fine and keeps the module
  // dependency-free.
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const lines = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ type: 'context', text: a[i], aLine: i + 1, bLine: j + 1 })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: 'remove', text: a[i], aLine: i + 1 })
      i++
    } else {
      lines.push({ type: 'add', text: b[j], bLine: j + 1 })
      j++
    }
  }
  while (i < m) lines.push({ type: 'remove', text: a[i], aLine: ++i })
  while (j < n) lines.push({ type: 'add', text: b[j], bLine: ++j })

  const added = lines.filter((l) => l.type === 'add').length
  const removed = lines.filter((l) => l.type === 'remove').length
  return { lines, added, removed }
}

/** Build a small function-call signature digest so we can recognise repeated attempts. */
export function signatureOf(name, args) {
  const a = args ?? {}
  switch (name) {
    case 'read_file':
      return `read_file:${a.path}`
    case 'edit_file':
      return `edit_file:${a.path}::${(a.old_string ?? '').slice(0, 80)}`
    case 'write_file':
      return `write_file:${a.path}`
    case 'delete_file':
      return `delete_file:${a.path}`
    case 'run_command':
      return `run_command:${(a.command ?? '').trim()}`
    case 'search_code':
      return `search_code:${a.query}`
    case 'list_files':
      return `list_files:${a.path ?? '.'}`
    case 'create_checkpoint':
      return `create_checkpoint:${a.label}`
    case 'finish':
      return 'finish'
    default:
      return `${name}:${JSON.stringify(a).slice(0, 120)}`
  }
}
