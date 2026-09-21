/**
 * Headless test of Javelin's file capabilities and their permission rules.
 *
 * The user asked for an agent that can SEE files, ADD files, EDIT files, and DELETE
 * files *with permission* — the same surface a tool like Devin has. This proves each
 * capability exists and that the destructive one (delete) cannot happen without an
 * explicit yes:
 *
 *  1. SEE   — list_files / read_file / search_code are read-only, never gated.
 *  2. ADD   — write_file creates a new file, requires approval.
 *  3. EDIT  — edit_file changes an existing file, requires approval.
 *  4. DELETE— delete_file is destructive: it needs approval, is refused when denied,
 *             and a checkpoint taken beforehand can bring the file back.
 *  5. POLICY— an ordinary destructive tool is still refused outright; only an
 *             explicitly `approvable` one (delete_file) is allowed behind a prompt.
 *
 * Run: npm test
 */

import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'
import { createStandardToolset, RISK } from '../src/core/tools.js'
import { renderAgentContract } from '../src/core/identity.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const WORKSPACE = {
  'src/app.js': 'const a = 1\nconst b = 2\n',
  'src/old.js': 'obsolete code\n',
  'README.md': '# hi\n',
}

console.log('\n1. SEE: read-only tools exist and are never gated')
{
  const tools = createStandardToolset()
  for (const name of ['list_files', 'read_file', 'search_code']) {
    check(`${name} is registered`, Boolean(tools.get(name)))
    check(`${name} is read-risk`, tools.get(name).risk === RISK.READ)
    check(`${name} needs no approval`, tools.requiresApproval(name, {}) === false)
  }
  check('read tools are not forbidden', !tools.isForbidden('list_files', {}))
}

console.log('\n2. ADD and EDIT: writes exist and need approval')
{
  const tools = createStandardToolset()
  for (const name of ['write_file', 'edit_file']) {
    check(`${name} is registered`, Boolean(tools.get(name)))
    check(`${name} is write-risk`, tools.get(name).risk === RISK.WRITE)
    check(`${name} requires approval`, tools.requiresApproval(name, {}) === true)
  }
}

console.log('\n3. DELETE: the tool exists and is destructive-but-approvable')
{
  const tools = createStandardToolset()
  const del = tools.get('delete_file')
  check('delete_file is registered', Boolean(del))
  check('delete_file is destructive', del?.risk === RISK.DESTRUCTIVE)
  check('delete_file requires approval', tools.requiresApproval('delete_file', {}) === true)
  // The whole point: destructive, yet NOT refused outright — it runs if the user says yes.
  check('delete_file is approvable, not forbidden', tools.isForbidden('delete_file', {}) === false)
}

console.log('\n4. DELETE: workspace removes the file, returns a diff, and a checkpoint restores it')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  const cp = ws.snapshot('before delete')

  const outcome = ws.delete('src/old.js')
  check('delete returns the removed path', outcome.path === 'src/old.js')
  check('delete returns the prior content', outcome.before === 'obsolete code\n')
  check('delete reports a diff of removed lines', outcome.diff.removed === 1)
  check('the file is actually gone', !ws.exists('src/old.js'))

  const changed = ws.restore(cp.id)
  check('checkpoint restore brings the deleted file back', ws.exists('src/old.js'))
  check('restore reports the re-added path', changed.includes('src/old.js'))
  check('restore preserved the content', ws.read('src/old.js') === 'obsolete code\n')

  let threw = false
  try {
    ws.delete('src/old.js') // after restore it exists; deleting a missing file should throw
    ws.delete('does/not/exist.js')
  } catch (err) {
    threw = /File not found/.test(err.message)
  }
  check('deleting a missing file is refused', threw)
}

console.log('\n5. DELETE: preview shows what would be lost before consenting')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  const preview = ws.preview('delete_file', { path: 'src/old.js' })
  check('delete preview returns a diff', Boolean(preview.diff))
  check('delete preview marks it as a deletion', preview.deletes === true)
  check('delete preview removes every line', preview.diff.removed === 1)
}

console.log('\n6. POLICY: a plain destructive tool is still refused; delete_file is not')
{
  const tools = createStandardToolset()
  tools.register({
    name: 'wipe_everything',
    description: 'a deliberately catastrophic tool with no approvable flag',
    parameters: { type: 'object', properties: {} },
    risk: RISK.DESTRUCTIVE,
    autoSafe: false,
    async execute() {
      return { ok: true, output: 'boom' }
    },
  })
  check('an unmarkable destructive tool is forbidden outright',
    tools.isForbidden('wipe_everything', {}) === true)
}

console.log('\n7. CONTRACT: the session contract names delete_file and warns about it')
{
  const names = createStandardToolset().active().map((t) => t.name)
  const contract = renderAgentContract(names, { canWriteFiles: true })
  check('contract lists delete_file', contract.includes('delete_file'))
  check('contract says deletion needs approval', /deletion|delet/i.test(contract) && /approval/i.test(contract))
}

