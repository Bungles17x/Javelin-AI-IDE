import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareStableVersions } from '../vscode-extension/out/core/updateVersion.js'

const root = process.cwd()
let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}`)
  }
}

console.log('\n1. Stable release versions are compared correctly')
check('newer patch is detected', compareStableVersions('v1.2.1', '1.2.0') === 1)
check('older minor is detected', compareStableVersions('1.1.9', '1.2.0') === -1)
check('equal versions are equal', compareStableVersions('1.2.0', 'v1.2.0') === 0)
check('unstable tags are rejected', compareStableVersions('v1.3.0-beta.1', '1.2.0') === null)

console.log('\n2. The updater is exposed and release workflow matches the extension version')
const manifest = JSON.parse(readFileSync(join(root, 'vscode-extension', 'package.json'), 'utf8'))
const workflow = readFileSync(join(root, '.github', 'workflows', 'release-extension.yml'), 'utf8')
const commandIds = manifest.contributes.commands.map((command) => command.command)
check('manual update check is contributed', commandIds.includes('javelin.checkForUpdates'))
check('private token setup is contributed', commandIds.includes('javelin.setUpdateToken'))
check('extension activates after VS Code startup', manifest.activationEvents.includes('onStartupFinished'))
check('release workflow builds and uploads the VSIX',
  workflow.includes('npm run compile --prefix vscode-extension') &&
  workflow.includes('gh release create "$GITHUB_REF_NAME" vscode-extension/javelin-fixed.vsix'))
check('extension starts at the first auto-update version', manifest.version === '1.2.1')

console.log(`\n${failures === 0 ? 'ALL EXTENSION UPDATE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)