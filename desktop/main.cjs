const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const fs = require('node:fs/promises')
const { existsSync } = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { supportsTextFile } = require('./textFileTypes.cjs')

const SKIP_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'release', '.venv', 'venv',
  'coverage', '.next', '.turbo', 'training/runs', 'traces',
])
const MAX_FILE_BYTES = 5_000_000
const MAX_WORKSPACE_BYTES = 50_000_000
const MAX_WORKSPACE_FILES = 4000
let workspaceRoot = null
const runningCommands = new Map()
const debugSessions = new Map()
let rendererServer = null
let updateTimer = null
let updateDialogOpen = false
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000

async function logUpdate(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  console.log(line.trim())
  try {
    await fs.appendFile(path.join(app.getPath('userData'), 'update.log'), line, 'utf8')
  } catch {
    // Diagnostics must never interfere with the app or the update.
  }
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // ONNX Runtime imports its WebAssembly glue as an .mjs module; served as
  // octet-stream the browser refuses to execute it.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

async function getLocalRuntimeStatus() {
  const ollama = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) })
    .then(async (response) => {
      if (!response.ok) return { ok: false, models: [] }
      const body = await response.json()
      return { ok: true, models: (body.models ?? []).map((model) => model.name) }
    })
    .catch(() => ({ ok: false, models: [] }))
  return { ollama }
}

function findOllama() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'),
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  if (process.platform !== 'win32') return 'ollama'
  const lookup = spawnSync('where.exe', ['ollama'], { encoding: 'utf8', windowsHide: true })
  return lookup.status === 0 ? lookup.stdout.split(/\r?\n/)[0].trim() : null
}

async function startOllama() {
  let status = await getLocalRuntimeStatus()
  if (status.ollama.ok) return status.ollama
  const executable = findOllama()
  if (!executable) throw new Error('Ollama is not installed. Install Ollama, then try again.')
  const process = spawn(executable, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
  process.unref()
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    status = await getLocalRuntimeStatus()
    if (status.ollama.ok) return status.ollama
  }
  throw new Error('Ollama did not start. Check whether another process is using port 11434.')
}

async function startRendererServer() {
  const root = path.resolve(__dirname, '..', 'dist')
  const contentSecurityPolicy = [
    "default-src 'self'",
    // ONNX Runtime compiles its WebAssembly glue by importing a module from a blob:
    // URL, and 'wasm-unsafe-eval' is required to instantiate the binary itself.
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src 'self' http: https: ws: wss:",
  ].join('; ')
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const target = path.resolve(root, relativePath)
      const relative = path.relative(root, target)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        response.writeHead(404).end('Not found')
        return
      }
      const content = await fs.readFile(target)
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': contentSecurityPolicy,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      response.end(content)
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found')
    }
  })
  const listen = (port) => new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.removeListener('listening', handleListening)
      reject(error)
    }
    const handleListening = () => {
      server.removeListener('error', handleError)
      resolve()
    }
    server.once('error', handleError)
    server.once('listening', handleListening)
    server.listen(port, '127.0.0.1')
  })
  try {
    await listen(4318)
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    await listen(0)
  }
  rendererServer = server
  return `http://127.0.0.1:${server.address().port}/`
}

function resolveWorkspacePath(relativePath) {
  if (!workspaceRoot || typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Open a project folder first.')
  }
  const resolvedRoot = path.resolve(workspaceRoot)
  const target = path.resolve(resolvedRoot, relativePath)
  const relative = path.relative(resolvedRoot, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The requested path is outside the open project.')
  }
  return target
}

async function assertInsideWorkspace(target, allowMissing = false) {
  const realRoot = await fs.realpath(workspaceRoot)
  let realTarget
  try {
    realTarget = await fs.realpath(target)
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error
    const parent = await fs.realpath(path.dirname(target))
    realTarget = path.join(parent, path.basename(target))
  }
  const relative = path.relative(realRoot, realTarget)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The requested path resolves outside the open project.')
  }
}

async function ensureWorkspaceParent(target) {
  const root = await fs.realpath(workspaceRoot)
  const missing = []
  let directory = path.dirname(target)
  while (directory !== root) {
    try {
      await assertInsideWorkspace(directory)
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('Parent path is not a directory.')
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      missing.push(directory)
      const parent = path.dirname(directory)
      if (parent === directory) throw new Error('Unable to create a project directory.')
      directory = parent
    }
  }
  for (const missingDirectory of missing.reverse()) {
    await fs.mkdir(missingDirectory)
    await assertInsideWorkspace(missingDirectory)
  }
}

