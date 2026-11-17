/**
 * Diagnostics for the workbench.
 *
 * Two sources feed the Problems panel:
 *
 *   - live syntax diagnostics while a file is open (Babel for JS/TS/JSX, the
 *     JSON parser for JSON, a bracket scanner for other languages);
 *   - compiler, linter, test and runtime output, parsed into file/line problems.
 *
 * The parser is used only in the renderer; it never executes the file.
 */

import { parse } from '@babel/parser'

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const MAX_PROBLEMS = 300
const KNOWN_EXTENSIONS = /\.(?:[cm]?[jt]sx?|jsonc?|py|rb|go|rs|java|kt|swift|php|cs|c|cc|cpp|h|hpp|css|scss|less|html?|vue|svelte|sh|bash|ps1|sql|yaml|yml|toml|ini|md|mdx|xml|dart|lua|r|scala|sol|proto)$/i

export const SEVERITY = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
}

export function normalizeProblemPath(value, root = '') {
  let path = String(value ?? '').trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!path) return ''
  path = path.replace(/\\/g, '/')
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    } catch {
      // Keep the original value when the URL is malformed.
    }
  }
  path = path.replace(/^webpack:\/\/[^/]*\//, '')
  path = path.replace(/^vite:\/\/[^/]*\//, '')
  const normalizedRoot = String(root ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedRoot && path.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    path = path.slice(normalizedRoot.length + 1)
  }
  path = path.replace(/^\.?\//, '')
  return path
}

function isFilePathCandidate(value) {
  const path = String(value ?? '').trim()
  if (!path || /\s/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return false
  return KNOWN_EXTENSIONS.test(path) || /(?:^|\/)[\w.-]+\/[\w.-]+/.test(path)
}

function cleanMessage(value) {
  return String(value ?? '')
    .replace(ANSI, '')
    .replace(/\s+\((?:at\s+)?(?:line\s+)?\d+(?::\d+)?\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function addProblem(list, problem) {
  const message = cleanMessage(problem.message)
  if (!message) return
  const path = normalizeProblemPath(problem.path)
  const normalized = {
    path,
    line: Math.max(1, Number(problem.line) || 1),
    column: Math.max(1, Number(problem.column) || 1),
    severity: problem.severity === SEVERITY.WARNING ? SEVERITY.WARNING : problem.severity === SEVERITY.INFO ? SEVERITY.INFO : SEVERITY.ERROR,
    message,
    code: problem.code ? String(problem.code) : '',
    source: problem.source || 'Javelin',
  }
  const key = `${normalized.path}:${normalized.line}:${normalized.column}:${normalized.severity}:${normalized.message}`
  if (list.some((entry) => `${entry.path}:${entry.line}:${entry.column}:${entry.severity}:${entry.message}` === key)) return
  list.push(normalized)
}

/** Convert an offset in a source string to a 1-based line/column. */
export function offsetToPosition(text, offset) {
  const source = String(text ?? '')
  const position = Math.max(0, Math.min(Number(offset) || 0, source.length))
  let line = 1
  let lastNewline = -1
  for (let index = 0; index < position; index += 1) {
    if (source[index] === '\n') {
      line += 1
      lastNewline = index
    }
  }
  return { line, column: position - lastNewline }
}

/** Parse a compiler/linter/runtime log into Problems entries. */
export function parseProblems(text, { defaultPath = '', root = '' } = {}) {
  const source = String(text ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n')
  const problems = []
  const lines = source.split('\n')
  let currentFile = defaultPath
  let pendingException = ''
  let exceptionStacked = false
  let pendingRust = ''
  let pendingPython = ''

  const pushMatch = (match, groups, severity, message, code = '', problemSource = 'build') => {
    const path = groups.path || currentFile
    addProblem(problems, {
      path,
      line: groups.line,
      column: groups.column,
      severity,
      message,
      code,
      source: problemSource,
    })
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) continue

    // ESLint prints the file on its own line, then lines like `  1:2  error ...`.
    if (!line.includes(':') && isFilePathCandidate(line)) {
      const candidate = normalizeProblemPath(line, root)
      if (candidate) currentFile = candidate
      continue
    }
    if (!/^\s*\d+\s*:/.test(line) && isFilePathCandidate(line.trim())) {
      const candidate = normalizeProblemPath(line.trim(), root)
      if (candidate) currentFile = candidate
    }

    let match

    // TypeScript: path(1,2): error TS1234: message
    match = line.match(/^\s*(.+?)\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*[-:]\s*(error|warning|info)\s*(?:([A-Z]+\d+):)?\s*(.+)$/i)
    if (match) {
      pushMatch(match, { path: match[1], line: match[2], column: match[3] }, match[4].toLowerCase(), match[6], match[5], 'tsc')
      continue
    }

    // TypeScript: path:1:2 - error TS1234: message
    match = line.match(/^\s*(.+?):(\d+):(\d+)\s*[-:]\s*(error|warning|info)\s*(?:([A-Z]+\d+):)?\s*(.+)$/i)
    if (match) {
      pushMatch(match, { path: match[1], line: match[2], column: match[3] }, match[4].toLowerCase(), match[6], match[5], 'tsc')
      continue
    }

    // path:1: error: message
    match = line.match(/^\s*(.+?):(\d+)\s*[-:]\s*(error|warning|info)\s*(?:([A-Z]+\d+):)?\s*(.+)$/i)
    if (match) {
      pushMatch(match, { path: match[1], line: match[2], column: 1 }, match[3].toLowerCase(), match[5], match[4], 'build')
      continue
    }

    // ESLint stylish output: `1:2  error  message  rule-name`
    match = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w@/-]+))?\s*$/i)
    if (match && currentFile) {
      pushMatch(match, { path: currentFile, line: match[1], column: match[2] }, match[3].toLowerCase(), match[4], match[5], 'eslint')
      continue
    }

    // Build tools: ERROR in src/file.js:10:5
    match = line.match(/^\s*(?:ERROR|error)\s+(?:in\s+)?(.+?):(\d+):(\d+)\s*[-:]?\s*(.+)$/)
    if (match) {
      pushMatch(match, { path: match[1], line: match[2], column: match[3] }, SEVERITY.ERROR, match[4], '', 'build')
      continue
    }

    // Python traceback location, followed by the exception text.
    match = line.match(/^\s*File\s+"([^"]+)",\s+line\s+(\d+)/)
    if (match) {
      pendingPython = normalizeProblemPath(match[1], root)
      addProblem(problems, {
        path: pendingPython,
        line: match[2],
        column: 1,
        severity: SEVERITY.ERROR,
        message: 'Runtime error',
        source: 'runtime',
      })
      continue
    }
    if (pendingPython && /^\s*\w*(?:Error|Exception):?\s*(.+)$/.test(line)) {
      addProblem(problems, {
        path: pendingPython,
        line: 1,
        column: 1,
        severity: SEVERITY.ERROR,
        message: line.trim(),
        source: 'runtime',
      })
      pendingPython = ''
      continue
    }

    // Rust: `--> src/main.rs:10:5` after an `error[E…]:` line.
    match = line.match(/^\s*-->\s+(.+?):(\d+):(\d+)/)
    if (match) {
      addProblem(problems, {
        path: match[1],
        line: match[2],
        column: match[3],
        severity: SEVERITY.ERROR,
        message: pendingRust || 'Compiler error',
        source: 'cargo',
      })
      pendingRust = ''
      continue
    }
    const rustError = line.match(/^\s*(error(?:\[[^\]]+\])?):\s*(.+)$/i)
    if (rustError) {
      pendingRust = `${rustError[1]}: ${rustError[2]}`
      continue
    }

    // Remember the exception line for the stack frames that follow.
    const exception = line.match(/^\s*(?:Uncaught\s+)?([A-Za-z_$][\w$]*(?:Error|Exception)|Exception):\s*(.+)$/)
    if (exception) {
      pendingException = `${exception[1]}: ${exception[2]}`
      exceptionStacked = false
      continue
    }

    // Node/browser stack frame: `at fn (src/a.js:10:5)` or `at src/a.js:10:5`.
    match = line.match(/^\s*at\s+(?:(?:async\s+)?[^()]+?\s+\()?((?:[A-Za-z]:)?[^()\s]+?):(\d+):(\d+)\)?\s*$/)
    if (match && isFilePathCandidate(match[1])) {
      addProblem(problems, {
        path: match[1],
        line: match[2],
        column: match[3],
        severity: SEVERITY.ERROR,
        message: pendingException || 'Runtime error',
        source: 'runtime',
      })
      exceptionStacked = true
      continue
    }

    // Project-level failures that have no file location.
    match = line.match(/^\s*(?:npm ERR!|error TS\d+|Error|TypeError|ReferenceError|SyntaxError):\s*(.+)$/i)
    if (match) {
      addProblem(problems, {
        path: '',
        line: 1,
        column: 1,
        severity: SEVERITY.ERROR,
        message: match[1],
        source: 'build',
      })
    }
  }

  if (pendingException && !exceptionStacked) {
    addProblem(problems, {
      path: '',
      line: 1,
      column: 1,
      severity: SEVERITY.ERROR,
      message: pendingException,
      source: 'runtime',
    })
  }

  return problems.slice(0, MAX_PROBLEMS)
}

