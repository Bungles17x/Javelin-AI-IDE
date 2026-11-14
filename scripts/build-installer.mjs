import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir, userInfo } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = join(root, 'vscode-extension')
const vsixPath = join(extensionDir, 'javelin-fixed.vsix')
const outputDir = join(root, 'installer-output')
const setupPath = join(outputDir, 'Javelin-AI-IDE-Setup.exe')
const tempDir = join(tmpdir(), 'JavelinAIInstaller')
const stagingDir = join(tempDir, 'staging')
const tempSetupPath = join(tempDir, 'Javelin-AI-IDE-Setup.exe')
const sedPath = join(tempDir, 'Javelin-AI-IDE-Setup.sed')
const username = (process.env.USERNAME || process.env.USER || userInfo().username || '').toLowerCase()

if (process.platform !== 'win32') {
  console.error('The Windows setup executable can only be built on Windows.')
  process.exit(1)
}
if (process.env.JAVELIN_ALLOW_ALL !== 'true' && !['lildc', 'bungles17x'].includes(username)) {
  console.error(`Build denied for Windows account "${username}". This private extension is restricted to lildc.`)
  process.exit(1)
}

const iexpress = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'iexpress.exe')
if (!existsSync(iexpress)) {
  console.error('Windows IExpress was not found; cannot create the setup executable.')
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

console.log('1. Compiling the VS Code extension...')
run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm --prefix vscode-extension run compile'])

console.log('\n2. Building the VSIX package...')
run(process.execPath, ['build-vsix.mjs'])
if (!existsSync(vsixPath)) {
  console.error('The VSIX package was not created.')
  process.exit(1)
}

console.log('\n3. Packaging the Windows setup executable...')
mkdirSync(outputDir, { recursive: true })
rmSync(tempDir, { recursive: true, force: true })
mkdirSync(tempDir, { recursive: true })
mkdirSync(stagingDir, { recursive: true })
copyFileSync(vsixPath, join(stagingDir, 'javelin-fixed.vsix'))
copyFileSync(join(root, 'scripts', 'install-javelin-ide.ps1'), join(stagingDir, 'install-javelin-ide.ps1'))

const sed = `[Version]\r\nClass=IEXPRESS\r\nSEDVersion=3\r\n[Options]\r\nPackagePurpose=InstallApp\r\nShowInstallProgramWindow=1\r\nHideExtractAnimation=1\r\nUseLongFileName=1\r\nInsideCompressed=1\r\nCAB_FixedSize=0\r\nCAB_ResvCodeSigning=0\r\nRebootMode=N\r\nInstallPrompt=%InstallPrompt%\r\nDisplayLicense=%DisplayLicense%\r\nFinishMessage=%FinishMessage%\r\nTargetName=%TargetName%\r\nFriendlyName=%FriendlyName%\r\nAppLaunched=%AppLaunched%\r\nPostInstallCmd=%PostInstallCmd%\r\nAdminQuietInstCmd=%AdminQuietInstCmd%\r\nUserQuietInstCmd=%UserQuietInstCmd%\r\nSourceFiles=SourceFiles\r\n[SourceFiles]\r\nSourceFiles0=%SourceFiles0%\r\n[SourceFiles0]\r\n%FILE0%=\r\n%FILE1%=\r\n[Strings]\r\nInstallPrompt=\r\nDisplayLicense=\r\nFinishMessage=\r\nTargetName=${tempSetupPath}\r\nFriendlyName=Javelin AI IDE Setup\r\nAppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install-javelin-ide.ps1\r\nPostInstallCmd=<None>\r\nAdminQuietInstCmd=\r\nUserQuietInstCmd=\r\nSourceFiles0=${stagingDir}\r\nFILE0=install-javelin-ide.ps1\r\nFILE1=javelin-fixed.vsix\r\n`
writeFileSync(sedPath, sed, 'utf8')
run(iexpress, ['/N', sedPath])

if (!existsSync(tempSetupPath)) {
  console.error(`IExpress completed without creating ${tempSetupPath}`)
  process.exit(1)
}

copyFileSync(tempSetupPath, setupPath)
const sizeMb = (readFileSync(setupPath).length / (1024 * 1024)).toFixed(1)
console.log(`\nCreated ${setupPath} (${sizeMb} MB)`)