async function scanWorkspace(root) {
  const files = []
  const directories = []
  const contents = {}
  let totalBytes = 0
  const walk = async (directory, depth = 0) => {
    if (depth > 12 || files.length >= MAX_WORKSPACE_FILES) return
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= MAX_WORKSPACE_FILES) break
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.cache')) {
          directories.push(relative)
          await walk(absolute, depth + 1)
        }
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(absolute)
      files.push({ path: relative, type: 'file', size: stat.size })
      if (!supportsTextFile(entry.name) || stat.size > MAX_FILE_BYTES) continue
      if (totalBytes + stat.size > MAX_WORKSPACE_BYTES) continue
      const content = await fs.readFile(absolute, 'utf8')
      if (content.includes('\u0000')) continue
      contents[relative] = content
      totalBytes += stat.size
    }
  }

  await walk(root)
  directories.sort((a, b) => a.localeCompare(b))
  return { root, name: path.basename(root), files, directories, contents }
}

ipcMain.handle('workspace:open', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  workspaceRoot = await fs.realpath(result.filePaths[0])
  return scanWorkspace(workspaceRoot)
})

ipcMain.handle('workspace:create', async (_event, name) => {
  if (typeof name !== 'string') throw new Error('Workspace name must be text.')
  const folderName = name.trim()
  if (
    !folderName ||
    folderName === '.' ||
    folderName === '..' ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(folderName) ||
    /[. ]$/.test(folderName)
  ) {
    throw new Error('Enter a valid folder name without path separators or reserved characters.')
  }

  const result = await dialog.showOpenDialog({
    title: 'Choose where to create the new workspace',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null

  const parent = await fs.realpath(result.filePaths[0])
  const target = path.join(parent, folderName)
  await fs.mkdir(target)
  workspaceRoot = await fs.realpath(target)
  return scanWorkspace(workspaceRoot)
})

ipcMain.handle('workspace:read', async (_event, relativePath) => {
  const target = resolveWorkspacePath(relativePath)
  await assertInsideWorkspace(target)
  const stat = await fs.stat(target)
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES || !supportsTextFile(target)) {
    throw new Error('This file is not a supported text file or exceeds the 2 MB editor limit.')
  }
  const content = await fs.readFile(target, 'utf8')
  if (content.includes('\u0000')) throw new Error('This file contains binary data and cannot be opened in the text editor.')
  return content
})

ipcMain.handle('workspace:write', async (_event, relativePath, content) => {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('File content exceeds the 2 MB editor limit.')
  }
  const target = resolveWorkspacePath(relativePath)
  await ensureWorkspaceParent(target)
  await assertInsideWorkspace(target, true)
  await fs.writeFile(target, content, 'utf8')
  return { path: relativePath, size: Buffer.byteLength(content, 'utf8') }
})

ipcMain.handle('workspace:create-folder', async (_event, relativePath) => {
  const target = resolveWorkspacePath(relativePath)
  await ensureWorkspaceParent(target)
  try {
    await fs.mkdir(target)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = await fs.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A non-directory entry already exists at this path.')
  }
  await assertInsideWorkspace(target)
  return { path: path.relative(workspaceRoot, target).split(path.sep).join('/'), created: true }
})

ipcMain.handle('workspace:delete-folder', async (_event, relativePath) => {
  const target = resolveWorkspacePath(relativePath)
  await assertInsideWorkspace(target)
  const stat = await fs.lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Only regular project directories can be removed.')
  await fs.rmdir(target)
  return { path: relativePath }
})

ipcMain.handle('workspace:delete', async (_event, relativePath) => {
  const target = resolveWorkspacePath(relativePath)
  await assertInsideWorkspace(target)
  const stat = await fs.lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular project files can be deleted.')
  await fs.unlink(target)
  return { path: relativePath }
})

