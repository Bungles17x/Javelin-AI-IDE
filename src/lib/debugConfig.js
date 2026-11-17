/**
 * Debug configuration discovery.
 *
 * Reads `.vscode/launch.json` when present (the VS Code format), otherwise
 * generates a sensible Node launch configuration from the project's package.json
 * or conventional entry files. Only Node programs are offered for the inspector
 * debugger; everything else remains a normal run task.
 */

const NODE_EXTENSIONS = new Set(['js', 'mjs', 'cjs'])

function extension(path) {
  return String(path ?? '').split('.').pop()?.toLowerCase() ?? ''
}

export function isDebuggableFile(path) {
  return NODE_EXTENSIONS.has(extension(path))
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/')
}

function normalizeRoot(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function stripJsonComments(text) {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    output += char
  }
  return stripTrailingCommas(output)
}

function stripTrailingCommas(text) {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next])) next += 1
      if (text[next] === '}' || text[next] === ']') continue
    }
    output += char
  }
  return output
}

function resolveVariables(value, { activeFile = '' } = {}) {
  const active = normalizePath(activeFile)
  return String(value ?? '')
    .replace(/\$\{workspaceFolder\}|\$\{workspaceRoot\}/g, '')
    .replace(/\$\{file\}/g, active)
    .replace(/\$\{relativeFile\}/g, active)
    .replace(/\$\{fileBasename\}/g, active.split('/').pop() ?? '')
    .replace(/^\/+/, '')
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

function stringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'string'))
}

function configId(name, program) {
  return `node:${name}:${program}`
}

function makeConfig({ name, program, args = [], env = {}, cwd = '', runtimeArgs = [], source = 'auto' }) {
  const normalizedProgram = normalizePath(program)
  if (!normalizedProgram || !isDebuggableFile(normalizedProgram)) return null
  return {
    id: configId(name, normalizedProgram),
    name: name || `Launch ${normalizedProgram}`,
    type: 'node',
    request: 'launch',
    program: normalizedProgram,
    args: stringArray(args),
    env: stringMap(env),
    cwd: normalizePath(cwd),
    runtimeArgs: stringArray(runtimeArgs),
    source,
  }
}

function launchConfigurations(contents, activeFile) {
  const launch = contents['.vscode/launch.json'] ?? contents['.vscode/launch.jsonc']
  if (typeof launch !== 'string' || !launch.trim()) return []
  try {
    const parsed = JSON.parse(stripJsonComments(launch))
    const configurations = Array.isArray(parsed?.configurations) ? parsed.configurations : []
    return configurations
      .filter((entry) => entry && typeof entry === 'object')
      .filter((entry) => ['node', 'pwa-node', 'node-terminal'].includes(String(entry.type)))
      .filter((entry) => entry.request === undefined || entry.request === 'launch')
      .filter((entry) => typeof entry.program === 'string' && entry.program.trim())
      .map((entry) => makeConfig({
        name: entry.name || 'Launch Program',
        program: resolveVariables(entry.program, { activeFile }),
        args: entry.args,
        env: entry.env,
        cwd: resolveVariables(entry.cwd ?? '', { activeFile }),
        runtimeArgs: entry.runtimeArgs,
        source: 'launch.json',
      }))
      .filter(Boolean)
  } catch {
    return []
  }
}

function autoConfigurations(contents, activeFile) {
  const configurations = []
  let packageMain = ''
  try {
    const packageJson = JSON.parse(String(contents['package.json'] ?? '{}'))
    if (typeof packageJson.main === 'string') packageMain = packageJson.main
  } catch {
    // A malformed package.json is a Problems entry, not a reason to fail debugging.
  }

  const candidates = [
    packageMain,
    'src/index.js',
    'src/server.js',
    'index.js',
    'server.js',
    'src/main.js',
    'src/app.js',
    'app.js',
  ].filter(Boolean)
  const seen = new Set()
  for (const candidate of candidates) {
    const program = normalizePath(candidate)
    if (!program || seen.has(program) || !isDebuggableFile(program)) continue
    if (typeof contents[program] !== 'string') continue
    seen.add(program)
    configurations.push(makeConfig({
      name: `Launch ${program}`,
      program,
      source: 'auto',
    }))
  }

  const active = normalizePath(activeFile)
  if (active && isDebuggableFile(active) && typeof contents[active] === 'string' && !seen.has(active)) {
    configurations.unshift(makeConfig({
      name: `Debug ${active}`,
      program: active,
      source: 'active-file',
    }))
  }
  return configurations.filter(Boolean)
}

export function buildDebugConfigurations(contents = {}, { activeFile = '' } = {}) {
  const fromLaunch = launchConfigurations(contents, activeFile)
  const auto = autoConfigurations(contents, activeFile)
  const seen = new Set()
  return [...fromLaunch, ...auto].filter((config) => {
    const key = `${config.name}:${config.program}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function defaultLaunchJson() {
  return JSON.stringify({
    version: '0.2.0',
    configurations: [
      {
        type: 'node',
        request: 'launch',
        name: 'Launch Program',
        program: '${workspaceFolder}/src/index.js',
        args: [],
        cwd: '${workspaceFolder}',
        env: {},
        runtimeArgs: [],
      },
    ],
  }, null, 2)
}

export function quoteCommandArg(value) {
  const text = String(value ?? '')
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, '\\$1')}"`
}

/** A normal (non-inspector) run command for the same launch configuration. */
export function debugRunCommand(config) {
  if (!config) return ''
  return [
    'node',
    ...stringArray(config.runtimeArgs),
    quoteCommandArg(config.program),
    ...stringArray(config.args).map(quoteCommandArg),
  ].join(' ')
}

export function fileUrlForPath(root, relativePath) {
  const normalizedRoot = normalizeRoot(root)
  const relative = normalizePath(relativePath)
  if (!relative) return ''
  const absolute = normalizedRoot ? `${normalizedRoot}/${relative}` : relative
  const normalized = absolute.startsWith('/') ? absolute : `/${absolute}`
  return `file://${encodeURI(normalized).replace(/#/g, '%23')}`
}

export function relativePathFromUrl(url, root) {
  if (!url) return ''
  let path = String(url)
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    } catch {
      path = path.replace(/^file:\/\//i, '')
    }
  }
  const normalized = normalizePath(path)
  const normalizedRoot = normalizeRoot(root).replace(/^\//, '')
  if (normalizedRoot && normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalized.slice(normalizedRoot.length + 1)
  }
  return normalized
}
