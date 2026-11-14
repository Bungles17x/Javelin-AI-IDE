import textFileTypes from '../desktop/textFileTypes.cjs'
import { isSmallTalk } from '../src/core/taskIntent.js'
import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'

const { supportsTextFile } = textFileTypes
let failures = 0

function check(name, result) {
  if (result) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.error(`  FAIL  ${name}`)
  }
}

check('Roblox Lua scripts are readable', supportsTextFile('ServerScriptService/Main.server.lua'))
check('Roblox Luau scripts are readable', supportsTextFile('StarterPlayer/Main.client.luau'))
check('Roblox text place files are readable', supportsTextFile('Michigan State Roleplay.rbxlx'))
check('unknown extensionless text files remain readable', supportsTextFile('.gitignore'))
check('web source files remain readable', supportsTextFile('src/App.jsx'))
check('binary image assets stay out of the agent snapshot', !supportsTextFile('assets/icon.png'))
check('binary Roblox place files stay out of the text editor', !supportsTextFile('Michigan State Roleplay.rbxl'))
check('greetings bypass project-task inspection', isSmallTalk('hi'))
check('social check-ins use the chat path', isSmallTalk('How are you?'))
check('a greeting with a coding task still uses Javelin', !isSmallTalk('Hi, fix the Lua script'))

const workspace = new VirtualWorkspace({ 'src/main.lua': 'print("hello")\n' })
const baseline = workspace.snapshot('before folder')
workspace.createDirectory('src/empty/nested')
check('empty directories appear in project listings', workspace.list('src/empty').some((entry) => entry.path === 'src/empty/nested' && entry.type === 'dir'))
check('empty directories appear in the project tree', workspace.tree().includes('empty/'))
const restored = workspace.restore(baseline.id)
check('checkpoint restoration removes newly created directories', restored.includes('src/empty/nested') && !workspace.isDirectory('src/empty/nested'))
check('folder creation rejects parent traversal', (() => {
  try { workspace.createDirectory('../outside'); return false } catch { return true }
})())
const emptyWorkspace = new VirtualWorkspace()
emptyWorkspace.createDirectory('new-project/src/chess')
check('nested folders can start at the workspace root with no main folder', emptyWorkspace.isDirectory('new-project/src/chess'))
emptyWorkspace.write('new-project/src/chess/Game.js', 'export {}')
check('files can be created inside newly-created nested folders', emptyWorkspace.exists('new-project/src/chess/Game.js'))
check('a file cannot be used as a parent folder', (() => {
  try { emptyWorkspace.createDirectory('new-project/src/chess/Game.js/assets'); return false } catch { return true }
})())
check('a folder cannot be overwritten by a file', (() => {
  try { emptyWorkspace.write('new-project/src/chess', 'file'); return false } catch { return true }
})())

if (failures) process.exit(1)
console.log('ALL DESKTOP TEXT FILE CHECKS PASSED')