function babelPluginsFor(path) {
  const extension = String(path ?? '').split('.').pop()?.toLowerCase()
  if (extension === 'ts' || extension === 'mts' || extension === 'cts') return ['typescript']
  if (extension === 'tsx') return ['jsx', 'typescript']
  if (['js', 'mjs', 'cjs', 'jsx'].includes(extension)) return ['jsx']
  return null
}

function babelProblems(text, path) {
  const plugins = babelPluginsFor(path)
  if (!plugins) return []
  const problems = []
  try {
    const ast = parse(String(text ?? ''), {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      attachComment: false,
      plugins,
    })
    for (const error of ast.errors ?? []) {
      addProblem(problems, {
        path,
        line: error.loc?.line ?? 1,
        column: (error.loc?.column ?? 0) + 1,
        severity: SEVERITY.ERROR,
        message: error.reasonCode ? `${error.message} (${error.reasonCode})` : error.message,
        source: 'Babel',
      })
    }
  } catch (error) {
    addProblem(problems, {
      path,
      line: error.loc?.line ?? 1,
      column: (error.loc?.column ?? 0) + 1,
      severity: SEVERITY.ERROR,
      message: error.message,
      source: 'Babel',
    })
  }
  return problems
}

function jsonProblems(text, path) {
  try {
    JSON.parse(String(text ?? ''))
    return []
  } catch (error) {
    const message = String(error?.message ?? 'Invalid JSON')
    const positionMatch = message.match(/position\s+(\d+)/i)
    const lineMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i)
    const suspicious = String(text ?? '').match(/:\s*[,}\]]|,\s*[}\]]|[{[]\s*[,}\]]/)
    const fallbackPosition = suspicious ? suspicious.index + suspicious[0].length - 1 : 0
    const position = positionMatch
      ? offsetToPosition(text, Number(positionMatch[1]))
      : offsetToPosition(text, fallbackPosition)
    return [{
      path,
      line: suspicious ? position.line : lineMatch ? Number(lineMatch[1]) : position.line,
      column: suspicious ? position.column : lineMatch ? Number(lineMatch[2]) : position.column,
      severity: SEVERITY.ERROR,
      message: message.replace(/\s+in JSON at position\s+\d+.*$/i, '').replace(/\s+at line\s+\d+.*$/i, ''),
      source: 'JSON',
    }]
  }
}

