/**
 * Javelin Engine — project intelligence.
 *
 * The agent gets a bounded, structured view of the project instead of the whole
 * codebase: languages, layout, stack, entry points, symbols, imports and reverse
 * dependencies. This is what lets it ground a diagnosis in real files and see the
 * blast radius of a change before it edits anything.
 *
 * Everything here is deliberately dependency-free and regex-based. It is an index,
 * not a compiler: it tells the model where to look, and the agent still reads the
 * file before editing it.
 */

import { buildProjectIndex } from '../core/memory.js'

const RESOLVE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.vue', '.svelte', '.css']
const RELATIVE_IMPORT = /^\.{1,2}\//
const JS_IMPORT =
  /(?:^|[^\w$])(?:import\s+(?:[^'"\n]*?\s+from\s+)?|export\s+[^'"\n]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g
const PY_FROM = /^\s*from\s+([.\w]+)\s+import\b/
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'have', 'will',
  'please', 'make', 'add', 'fix', 'use', 'using', 'file', 'files', 'code', 'error',
  'issue', 'problem', 'task', 'project', 'when', 'then', 'should', 'would', 'could',
])

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function normalizeJoin(base, spec) {
  const parts = `${base ? `${base}/` : ''}${spec}`.replace(/\\/g, '/').split('/')
  const out = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** Resolve a relative import to a real workspace path, when one exists. */
export function resolveImport(fromPath, specifier, files) {
  const clean = String(specifier ?? '').replace(/[?#].*$/, '')
  if (!RELATIVE_IMPORT.test(clean)) {
    return { external: true, resolved: null }
  }
  const base = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const joined = normalizeJoin(base, clean)
  if (files.has(joined)) return { external: false, resolved: joined }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (files.has(`${joined}${ext}`)) return { external: false, resolved: `${joined}${ext}` }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (files.has(`${joined}/index${ext}`)) return { external: false, resolved: `${joined}/index${ext}` }
  }
  return { external: false, resolved: null }
}

/** Extract imports and resolve local ones against the current file map. */
export function parseImports(path, content, files) {
  // `files` is a Set or Map: only membership is needed during resolution.
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const imports = []
  const lines = String(content ?? '').split('\n')

  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      JS_IMPORT.lastIndex = 0
      let match
      while ((match = JS_IMPORT.exec(line))) {
        const specifier = match[1]
        if (!specifier) continue
        const resolved = resolveImport(path, specifier, files)
        imports.push({ specifier, line: i + 1, ...resolved })
      }
    }
    return imports
  }

  if (ext === 'py') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const from = line.match(PY_FROM)
      if (from?.[1]) {
        const specifier = from[1]
        const relative = specifier.startsWith('.')
        const resolved = relative
          ? resolvePythonImport(path, specifier, files)
          : { external: true, resolved: null }
        imports.push({ specifier, line: i + 1, ...resolved })
        continue
      }
      const direct = line.match(PY_IMPORT)
      if (direct?.[1]) {
        for (const part of direct[1].split(',').map((value) => value.trim()).filter(Boolean)) {
          imports.push({ specifier: part, line: i + 1, external: true, resolved: null })
        }
      }
    }
  }
  return imports
}

function resolvePythonImport(fromPath, specifier, files) {
  const dots = specifier.match(/^\.+/)?.[0].length ?? 0
  const module = specifier.slice(dots).replace(/\./g, '/')
  const baseParts = fromPath.split('/').slice(0, -1)
  for (let up = 1; up < dots; up++) baseParts.pop()
  const joined = normalizeJoin(baseParts.join('/'), module)
  const candidates = [joined, `${joined}.py`, `${joined}/__init__.py`]
  return { external: false, resolved: candidates.find((candidate) => files.has(candidate)) ?? null }
}

function detectPackageManager(files) {
  if (files['pnpm-lock.yaml']) return 'pnpm'
  if (files['yarn.lock']) return 'yarn'
  if (files['bun.lockb'] || files['bun.lock']) return 'bun'
  return 'npm'
}

function buildDirectories(index, files) {
  const directories = new Map()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    if (parts.length < 2) continue
    const top = parts[0]
    directories.set(top, (directories.get(top) ?? 0) + 1)
  }
  index.directories = directories
}

