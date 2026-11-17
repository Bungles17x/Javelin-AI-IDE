/**
 * Tool layer the agent can call.
 *
 * Tools are defined in OpenAI function-calling format so any OpenAI-compatible
 * model (local or cloud) can drive them. The web build gets a *virtual* workspace
 * held in memory (a browser cannot touch the real disk); the VS Code build swaps
 * these primitives for real filesystem + task primitives. The agent loop itself is
 * identical in both.
 */

import { MAX_WRITE_CHARS } from '../engine/limits.js'

/**
 * Reject an oversized single write with instructions to chunk it.
 *
 * Silently accepting a huge `content` argument is worse: models truncate their own
 * output at the token limit, producing a file that looks written but stops mid-line.
 * Returns null when the content is a sane chunk size.
 */
export function writeChunkLimit(content) {
  const text = String(content ?? '')
  if (text.length <= MAX_WRITE_CHARS) return null
  return `That content is ${text.length.toLocaleString()} characters, but one call may contain at most ${MAX_WRITE_CHARS.toLocaleString()}. Split the file: write the beginning with write_file, then append each following section with append_file (roughly 150-250 lines per call). Do not shorten the requested file to fit one call.`
}

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
      name: 'project_overview',
      description:
        'Read the indexed architecture of the project: languages, stack, scripts, entry points, top-level layout, most-imported files, and a single file\'s imports/dependents when path is given. Use this instead of loading the whole project into context.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional file path to inspect: its symbols, imports and dependents.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        'Find where a symbol is defined and which files import the defining file. Use this before changing a shared function or export.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Symbol name, or part of one.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_project',
      description:
        'Run the project\'s own checks (test, typecheck, lint, build — whichever exist) and report real exit codes. Use this after changes and before claiming verified: true.',
      parameters: {
        type: 'object',
        properties: {
          checks: {
            type: 'array',
            items: { type: 'string', enum: ['test', 'typecheck', 'lint', 'build'] },
            description: 'Optional subset of detected checks. Defaults to every detected check.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a NEW file, or fully rewrite an existing one. This REPLACES the entire file. Prefer `edit_file` for existing files. Refused if the file exists and overwrite is omitted. One call holds at most 24,000 characters: for a larger file write the first section with this tool, then append the remaining sections with append_file.',
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
      name: 'append_file',
      description:
        'Append text to the end of a file, creating it if it does not exist. Use this to build a large file in a few small tool calls instead of one enormous write_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Text to append. Include its own trailing newline if needed.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description:
        'Create a COMPLETE, working starter project in one call. Use this first when asked to build a game, a 3D scene, a web app or a landing page — then read the generated files and customise them. Templates: game (playable canvas arcade game), 3d (three.js scene), web-app (task list), landing (product page).',
      parameters: {
        type: 'object',
        properties: {
          template: {
            type: 'string',
            enum: ['game', '3d', 'web-app', 'landing'],
            description: 'Which starter to generate.',
          },
          path: { type: 'string', description: 'Optional folder to create the project in, e.g. "dodge-game". Defaults to the project root.' },
          overwrite: { type: 'boolean', description: 'Must be true to replace files that already exist.' },
        },
        required: ['template'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_folder',
      description: 'Create a new folder inside the project. Use a project-relative path and do not use absolute paths or parent traversal.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder path relative to the project root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact snippet in an existing file. If it occurs more than once, use the 1-based occurrence number from the error context, or provide more surrounding text. Use replace_all only when every match should change.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to find, including indentation.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
          occurrence: { type: 'integer', description: '1-based matching occurrence to replace when old_string is repeated. Do not combine with replace_all.' },
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
      name: 'rename_file',
      description:
        'Rename or move a file within the workspace. Changes the file path. Use this when reorganizing the project structure.',
      parameters: {
        type: 'object',
        properties: {
          old_path: { type: 'string', description: 'Current file path relative to the project root.' },
          new_path: { type: 'string', description: 'New file path relative to the project root.' },
        },
        required: ['old_path', 'new_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description:
        'Copy a file to a new location within the workspace. Creates a duplicate of the file at the new path.',
      parameters: {
        type: 'object',
        properties: {
          source_path: { type: 'string', description: 'Source file path to copy from.' },
          dest_path: { type: 'string', description: 'Destination path for the copy.' },
        },
        required: ['source_path', 'dest_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a command in the opened project folder, such as a test, build, formatter, or project script. Use it to run, inspect, and verify project tasks. Commands outside the safe allow-list always require user approval; other commands follow the selected autonomy policy. Never claim a command ran unless you called this tool.',
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
        'Signal that the task is complete. Summarise what changed and what you verified. For create/fix/change tasks, a successful file or folder change is required before finishing. Set verified true only after verify_project or a test/build command actually passed after your last change.',
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
  /^npx (jest|vitest|tsc|eslint|prettier)\b/,
  /^pnpm (test|build|lint)\b/,
  /^yarn (test|build|lint)\b/,
  /^bun (test|build|lint)\b/,
  /^pytest\b/,
  /^python -m pytest\b/,
  /^python -m (unittest|unittest\.discover)\b/,
  /^cargo (test|check|build|clippy)\b/,
  /^go (test|build|vet|fmt)\b/,
  /^gofmt\b/,
  /^dotnet (test|build)\b/,
  /^mvn (test|verify|compile)\b/,
  /^gradle(w)? (test|build|check)\b/,
  /^make (test|check|build)\b/,
  /^make test\b/,
  /^make check\b/,
  /^make build\b/,
  /^eslint\b/,
  /^prettier\b/,
  /^black\b/,
  /^flake8\b/,
  /^pylint\b/,
  /^mypy\b/,
  /^ruff\b/,
  /^rustfmt\b/,
  /^gofmt\b/,
  /^clang-format\b/,
  /^clang-tidy\b/,
  /^swiftlint\b/,
  /^shellcheck\b/,
  /^hadolint\b/,
  /^tflint\b/,
  /^terraform (fmt|validate)\b/,
  /^docker (build|compose build)\b/,
  /^git (status|diff|log|branch|remote|show)\b/,
  /^git log\b/,
  /^git diff\b/,
  /^git status\b/,
]

/** Commands that are never allowed, even with approval. */
const BLOCKED_COMMANDS = [
  /\brm\s+-rf\s+[\\/]/,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  />\s*\/dev\/sd/,
  /\b(shutdown|reboot|poweroff|halt)\b/i,
  /\bdel\s+\/[sfq]\b/i,
  /\brmdir\s+\/[sq]\b/i,
  /\b(chmod|chown)\s+777\b/,
  /\bsudo\s+(rm|dd|mkfs|format)\b/,
  /\bdd\s+if=/,
  /\bwget\s+.*\|.*sh\b/,
  /\bcurl\s+.*\|.*sh\b/,
  /\b(?:eval|exec)\s+\$\(/,
  /\becho\s+.*\|.*sh\b/,
  />\s*\/(dev|proc|sys)\//,
  /\bmount\s+.*\/dev\/sd/,
  /\bumount\s+.*\/dev\/sd/,
  /\b(sfdisk|fdisk|parted)\b/,
  /\b(parted|partprobe)\b/,
  /\b(cryptsetup|luks)\b/,
  /\b(wipe|shred)\s+/,
  /\b(scrub|srm)\s+/,
  /\b(?:rm|del)\s+-rf\s+\//,
  /\bmv\s+.*\//,
  /\bcp\s+.*\//,
  /\bchmod\s+.*\//,
  /\bchown\s+.*\//,
  /\buseradd|userdel|usermod\b/,
  /\bgroupadd|groupdel|groupmod\b/,
  /\bpasswd\b/,
  /\bsu\b/,
  /\bsudo\s+su\b/,
  /\bcrontab\b/,
  /\bat\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bservice\s+.*stop\b/,
  /\binit\s+[0-6]\b/,
  /\btelinit\s+[0-6]\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\bkillall\b/,
  /\bpkill\s+-9\b/,
  /\bkill\s+-9\s+1\b/,
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

  // Bound the quadratic LCS work by total cells, not line count alone.
  const MAX_DIFF_CELLS = 1_000_000
  if (m * n > MAX_DIFF_CELLS) {
    return computeSimpleDiff(a, b)
  }

  // LCS table for manageable inputs; the cell limit keeps time and memory bounded.
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

/** Linear-time diff for large files, preserving the changed block and nearby context. */
function computeSimpleDiff(a, b) {
  const lines = []
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  ) suffix++

  const removed = a.length - prefix - suffix
  const added = b.length - prefix - suffix
  const contextSize = 25
  const startContext = Math.max(0, prefix - contextSize)
  for (let i = startContext; i < prefix; i++) {
    lines.push({ type: 'context', text: a[i], aLine: i + 1, bLine: i + 1 })
  }

  if (removed > 100) {
    for (let i = prefix; i < prefix + 50; i++) lines.push({ type: 'remove', text: a[i], aLine: i + 1 })
    lines.push({ type: 'context', text: `… ${removed - 100} removed lines omitted …`, aLine: 0, bLine: 0 })
    for (let i = a.length - suffix - 50; i < a.length - suffix; i++) {
      lines.push({ type: 'remove', text: a[i], aLine: i + 1 })
    }
  } else {
    for (let i = prefix; i < a.length - suffix; i++) lines.push({ type: 'remove', text: a[i], aLine: i + 1 })
  }

  if (added > 100) {
    for (let i = prefix; i < prefix + 50; i++) lines.push({ type: 'add', text: b[i], bLine: i + 1 })
    lines.push({ type: 'context', text: `… ${added - 100} added lines omitted …`, aLine: 0, bLine: 0 })
    for (let i = b.length - suffix - 50; i < b.length - suffix; i++) {
      lines.push({ type: 'add', text: b[i], bLine: i + 1 })
    }
  } else {
    for (let i = prefix; i < b.length - suffix; i++) lines.push({ type: 'add', text: b[i], bLine: i + 1 })
  }

  for (let i = a.length - suffix; i < a.length - suffix + Math.min(contextSize, suffix); i++) {
    lines.push({ type: 'context', text: a[i], aLine: i + 1, bLine: b.length - suffix + (i - (a.length - suffix)) + 1 })
  }

  return { lines, added, removed, simple: true }
}

/**
 * Tool arguments that name a workspace path, per tool.
 *
 * Centralised so the agent loop, the workspace and the approval preview all
 * canonicalise a path the same way. A model that writes `./src/a.js` and then
 * reads `src\\a.js` means one file, not two.
 */
export const PATH_ARGUMENTS = {
  list_files: ['path'],
  read_file: ['path'],
  write_file: ['path'],
  append_file: ['path'],
  create_folder: ['path'],
  create_project: ['path'],
  edit_file: ['path'],
  delete_file: ['path'],
  rename_file: ['old_path', 'new_path'],
  copy_file: ['source_path', 'dest_path'],
}

/**
 * Canonicalise a model-supplied workspace path to `dir/file` form.
 *
 * Handles the variations small models actually emit: surrounding quotes or
 * backticks, Windows separators, a leading `./`, duplicate slashes and a
 * `file://` scheme. Absolute paths are handled by each workspace, which knows its
 * own root.
 */
export function normalizeToolPath(path) {
  if (typeof path !== 'string') return path
  let value = path.trim()
  if (!value) return value
  const quoted = value.match(/^([`'"])([\s\S]*)\1$/)
  if (quoted) value = quoted[2].trim()
  value = value.replace(/^file:\/\/+/i, '/')
  value = value.replace(/\\/g, '/')
  value = value.replace(/\/{2,}/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  value = value.replace(/\/\.\//g, '/').replace(/\/\.$/, '')
  return value
}

/**
 * Normalise tool arguments before anything reads them.
 *
 * Local models sometimes send the arguments as a JSON string, and sometimes use
 * `file_path`/`filename` instead of the schema's `path`. Both describe the same
 * call, so repair them here rather than letting a missing path turn into a fake
 * repeated-action loop.
 */
export function normalizeToolArgs(call) {
  let args = call?.args
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = { __raw: args, __parseError: true }
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}

  const keys = PATH_ARGUMENTS[call?.name]
  if (!keys) return args === call?.args ? call : { ...call, args }

  let changed = args !== call?.args
  const nextArgs = { ...args }
  for (const key of keys) {
    const value = nextArgs[key]
    if (typeof value !== 'string') continue
    const next = normalizeToolPath(value)
    if (next !== value) {
      nextArgs[key] = next
      changed = true
    }
  }

  // Common aliases small models emit for a path argument.
  if (call?.name !== 'rename_file' && call?.name !== 'copy_file') {
    const hasPath = typeof nextArgs.path === 'string' && nextArgs.path.trim()
    if (!hasPath) {
      for (const alias of ['file_path', 'filepath', 'file', 'filename', 'target_file', 'target_path', 'directory', 'dir']) {
        if (typeof nextArgs[alias] !== 'string' || !nextArgs[alias].trim()) continue
        nextArgs.path = normalizeToolPath(nextArgs[alias])
        changed = true
        break
      }
    }
  }

  return changed ? { ...call, args: nextArgs } : call
}

/** Build a small function-call signature digest so we can recognise repeated attempts. */
export function signatureOf(name, args) {
  const a = args ?? {}
  switch (name) {
    case 'read_file':
      // A different slice of the same file is a different request.
      return `read_file:${normalizeToolPath(a.path)}:${a.start ?? ''}-${a.end ?? ''}`
    case 'edit_file':
      return `edit_file:${normalizeToolPath(a.path)}:${hashSignature(JSON.stringify([a.old_string, a.new_string, Boolean(a.replace_all), a.occurrence ?? null]))}`
    case 'write_file':
      // Same path with different content is new work; identical content is a no-op.
      return `write_file:${normalizeToolPath(a.path)}:${hashSignature(String(a.content ?? ''))}:${a.overwrite ? 'overwrite' : 'create'}`
    case 'append_file':
      return `append_file:${normalizeToolPath(a.path)}:${hashSignature(String(a.content ?? ''))}`
    case 'create_folder':
      return `create_folder:${normalizeToolPath(a.path)}`
    case 'create_project':
      return `create_project:${a.template}:${normalizeToolPath(a.path) || '.'}`
    case 'delete_file':
      return `delete_file:${normalizeToolPath(a.path)}`
    case 'rename_file':
      return `rename_file:${normalizeToolPath(a.old_path)}->${normalizeToolPath(a.new_path)}`
    case 'copy_file':
      return `copy_file:${normalizeToolPath(a.source_path)}->${normalizeToolPath(a.dest_path)}`
    case 'run_command':
      return `run_command:${(a.command ?? '').trim()}`
    case 'search_code':
      return `search_code:${a.query}:${a.isRegex ? 'regex' : 'literal'}`
    case 'list_files':
      return `list_files:${normalizeToolPath(a.path) || '.'}`
    case 'create_checkpoint':
      return `create_checkpoint:${a.label}`
    case 'finish':
      return 'finish'
    default:
      return `${name}:${JSON.stringify(a).slice(0, 120)}`
  }
}

function hashSignature(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
