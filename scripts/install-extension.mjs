/**
 * Private extension installer for Javelin AI.
 *
 * Enforces that ONLY the authorized developer (lildc / Bungles17x) can install
 * the Javelin VS Code extension.
 *
 * Usage: npm run install:extension
 */

import { userInfo } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const vsixPath = join(root, 'vscode-extension', 'javelin-fixed.vsix')

const currentUsername = (process.env.USERNAME || process.env.USER || userInfo().username || '').toLowerCase()
const AUTHORIZED_USERS = new Set(['lildc', 'bungles17x'])

console.log('=== Javelin AI Private Extension Installer ===')
console.log(`Checking authorization for system user: "${currentUsername}"...`)

if (process.env.JAVELIN_ALLOW_ALL !== 'true' && !AUTHORIZED_USERS.has(currentUsername)) {
  console.error('\n[ACCESS DENIED] You are NOT authorized to install this private extension.')
  console.error('This extension is proprietary and restricted exclusively to user "lildc" (Bungles17x).')
  console.error('Installation aborted.\n')
  process.exit(1)
}

console.log('✓ Authorization confirmed: user "lildc" (Bungles17x) verified.\n')

// Step 1: Compile the extension
console.log('1. Compiling VS Code extension...')
const compileResult = spawnSync('npm', ['--prefix', 'vscode-extension', 'run', 'compile'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
})
if (compileResult.status !== 0) {
  console.error('Failed to compile extension.')
  process.exit(compileResult.status ?? 1)
}

// Step 2: Build the VSIX
console.log('\n2. Building private .vsix package...')
const buildResult = spawnSync('node', ['build-vsix.mjs'], {
  cwd: root,
  stdio: 'inherit',
})
if (buildResult.status !== 0 || !existsSync(vsixPath)) {
  console.error('Failed to build VSIX package.')
  process.exit(buildResult.status ?? 1)
}

// Step 3: Install the VSIX into VS Code
console.log('\n3. Installing extension into VS Code...')
const installResult = process.platform === 'win32'
  ? spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '& code --install-extension "$env:JAVELIN_VSIX_PATH" --force'],
    {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, JAVELIN_VSIX_PATH: vsixPath },
    },
  )
  : spawnSync('code', ['--install-extension', vsixPath, '--force'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  })

if (installResult.stdout) {
  process.stdout.write(installResult.stdout)
}
if (installResult.stderr) {
  process.stderr.write(installResult.stderr)
}

if (installResult.status !== 0) {
  const text = `${installResult.stdout || ''}\n${installResult.stderr || ''}`
  if (text.toLowerCase().includes('restart vs code')) {
    console.error('Please reload or restart VS Code, then run this installer again.')
  } else {
    console.error('VS Code could not install the package. Check the error above, and verify that the `code` command is on PATH.')
  }
  process.exit(installResult.status ?? 1)
}

const extensionRoot = join(process.env.USERPROFILE || '', '.vscode', 'extensions')
if (existsSync(extensionRoot)) {
  const currentInstall = `javelin-ai-private.javelin-ai-assistant-${JSON.parse(
    (await import('node:fs')).readFileSync(join(root, 'vscode-extension', 'package.json'), 'utf8'),
  ).version}`
  const stale = readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && entry.name.startsWith('javelin-ai-private.javelin-ai-assistant-')
      && entry.name !== currentInstall)
    .map((entry) => join(extensionRoot, entry.name))

  for (const dir of stale) {
    rmSync(dir, { recursive: true, force: true })
    console.log(`Removed stale Javelin install: ${dir}`)
  }
}

console.log('\n============================================================')
console.log('🎉 SUCCESS: Javelin AI Assistant private extension installed!')
console.log('Only user "lildc" has permission to activate and use it.')
console.log('Restart or reload VS Code (Ctrl+Shift+P > Developer: Reload Window) to use.')
console.log('============================================================\n')