function detectFrameworks(index) {
  const all = { ...(index.packageInfo?.dependencies ?? {}), ...(index.packageInfo?.devDependencies ?? {}) }
  const names = Object.keys(all)
  const checks = [
    ['React', 'react'],
    ['Vue', 'vue'],
    ['Svelte', 'svelte'],
    ['Next.js', 'next'],
    ['Vite', 'vite'],
    ['Electron', 'electron'],
    ['Express', 'express'],
    ['Tailwind CSS', 'tailwindcss'],
    ['TypeScript', 'typescript'],
    ['Vitest', 'vitest'],
    ['Jest', 'jest'],
  ]
  index.frameworks = checks.filter(([, dependency]) => names.includes(dependency)).map(([label]) => label)
  index.packageNames = names
}

function detectEntryPoints(index, files) {
  const points = []
  const main = index.packageInfo?.main
  if (main) points.push(main.replace(/^\.\//, ''))
  for (const candidate of ['src/main.jsx', 'src/main.js', 'src/index.js', 'src/index.ts', 'src/App.jsx', 'index.html']) {
    if (files[candidate] && !points.includes(candidate)) points.push(candidate)
  }
  index.entryPoints = points.slice(0, 6)
}

/** Rebuild the reverse dependency map from resolved imports. */
export function recomputeDependents(index) {
  const dependents = new Map()
  for (const [path, imports] of index.imports) {
    for (const entry of imports) {
      if (!entry.resolved) continue
      const list = dependents.get(entry.resolved) ?? []
      if (!list.includes(path)) list.push(path)
      dependents.set(entry.resolved, list)
    }
  }
  index.dependents = dependents
}

/** Build a full index from path -> content. */
export function buildWorkspaceIndex(files) {
  const base = buildProjectIndex(files)
  const index = {
    files: base.files,
    symbols: base.symbols,
    languages: base.languages,
    totalLines: base.totalLines,
    imports: new Map(),
    dependents: new Map(),
    directories: new Map(),
    frameworks: [],
    entryPoints: [],
    packageNames: [],
    packageManager: detectPackageManager(files),
    packageInfo: null,
    scripts: {},
  }

  const known = new Set(Object.keys(files))
  for (const [path, content] of Object.entries(files)) {
    index.imports.set(path, parseImports(path, content, known))
  }
  const packageInfo = files['package.json'] ? safeJson(files['package.json']) : null
  index.packageInfo = packageInfo
  index.scripts = packageInfo?.scripts ?? {}
  detectFrameworks(index)
  detectEntryPoints(index, files)
  buildDirectories(index, files)
  recomputeDependents(index)
  return index
}

/** Rebuild from the live workspace. Cheap enough to run after a change. */
export function refreshProjectIndex(memory, workspace) {
  try {
    const files = typeof workspace?.toJSON === 'function' ? workspace.toJSON() : null
    if (!files) return memory.projectIndex ?? null
    memory.projectIndex = buildWorkspaceIndex(files)
    return memory.projectIndex
  } catch {
    return memory.projectIndex ?? null
  }
}

function taskTerms(task) {
  const terms = new Set()
  for (const raw of String(task ?? '').matchAll(/[A-Za-z_$][\w$.-]{2,}/g)) {
    const word = raw[0]
    for (const part of word.split(/[._-]/)) {
      if (part.length > 2 && !STOP_WORDS.has(part.toLowerCase())) terms.add(part.toLowerCase())
    }
    if (!STOP_WORDS.has(word.toLowerCase())) terms.add(word.toLowerCase())
  }
  return [...terms]
}

/**
 * Select the files that matter for this task. Scores names, symbols and imports;
 * never dumps file contents, so a large project costs only a small prompt block.
 */
export function relevantFiles(index, task, limit = 8) {
  if (!index) return []
  const terms = taskTerms(task)
  const scored = []
  for (const [path, meta] of index.files) {
    const lowerPath = path.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (lowerPath.includes(term)) score += 3
      if (meta.symbols?.some((symbol) => String(symbol).toLowerCase().includes(term))) score += 3
      if (index.imports.get(path)?.some((entry) => entry.specifier.toLowerCase().includes(term))) score += 1
    }
    if (score > 0) scored.push({ path, score })
  }
  // Tests next to a relevant source file often encode the expected behaviour.
  for (const candidate of [...scored]) {
    const base = candidate.path.replace(/\.(?:js|jsx|ts|tsx|mjs|cjs|py)$/i, '')
    for (const path of index.files.keys()) {
      if (!/\.(?:test|spec)\./.test(path)) continue
      if (path.includes(base.split('/').pop())) scored.push({ path, score: candidate.score - 1 })
    }
  }
  const seen = new Set()
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter(({ path }) => (seen.has(path) ? false : seen.add(path)))
    .slice(0, limit)
}

/**
 * The block injected into the agent's context at the start of a run.
 * Bounded by `maxChars` so a large repository never fills the model window.
 */
export function buildProjectContext(index, task, { maxChars = 5_000 } = {}) {
  if (!index || !index.files.size) return null
  const languages = [...index.languages.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => `${language} (${count})`)
    .join(', ')
  const directories = [...index.directories.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}/ (${count})`)
    .join(', ')
  const scripts = Object.keys(index.scripts ?? {})
  const relevant = relevantFiles(index, task)

  const parts = [
    'PROJECT CONTEXT — indexed from the real workspace. Use this map to decide what to read; never invent paths, symbols or APIs.',
    `Overview: ${index.files.size} files, ${index.totalLines} lines. Languages: ${languages || 'unknown'}.`,
  ]
  if (index.frameworks.length) parts.push(`Stack: ${index.frameworks.join(', ')}.`)
  if (index.packageManager) parts.push(`Package manager: ${index.packageManager}.`)
  if (scripts.length) parts.push(`Scripts: ${scripts.join(', ')}.`)
  if (directories) parts.push(`Layout: ${directories}.`)
  if (index.entryPoints.length) parts.push(`Entry points: ${index.entryPoints.join(', ')}.`)

  if (relevant.length) {
    const lines = relevant.map(({ path }) => {
      const meta = index.files.get(path)
      const symbols = meta?.symbols?.slice(0, 8).join(', ')
      const dependents = index.dependents.get(path) ?? []
      const imports = (index.imports.get(path) ?? [])
        .filter((entry) => entry.resolved)
        .slice(0, 4)
        .map((entry) => entry.resolved)
      return (
        `- ${path} (${meta?.lang ?? 'text'}, ${meta?.lines ?? '?'} lines)` +
        (symbols ? ` — symbols: ${symbols}` : '') +
        (imports.length ? `; imports ${imports.join(', ')}` : '') +
        (dependents.length ? `; imported by ${dependents.slice(0, 4).join(', ')}` : '')
      )
    })
    parts.push(`Files most relevant to this task:\n${lines.join('\n')}`)
  }

  const text = parts.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 80)}\n… [project context shortened to fit the context budget]`
}

/** Human-readable architecture overview for the `project_overview` tool. */
export function formatProjectOverview(index, path = '') {
  if (!index || !index.files.size) return 'The workspace is empty — there is no project to index yet.'
  const focus = String(path ?? '').trim()
  if (focus) {
    const meta = index.files.get(focus)
    if (!meta) return `No indexed file at ${focus}. Use list_files to see what exists.`
    const imports = index.imports.get(focus) ?? []
    const dependents = index.dependents.get(focus) ?? []
    return [
      `${focus} — ${meta.lang}, ${meta.lines} lines, ${meta.bytes} bytes.`,
      meta.symbols?.length ? `Symbols: ${meta.symbols.join(', ')}` : 'No top-level symbols detected.',
      imports.length
        ? `Imports:\n${imports.map((entry) => `- ${entry.line}: ${entry.specifier}${entry.resolved ? ` → ${entry.resolved}` : entry.external ? ' (external)' : ' (UNRESOLVED)'}`).join('\n')}`
        : 'Imports: none detected.',
      dependents.length ? `Imported by: ${dependents.join(', ')}` : 'Nothing in the workspace imports this file.',
    ].join('\n')
  }

  const languages = [...index.languages.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => `${language}: ${count}`)
    .join(', ')
  const layout = [...index.directories.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `- ${name}/ — ${count} file(s)`)
    .join('\n')
  const mostImported = [...index.dependents.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([file, importers]) => `- ${file} ← ${importers.join(', ')}`)
    .join('\n')
  return [
    `Project: ${index.files.size} files, ${index.totalLines} lines.`,
    `Languages: ${languages || 'unknown'}.`,
    index.frameworks.length ? `Stack: ${index.frameworks.join(', ')}.` : '',
    index.packageManager ? `Package manager: ${index.packageManager}.` : '',
    Object.keys(index.scripts ?? {}).length ? `Scripts: ${Object.keys(index.scripts).join(', ')}.` : '',
    index.entryPoints.length ? `Entry points: ${index.entryPoints.join(', ')}.` : '',
    layout ? `Top-level layout:\n${layout}` : '',
    mostImported ? `Most-imported files:\n${mostImported}` : '',
    'This is metadata only. Read a file before editing it.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Symbol usages plus the files that import the defining file. */
export async function findReferences(index, workspace, name) {
  const needle = String(name ?? '').trim()
  if (!needle) return 'Provide a symbol name to look up.'
  const matches = [...index.symbols.keys()].filter((symbol) => symbol === needle)
  const candidates = matches.length
    ? matches
    : [...index.symbols.keys()].filter((symbol) => symbol.toLowerCase().includes(needle.toLowerCase())).slice(0, 8)
  if (!candidates.length) {
    return `No indexed symbol matches "${needle}". Use search_code for free-text matches.`
  }

  const lines = []
  for (const symbol of candidates) {
    const refs = index.symbols.get(symbol) ?? []
    lines.push(`${symbol}:`)
    for (const ref of refs.slice(0, 12)) {
      let text = ''
      try {
        const content = await workspace.read(ref.path)
        text = String(content ?? '').split('\n')[ref.line - 1]?.trim().slice(0, 140) ?? ''
      } catch {
        text = ''
      }
      lines.push(`- ${ref.path}:${ref.line} (${ref.kind})${text ? ` — ${text}` : ''}`)
      for (const importer of (index.dependents.get(ref.path) ?? []).slice(0, 6)) {
        lines.push(`  imported by ${importer}`)
      }
    }
  }
  return lines.join('\n')
}

/** Verification commands that exist in this project, in a safe order. */
export function detectVerificationCommands(index) {
  if (!index) return []
  const scripts = index.scripts ?? {}
  const manager = index.packageManager ?? 'npm'
  const checks = []
  const add = (id, script, command) => checks.push({ id, script, command })

  if (scripts.test) add('test', 'test', manager === 'npm' ? 'npm test' : `${manager} test`)
  for (const name of ['typecheck', 'type-check', 'types']) {
    if (scripts[name]) {
      add('typecheck', name, manager === 'npm' ? `npm run ${name}` : `${manager} run ${name}`)
      break
    }
  }
  if (scripts.lint) add('lint', 'lint', manager === 'npm' ? 'npm run lint' : `${manager} run lint`)
  if (scripts.build) add('build', 'build', manager === 'npm' ? 'npm run build' : `${manager} run build`)
  return checks
}

/** A command whose exit code actually tells us whether the work holds. */
export function isVerificationCommand(command) {
  const text = String(command ?? '')
  return /\b(?:test|tests|jest|vitest|pytest|build|lint|typecheck|type-check|tsc|check|compile|vet)\b/i.test(text) &&
    !/\b(?:dev|serve|start|watch)\b/i.test(text)
}

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs',
  'http', 'https', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline',
  'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
])

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Named/default imports in one JS/TS import statement. */
function importClause(line) {
  const match = line.match(/^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/)
  if (!match) return null
  // `import type { Foo }` is erased at build time; a type name is not a runtime API.
  const clause = match[1].trim().replace(/^type\s+/, '')
  const specifier = match[2]
  const names = []
  const addName = (part) => {
    const name = part.trim().split(/\s+as\s+/)[0]?.trim().replace(/^type\s+/, '')
    if (name) names.push(name)
  }
  if (clause.startsWith('{')) {
    for (const part of clause.replace(/[{}]/g, '').split(',')) addName(part)
  } else if (!clause.startsWith('*')) {
    const first = clause.split(',')[0].trim()
    if (first && !first.startsWith('{') && !first.startsWith('*')) names.push('default')
    const braced = clause.match(/\{([^}]*)\}/)?.[1]
    if (braced) {
      for (const part of braced.split(',')) addName(part)
    }
  }
  return { specifier, names }
}