/**
 * JSONC is JSON with comments and trailing commas. Replace those characters
 * with spaces instead of deleting them so every reported line and column still
 * points at the original file.
 */
function stripJsonc(text) {
  const source = String(text ?? '')
  const chars = source.split('')
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      else chars[index] = ' '
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        blockComment = false
        index += 1
      } else if (char !== '\n') {
        chars[index] = ' '
      }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '/' && next === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      blockComment = true
      index += 1
    }
  }

  inString = false
  escaped = false
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char !== ',') continue
    let previous = index - 1
    while (previous >= 0 && /\s/.test(chars[previous])) previous -= 1
    if (chars[previous] === ':' || chars[previous] === '[' || chars[previous] === '{') continue
    let next = index + 1
    while (next < chars.length && /\s/.test(chars[next])) next += 1
    if (chars[next] === '}' || chars[next] === ']') chars[index] = ' '
  }
  return chars.join('')
}

function bracketProblems(text, path) {
  const source = String(text ?? '')
  const stack = []
  const problems = []
  let quote = ''
  let template = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  let line = 1
  let column = 0

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    column += 1
    if (char === '\n') {
      line += 1
      column = 1
      lineComment = false
      continue
    }
    if (lineComment) continue
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
        column += 1
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (template) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '`') template = false
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      column += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      column += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '`') {
      template = true
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      stack.push({ char, line, column })
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      const expected = char === ')' ? '(' : char === ']' ? '[' : '{'
      const open = stack.pop()
      if (!open || open.char !== expected) {
        addProblem(problems, {
          path,
          line,
          column,
          severity: SEVERITY.ERROR,
          message: `Unexpected '${char}'.`,
          source: 'Javelin',
        })
      }
    }
  }

  for (const open of stack.slice(-8)) {
    addProblem(problems, {
      path,
      line: open.line,
      column: open.column,
      severity: SEVERITY.ERROR,
      message: `Unclosed '${open.char}'.`,
      source: 'Javelin',
    })
  }
  return problems
}