ipcMain.handle('workspace:rename', async (_event, oldPath, newPath) => {
  const source = resolveWorkspacePath(oldPath)
  const target = resolveWorkspacePath(newPath)
  await assertInsideWorkspace(source)
  const sourceStat = await fs.lstat(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('Only regular project files can be renamed.')

  const parent = path.dirname(target)
  await assertInsideWorkspace(parent)
  const parentStat = await fs.lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('The destination folder must be a regular project directory.')
  await assertInsideWorkspace(target, true)
  try {
    await fs.lstat(target)
    throw new Error('A project entry already exists at the destination path.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await fs.rename(source, target)
  return { oldPath, newPath }
})

ipcMain.handle('workspace:run-command', async (event, id, command) => {
  if (!workspaceRoot) throw new Error('Open a project folder before running commands.')
  if (typeof id !== 'string' || typeof command !== 'string' || !command.trim() || command.length > 4000) {
    throw new Error('Command is empty or exceeds the 4,000 character limit.')
  }
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: workspaceRoot, shell: true, windowsHide: true })
    const timeout = setTimeout(() => child.kill(), 120_000)
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-200_000)
    runningCommands.set(id, child)
    const forwardOutput = (stream, chunk) => {
      const text = chunk.toString('utf8')
      if (!event.sender.isDestroyed()) {
        event.sender.send('workspace:command-output', id, stream, text)
      }
      if (stream === 'stdout') stdout = append(stdout, chunk)
      else stderr = append(stderr, chunk)
    }
    child.stdout.on('data', (chunk) => forwardOutput('stdout', chunk))
    child.stderr.on('data', (chunk) => forwardOutput('stderr', chunk))
    child.on('error', (error) => {
      clearTimeout(timeout)
      runningCommands.delete(id)
      resolve({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      runningCommands.delete(id)
      resolve({ exitCode: exitCode ?? 1, stdout, stderr })
    })
  })
})

function freeDebugPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function resolveDebugPath(relativePath, { directory = false } = {}) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('The debug configuration is missing a program path.')
  }
  const target = resolveWorkspacePath(relativePath)
  await assertInsideWorkspace(target)
  const stat = await fs.stat(target)
  if (directory && !stat.isDirectory()) throw new Error(`Debug working directory is not a folder: ${relativePath}`)
  if (!directory && !stat.isFile()) throw new Error(`Debug program is not a file: ${relativePath}`)
  return target
}

/**
 * Launch a Node program under the built-in inspector.
 *
 * ELECTRON_RUN_AS_NODE lets the packaged app use its bundled Node runtime, so a
 * user does not need a separate Node executable on PATH. The inspector binds to
 * loopback only and the renderer connects to the WebSocket URL printed by Node.
 */