async function targetExists(workspace, fromPath, specifier) {
  const clean = specifier.replace(/[?#].*$/, '')
  const base = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const joined = normalizeJoin(base, clean)
  const candidates = [joined, ...RESOLVE_EXTENSIONS.map((ext) => `${joined}${ext}`), ...RESOLVE_EXTENSIONS.map((ext) => `${joined}/index${ext}`)]
  for (const candidate of candidates) {
    try {
      if (await workspace.exists(candidate)) return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

/**
 * Check that names imported from local files are actually exported, and that bare
 * package imports are declared in package.json. This catches the most common form of
 * invented API: a plausible function name the target module never exports.
 */
export async function checkLocalExports(workspace, index, path, content) {
  const warnings = []
  const dependencies = { ...(index?.packageInfo?.dependencies ?? {}), ...(index?.packageInfo?.devDependencies ?? {}) }
  const lines = String(content ?? '').split('\n')
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const parsed = importClause(lines[lineNumber])
    if (!parsed || !parsed.names.length) continue
    const { specifier, names } = parsed

    if (!RELATIVE_IMPORT.test(specifier)) {
      // Common path aliases (`@/`, `~/`, `#internal`) are resolved by the project's
      // bundler, not package.json; do not report them as undeclared dependencies.
      if (/^(?:[@~]\/|#|\/)/.test(specifier)) continue
      const root = specifier.startsWith('node:') ? specifier.slice(5) : specifier.split('/')[0]
      if (NODE_BUILTINS.has(root)) continue
      if (index?.packageInfo && !dependencies[root] && !dependencies[`@types/${root}`]) {
        warnings.push({
          path,
          line: lineNumber + 1,
          specifier,
          message: `${path}:${lineNumber + 1} imports package "${root}", which is not declared in package.json. Do not add an undeclared dependency without checking that it is installed.`,
        })
      }
      continue
    }

    const target = await targetExists(workspace, path, specifier)
    if (!target) continue // unresolved import is reported separately by unresolvedImports
    let targetContent = ''
    try {
      targetContent = String((await workspace.read(target)) ?? '')
    } catch {
      continue
    }
    if (/\bexport\s*\*\s*from\b/.test(targetContent) || /\bmodule\.exports\b/.test(targetContent) && names.includes('default')) continue
    for (const name of names) {
      if (!name) continue
      const declared = name === 'default'
        ? /\bexport\s+default\b/.test(targetContent)
        : new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${escapeRegExp(name)}\\b`).test(targetContent) ||
          new RegExp(`\\bexport\\s*\\{[^}]*\\b${escapeRegExp(name)}\\b`).test(targetContent) ||
          new RegExp(`\\bexports\\.${escapeRegExp(name)}\\s*=`).test(targetContent)
      if (!declared) {
        warnings.push({
          path,
          line: lineNumber + 1,
          specifier,
          name,
          message: `${path}:${lineNumber + 1} imports "${name}" from ${specifier}, but ${target} does not export it. Verify the API before relying on it.`,
        })
      }
    }
  }
  return warnings
}

/** Relative imports that point at files the workspace does not contain. */
export function unresolvedImports(index, changedPaths = null) {
  const warnings = []
  const paths = changedPaths?.length ? changedPaths : [...index.imports.keys()]
  for (const path of paths) {
    for (const entry of index.imports.get(path) ?? []) {
      if (entry.external || entry.resolved) continue
      if (!RELATIVE_IMPORT.test(entry.specifier)) continue
      warnings.push({
        path,
        line: entry.line,
        specifier: entry.specifier,
        message: `${path}:${entry.line} imports "${entry.specifier}", which does not resolve to a file in the workspace.`,
      })
    }
  }
  return warnings
}