/** Live diagnostics for a single file, without executing it. */
export function editorDiagnostics(language, text, path = '') {
  const source = String(text ?? '')
  const ext = String(path ?? '').split('.').pop()?.toLowerCase()
  const problems = []

  if (language === 'json' || ext === 'json' || ext === 'jsonc') {
    const jsonc = ext === 'jsonc' || /\.vscode[\\/][^\\/]*\.json$/i.test(path)
    problems.push(...jsonProblems(jsonc ? stripJsonc(source) : source, path))
  } else if (babelPluginsFor(path)) {
    problems.push(...babelProblems(source, path))
  } else if (['python', 'ruby', 'go', 'rust', 'java', 'kotlin', 'swift', 'php', 'csharp', 'cpp', 'c', 'lua', 'scala', 'dart', 'r'].includes(language)) {
    problems.push(...bracketProblems(source, path))
  }

  if (['javascript', 'typescript'].includes(language) || ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (/\bdebugger\b/.test(line) && !/^\s*\/\//.test(line)) {
        addProblem(problems, {
          path,
          line: index + 1,
          column: Math.max(1, line.indexOf('debugger') + 1),
          severity: SEVERITY.WARNING,
          message: 'Remove the debugger statement before shipping.',
          source: 'Javelin',
        })
      }
    }
  }

  return problems.slice(0, MAX_PROBLEMS)
}

export function problemKey(problem) {
  return `${problem.path}:${problem.line}:${problem.column}:${problem.severity}:${problem.message}`
}

export function mergeProblems(...lists) {
  const merged = []
  const seen = new Set()
  for (const list of lists) {
    for (const problem of list ?? []) {
      const key = problemKey(problem)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(problem)
    }
  }
  const rank = { error: 0, warning: 1, info: 2 }
  return merged
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)
    .slice(0, MAX_PROBLEMS)
}

export function summarizeProblems(problems = []) {
  let errors = 0
  let warnings = 0
  for (const problem of problems) {
    if (problem.severity === SEVERITY.ERROR) errors += 1
    else if (problem.severity === SEVERITY.WARNING) warnings += 1
  }
  return { errors, warnings, total: problems.length }
}