/* ------------------------------------------------------------------ *
 * Autonomy: letting Javelin do the whole job without stopping to ask.
 *
 * The user asked Javelin to "do everything" instead of pausing on each write.
 * These prove the trust dial works: `ask` gates every change, `full` lets the run
 * complete unattended, and — crucially — a catastrophic command is STILL blocked
 * at every level. Autonomy is about edits and ordinary commands, not about letting
 * the agent format a disk.
 * ------------------------------------------------------------------ */

import { createJavelin, EngineRegistry } from '../src/core/index.js'
import { AUTONOMY } from '../src/core/tools.js'

/** A deterministic engine that replays a script of turns. */
function makeEngine(script) {
  let call = 0
  return {
    id: 'autonomy-engine',
    label: 'Autonomy engine',
    capabilities: ['tools', 'offline'],
    async probe() {
      return { ok: true }
    },
    async generate() {
      const step = script[Math.min(call, script.length - 1)]
      call++
      return {
        text: step.text ?? '',
        toolCalls: step.toolCalls ?? [],
        finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
        engineId: 'autonomy-engine',
      }
    },
  }
}

function makeJavelin(script) {
  const registry = new EngineRegistry()
  registry.register(makeEngine(script))
  registry.assign('primary', 'autonomy-engine')
  return createJavelin({ engines: registry })
}

const write = (id, path, content) => ({ id, name: 'write_file', args: { path, content } })
const del = (id, path) => ({ id, name: 'delete_file', args: { path } })
const cmd = (id, command) => ({ id, name: 'run_command', args: { command } })
const stop = (id, summary) => ({ id, name: 'finish', args: { summary, verified: false } })

console.log('\n8. AUTONOMY=ask: each change is gated (the default, unchanged behaviour)')
{
  let approvals = 0
  const ws = new VirtualWorkspace(WORKSPACE)
  const javelin = makeJavelin([
    { text: '', toolCalls: [write('a1', 'src/added.js', 'new\n')] },
    { text: '', toolCalls: [stop('a2', 'done')] },
  ])
  let sawDiff = false
  await javelin.think({
    task: 'add a file',
    workspace: ws,
    runCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    onEvent: () => {},
    requestApproval: async (req) => {
      approvals++
      // The gate must carry a preview so the decision is informed, not blind.
      sawDiff = sawDiff || Boolean(req.diff)
      return { approved: true }
    },
    autonomy: AUTONOMY.ASK,
  })
  check('a write triggers an approval prompt by default', approvals >= 1, String(approvals))
  check('the approval carried a preview diff', sawDiff)
}

console.log('\n9. AUTONOMY=full: writes and deletes run with NO prompt')
{
  let approvals = 0
  const ws = new VirtualWorkspace(WORKSPACE)
  const javelin = makeJavelin([
    { text: '', toolCalls: [write('b1', 'src/added.js', 'new\n')] },
    { text: '', toolCalls: [del('b2', 'src/old.js')] },
    { text: '', toolCalls: [stop('b3', 'done')] },
  ])
  const events = []
  await javelin.think({
    task: 'add then delete',
    workspace: ws,
    runCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    onEvent: (e) => events.push(e),
    requestApproval: async () => {
      approvals++
      return { approved: true }
    },
    autonomy: AUTONOMY.FULL,
  })
  check('no approval prompt fired under full autonomy', approvals === 0, String(approvals))
  check('the write still happened', ws.exists('src/added.js'))
  check('the delete still happened', !ws.exists('src/old.js'))
}

console.log('\n10. Autonomy never disables verification (an unverified finish is still refused)')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  const javelin = makeJavelin([
    { text: '', toolCalls: [write('c1', 'src/added.js', 'new\n')] },
    // Try to finish without verifying — the runtime must refuse and demand a command.
    { text: '', toolCalls: [stop('c2', 'done without verifying')] },
    { text: '', toolCalls: [cmd('c3', 'npm test')] },
    { text: '', toolCalls: [stop('c4', 'verified now', true)] },
  ])
  const events = []
  const result = await javelin.think({
    task: 'add a file and verify',
    workspace: ws,
    runCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    onEvent: (e) => events.push(e),
    requestApproval: async () => ({ approved: true }),
    autonomy: AUTONOMY.FULL,
  })
  check('an unverified finish was still refused under full autonomy',
    events.some((e) => e.type === 'verification_required'))
  check('the run completed after verifying', result.status === 'done', result.status)
}

console.log('\n11. AUTONOMY=full: a catastrophic command is STILL refused outright')
{
  let approvals = 0
  const ws = new VirtualWorkspace(WORKSPACE)
  const javelin = makeJavelin([
    { text: '', toolCalls: [cmd('d1', 'rm -rf /')] },
    { text: '', toolCalls: [stop('d2', 'could not proceed', false)] },
  ])
  const events = []
  await javelin.think({
    task: 'nuke everything',
    workspace: ws,
    runCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    onEvent: (e) => events.push(e),
    requestApproval: async () => {
      approvals++
      return { approved: true }
    },
    autonomy: AUTONOMY.FULL,
  })
  check('rm -rf / was refused even under full autonomy',
    events.some((e) => e.type === 'tool_refused'))
  check('and it never reached the approval path', approvals === 0, String(approvals))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