ipcMain.handle('debug:start', async (event, config) => {
  if (!workspaceRoot) throw new Error('Open a project folder before debugging.')
  if (!config || typeof config !== 'object') throw new Error('Invalid debug configuration.')
  const program = await resolveDebugPath(config.program)
  const cwd = config.cwd ? await resolveDebugPath(config.cwd, { directory: true }) : workspaceRoot
  if (!['.js', '.mjs', '.cjs'].includes(path.extname(program).toLowerCase())) {
    throw new Error('The Javelin debugger currently launches JavaScript Node programs (.js, .mjs, .cjs).')
  }
  const args = Array.isArray(config.args) ? config.args.filter((value) => typeof value === 'string') : []
  const runtimeArgs = Array.isArray(config.runtimeArgs)
    ? config.runtimeArgs.filter((value) => typeof value === 'string' && !/^--inspect(?:-brk)?(?:=|$)/.test(value))
    : []
  const env = {
    ...process.env,
    ...(config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? Object.fromEntries(Object.entries(config.env).filter(([, value]) => typeof value === 'string'))
      : {}),
    ELECTRON_RUN_AS_NODE: '1',
  }
  const port = await freeDebugPort()
  if (!port) throw new Error('Could not reserve a local debug port.')
  const id = `debug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const child = spawn(
    process.execPath,
    [`--inspect-brk=127.0.0.1:${port}`, '--enable-source-maps', ...runtimeArgs, program, ...args],
    { cwd, env, windowsHide: true },
  )
  const session = { id, child, event, port, ready: false, exited: false }
  debugSessions.set(id, session)

  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const readyTimer = setTimeout(() => {
    rejectReady(new Error('The Node inspector did not start within 8 seconds.'))
  }, 8000)

  const send = (channel, ...payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, ...payload)
  }
  const forward = (stream, chunk) => {
    const text = chunk.toString('utf8')
    send('debug:output', id, stream, text)
    if (!session.ready) {
      const match = text.match(/Debugger listening on (ws:\/\/[^\s]+)/i)
      if (match) {
        session.ready = true
        resolveReady(match[1])
        send('debug:ready', id, match[1])
      }
    }
  }
  child.stdout.on('data', (chunk) => forward('stdout', chunk))
  child.stderr.on('data', (chunk) => forward('stderr', chunk))
  child.on('error', (error) => {
    forward('stderr', Buffer.from(`${error.message}\n`))
    if (!session.ready) rejectReady(error)
    if (!session.exited) {
      session.exited = true
      send('debug:exit', id, 1)
      debugSessions.delete(id)
    }
  })
  child.on('close', (code) => {
    if (session.exited) return
    session.exited = true
    if (!session.ready) rejectReady(new Error(`The debug process exited before the inspector was ready (exit ${code ?? 1}).`))
    send('debug:exit', id, code ?? 1)
    debugSessions.delete(id)
  })
  try {
    const wsUrl = await ready
    clearTimeout(readyTimer)
    return { id, port, wsUrl }
  } catch (error) {
    clearTimeout(readyTimer)
    session.exited = true
    debugSessions.delete(id)
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
    throw error
  }
})

ipcMain.handle('debug:stop', async (_event, id) => {
  const session = debugSessions.get(id)
  if (!session) return { stopped: false }
  session.exited = true
  debugSessions.delete(id)
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(session.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    session.child.kill('SIGTERM')
  }
  return { stopped: true }
})

ipcMain.on('workspace:cancel-command', (_event, id) => {
  runningCommands.get(id)?.kill()
})

ipcMain.handle('runtime:status', getLocalRuntimeStatus)
ipcMain.handle('runtime:start-ollama', startOllama)

ipcMain.handle('network:reset', async () => {
  const { session } = require('electron')
  await session.defaultSession.closeAllConnections?.()
  await session.defaultSession.clearHostResolverCache?.()
  await session.defaultSession.clearCache()
  return { ok: true }
})

function createWindow(rendererUrl) {
  const window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1120,
    minHeight: 700,
    title: 'Javelin AI IDE',
    backgroundColor: '#111412',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.loadURL(process.env.JAVELIN_DEV_SERVER === '1' ? 'http://127.0.0.1:4317' : rendererUrl)
}

/**
 * Keep installed copies current without another setup download. The release
 * workflow publishes every push to main as a GitHub release; electron-updater
 * checks the newest release on launch and while the app stays open.
 */
function setupAutoUpdates() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  // A per-user NSIS package would otherwise default to %LOCALAPPDATA% and
  // create a second install. Pin the update to the directory this copy runs
  // from, whether that is Program Files or a per-user location.
  autoUpdater.installDirectory = path.dirname(process.execPath)

  autoUpdater.on('checking-for-update', () => {
    void logUpdate('Checking for updates.')
  })
  autoUpdater.on('update-available', (info) => {
    void logUpdate(`Update ${info.version} available; downloading.`)
  })
  autoUpdater.on('update-not-available', (info) => {
    void logUpdate(`Already current at ${info.version}.`)
  })
  autoUpdater.on('error', (error) => {
    void logUpdate(`Update check failed: ${String(error?.message ?? error)}`)
  })
  autoUpdater.on('update-downloaded', async (info) => {
    await logUpdate(`Update ${info.version} downloaded and ready to install.`)
    if (updateDialogOpen) return
    updateDialogOpen = true
    try {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Javelin update ready',
        message: `Javelin AI IDE ${info.version} is ready.`,
        detail: 'Restart once to apply the update. Your chats and projects stay on this computer.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (result.response === 0) {
        // Silent install keeps the update to one click; NSIS relaunches the app.
        setTimeout(() => autoUpdater.quitAndInstall(true, true), 100)
      }
    } catch (error) {
      await logUpdate(`Could not show the update prompt: ${String(error?.message ?? error)}`)
    } finally {
      updateDialogOpen = false
    }
  })

  const check = () => {
    // The updater emits its own error event, which is logged above.
    autoUpdater.checkForUpdates().catch(() => {})
  }
  setTimeout(check, 5000)
  updateTimer = setInterval(check, UPDATE_CHECK_INTERVAL_MS)
}

app.setName('Javelin AI IDE')

// On some Windows setups Electron's media capture stalls forever instead of rejecting:
// the request is neither granted nor denied. A hard timeout turns that silence into a
// message the user can act on. Set JAVELIN_FAKE_MIC=1 to diagnose permission plumbing.
if (process.env.JAVELIN_FAKE_MIC === '1') {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}

app.whenReady().then(async () => {
  // The microphone is used by the app's own speech recognition. Electron denies
  // media permission by default when a handler is installed, so grant it explicitly
  // and leave every other permission at the previous (granting) behaviour.
  const { session } = require('electron')
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(true)
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'media' ? true : true)

  const rendererUrl = process.env.JAVELIN_DEV_SERVER === '1' ? null : await startRendererServer()
  createWindow(rendererUrl)
  setupAutoUpdates()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (updateTimer) clearInterval(updateTimer)
  updateTimer = null
  for (const session of debugSessions.values()) {
    try { session.child.kill() } catch { /* already gone */ }
  }
  debugSessions.clear()
  rendererServer?.close()
})