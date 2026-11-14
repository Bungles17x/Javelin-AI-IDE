import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const monacoSource = join(root, 'node_modules', 'monaco-editor', 'min', 'vs')
const monacoTarget = join(root, 'public', 'monaco', 'vs')
rmSync(monacoTarget, { recursive: true, force: true })
mkdirSync(join(root, 'public', 'monaco'), { recursive: true })
cpSync(monacoSource, monacoTarget, { recursive: true })
const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '4317', '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
})

const stopVite = () => vite.kill()
process.on('SIGINT', stopVite)
process.on('SIGTERM', stopVite)

let ready = false
for (let attempt = 0; attempt < 120; attempt += 1) {
  if (vite.exitCode !== null) throw new Error('Vite exited before the desktop app could start.')
  try {
    const response = await fetch('http://127.0.0.1:4317')
    if (response.ok) {
      ready = true
      break
    }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
if (!ready) {
  stopVite()
  throw new Error('Timed out waiting for the Vite desktop renderer.')
}

let electron
let restartRequested = false
let shuttingDown = false
let restartTimer

function startElectron() {
  console.log('Starting the Javelin desktop shell…')
  electron = spawn(electronBinary, [join(root, 'desktop', 'main.cjs')], {
    cwd: root,
    env: { ...process.env, JAVELIN_DEV_SERVER: '1' },
    stdio: 'inherit',
  })
  electron.on('error', (error) => {
    console.error(`Could not start Electron: ${error.message}`)
    shutdown()
    process.exitCode = 1
  })
  electron.on('exit', (code) => {
    if (shuttingDown) return
    if (restartRequested) {
      restartRequested = false
      startElectron()
      return
    }
    shutdown()
    process.exitCode = code ?? 0
  })
}

function requestElectronRestart() {
  if (shuttingDown || restartRequested) return
  restartRequested = true
  console.log('Desktop main-process files changed; restarting the Javelin desktop shell…')
  electron?.kill()
}

const desktopWatcher = watch(join(root, 'desktop'), (_event, fileName) => {
  if (!fileName || !['main.cjs', 'preload.cjs', 'textFileTypes.cjs'].includes(String(fileName))) return
  clearTimeout(restartTimer)
  restartTimer = setTimeout(requestElectronRestart, 250)
})

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(restartTimer)
  desktopWatcher.close()
  electron?.kill()
  stopVite()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

startElectron()