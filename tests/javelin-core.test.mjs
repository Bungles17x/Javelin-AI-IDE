/**
 * Javelin Core — integration tests.
 *
 * Proves the *system* works, using a scripted engine so the tests are
 * deterministic and need no model installed. This is the evidence that Javelin's
 * reasoning lifecycle, memory, tool policy and self-correction are real.
 */

import {
  createJavelin,
  EngineRegistry,
  JavelinMemory,
  PHASE,
  buildProjectIndex,
} from '../src/core/index.js'
import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'
import { canonicalizeToolCall } from '../src/core/tools.js'

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
  'calc.js': 'export function add(a, b) {\n  return a - b\n}\n',
  'util.js': 'export function noop() {\n  return null\n}\n',
}

/** A deterministic engine that replays a script of turns. */
function makeEngine(script, onGenerate) {
  let call = 0
  return {
    id: 'test-engine',
    label: 'Test engine',
    capabilities: ['tools', 'offline'],
    async probe() {
      return { ok: true }
    },
    async generate(request) {
      onGenerate?.(request)
      const step = script[Math.min(call, script.length - 1)]
      call++
      return {
        text: step.text ?? '',
        toolCalls: step.toolCalls ?? [],
        finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
        engineId: 'test-engine',
      }
    },
  }
}

function makeJavelin(script, opts = {}) {
  const { onGenerate, ...javelinOptions } = opts
  const registry = new EngineRegistry()
  registry.register(makeEngine(script, onGenerate))
  registry.assign('primary', 'test-engine')
  return createJavelin({ engines: registry, ...javelinOptions })
}

/** Shorthand builders keep the test scripts readable. */
const read = (id, path) => ({ id, name: 'read_file', args: { path } })
const edit = (id, path, oldString, newString) => ({
  id,
  name: 'edit_file',
  args: { path, old_string: oldString, new_string: newString },
})
const run = (id, command) => ({ id, name: 'run_command', args: { command } })
const finish = (id, summary, verified) => ({ id, name: 'finish', args: { summary, verified } })
const remember = (id, fact) => ({ id, name: 'remember', args: { fact } })

const okCommand = async (_command, _signal, onOutput) => {
  onOutput?.({ stream: 'stdout', text: 'live command output' })
  return { exitCode: 0, stdout: 'ok', stderr: '' }
}
const alwaysApprove = async () => ({ approved: true })

console.log('\n1. Project indexing (memory grounding)')
{
  const index = buildProjectIndex(WORKSPACE)
  check('indexes all files', index.files.size === 2, String(index.files.size))
  check('detects the language', index.languages.get('javascript') === 2)
  check('extracts symbols', index.symbols.has('add'), [...index.symbols.keys()].join(','))
  check('exposes the phase constants', typeof PHASE.UNDERSTAND === 'string' && PHASE.REPAIR === 'repair')
}

console.log('\n2. Full lifecycle: understand → plan → act → verify → finish')
{
  const events = []
  const javelin = makeJavelin([
    { text: 'Looking at the project.', toolCalls: [read('c1', 'calc.js')] },
    { text: 'Plan:\n1. Fix the operator in calc.js\n2. Verify it runs', toolCalls: [] },
    { text: 'Applying the fix.', toolCalls: [edit('c2', 'calc.js', 'return a - b', 'return a + b')] },
    { text: 'Now verifying.', toolCalls: [run('c3', 'npm test')] },
    { text: 'Done.', toolCalls: [finish('c4', 'Fixed calc.js', true)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'Fix the bug in calc.js',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })

  check('run completed', result.status === 'done', result.status)
  check('the file was actually corrected', ws.read('calc.js').includes('return a + b'))
  check('plan was captured and surfaced', events.some((e) => e.type === 'plan'), 'no plan event')
  check('phase events were emitted', events.filter((e) => e.type === 'phase').length >= 4)
  check('verification was recognised', result.verified === true)
  check('summary names the touched file', result.summary.includes('calc.js'), result.summary)
  check('command output streams while verification is running',
    events.some((event) => event.type === 'command_output' && event.id === 'c3' && event.text === 'live command output'))
}

console.log('\n3. Self-correction: a failed action is never repeated')
{
  const events = []
  const javelin = makeJavelin([
    { text: 'Trying an edit.', toolCalls: [edit('c1', 'calc.js', 'NOT PRESENT', 'x')] },
    { text: 'Trying again.', toolCalls: [edit('c2', 'calc.js', 'NOT PRESENT', 'x')] },
    { text: 'Different approach.', toolCalls: [edit('c3', 'calc.js', 'return a - b', 'return a + b')] },
    { text: 'Verify.', toolCalls: [run('c4', 'npm test')] },
    { text: '', toolCalls: [finish('c5', 'Fixed', true)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  await javelin.think({
    task: 'Fix calc.js',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })

  const blocked = events.filter((e) => e.type === 'repeat_blocked')
  check('the repeated failed action was blocked', blocked.length === 1, `got ${blocked.length}`)
  check('the block reason explains why', Boolean(blocked[0]?.note.includes('already tried')))
  check('the working fix still applied', ws.read('calc.js').includes('return a + b'))
}

console.log('\n4. Verification is enforced (no false "done")')
{
  const events = []
  const javelin = makeJavelin([
    { text: 'Plan:\n1. Edit calc.js\n2. Ship it', toolCalls: [] },
    { text: '', toolCalls: [edit('c1', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [finish('c2', 'Done', true)] },
    { text: '', toolCalls: [run('c3', 'npm test')] },
    { text: '', toolCalls: [finish('c4', 'Fixed and verified', true)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'Fix calc.js',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })

  const demanded = events.filter((e) => e.type === 'verification_required')
  check('an unverified finish was refused', demanded.length >= 1, `got ${demanded.length}`)
  check('the run still completed after complying', result.status === 'done', result.status)
}

console.log('\n5. Safety: destructive commands are refused outright')
{
  const events = []
  const javelin = makeJavelin([
    { text: '', toolCalls: [run('c1', 'rm -rf /')] },
    { text: '', toolCalls: [finish('c2', 'could not proceed', false)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  await javelin.think({
    task: 'delete everything',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })

  const refused = events.filter((e) => e.type === 'tool_refused')
  check('rm -rf / was refused outright', refused.length === 1, `got ${refused.length}`)
}

console.log('\n6. A denied edit is not applied and not retried')
{
  const events = []
  const javelin = makeJavelin([
    { text: '', toolCalls: [edit('c1', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [edit('c2', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [finish('c3', 'user denied', false)] },
  ])

  let approvals = 0
  const ws = new VirtualWorkspace(WORKSPACE)
  await javelin.think({
    task: 'change calc',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: async () => {
      approvals++
      return { approved: false }
    },
  })

  check('approval was requested', approvals >= 1, String(approvals))
  check('the denied edit was not applied', ws.read('calc.js').includes('return a - b'))
  check('the denied retry was blocked as a repeat', events.some((e) => e.type === 'repeat_blocked'))
}

console.log('\n7. Memory persists and grounds later runs')
{
  const javelin = makeJavelin([
    { text: '', toolCalls: [remember('c1', 'Tests live in the tests/ directory')] },
    { text: '', toolCalls: [finish('c2', 'noted', false)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  await javelin.think({
    task: 'learn about the project',
    workspace: ws,
    onEvent: () => {},
    requestApproval: alwaysApprove,
  })

  const learnings = javelin.learnings()
  check(
    'the fact was stored in semantic memory',
    learnings.strong.some((f) => f.fact.includes('tests/')),
    JSON.stringify(learnings.strong),
  )

  const restored = JavelinMemory.restore(javelin.memory.snapshot())
  check('memory survives serialisation', restored.semantic.strong().length >= 1)
  check('memory block grounds a future task', Boolean(restored.contextFor('where are the tests')))
}

console.log('\n8. Stop / abort')
{
  const javelin = makeJavelin([{ text: 'thinking', toolCalls: [] }])
  const ws = new VirtualWorkspace(WORKSPACE)
  const controller = new AbortController()
  controller.abort()
  const result = await javelin.think({
    task: 'anything',
    workspace: ws,
    signal: controller.signal,
    onEvent: () => {},
    requestApproval: alwaysApprove,
  })
  check('an aborted run reports aborted', result.status === 'aborted', result.status)
}

console.log('\n9. Engine registry degrades gracefully')
{
  const registry = new EngineRegistry()
  registry.register({
    id: 'dead',
    label: 'Unreachable engine',
    capabilities: [],
    async probe() {
      return { ok: false, detail: 'connection refused' }
    },
    async generate() {
      throw new Error('should not be called')
    },
  })
  registry.register(makeEngine([{ text: '', toolCalls: [finish('c1', 'used the fallback', false)] }]))
  registry.assign('primary', 'dead')

  const javelin = createJavelin({ engines: registry })
  const diag = await javelin.diagnose()
  check('the dead engine is reported unhealthy', diag.health.dead.ok === false)

  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'do something',
    workspace: ws,
    onEvent: () => {},
    requestApproval: alwaysApprove,
  })
  check('Javelin falls back to a healthy engine', result.status === 'done', result.status)
}

console.log('\n9. A model that only narrates cannot fake completion')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  // The model describes what it WOULD do but never calls a tool and never finishes.
  const javelin = makeJavelin([
    { text: 'I will now update calc.js to fix the operator.', toolCalls: [] },
    { text: 'The fix has been applied to calc.js.', toolCalls: [] },
    { text: 'Done.', toolCalls: [] },
  ])
  const events = []
  const result = await javelin.think({
    task: 'fix calc.js',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })
  check('no file was actually changed', ws.read('calc.js').includes('return a - b'))
  check('the run did NOT report unqualified success without acting',
    result.steps.length === 0, `steps=${result.steps.length}`)
  check('the run stops after the no-action limit', result.status === 'failed', result.status)
  check('the stop reason identifies missing tool actions', result.summary.includes('without a tool action'))
}

console.log('\n10. Successful repeated reads are blocked')
{
  const events = []
  const javelin = makeJavelin([
    { text: '', toolCalls: [read('r1', 'calc.js')] },
    { text: '', toolCalls: [read('r2', 'calc.js')] },
    { text: '', toolCalls: [read('r3', 'calc.js')] },
    { text: '', toolCalls: [read('r4', 'calc.js')] },
  ])
  const result = await javelin.think({
    task: 'Understand the project',
    workspace: new VirtualWorkspace(WORKSPACE),
    onEvent: (event) => events.push(event),
    requestApproval: alwaysApprove,
  })
  check('same-state read loop stops as failed', result.status === 'failed', result.status)
  check('repeat guard emits visible events', events.filter((event) => event.type === 'repeat_blocked').length === 3)
  check('repeat failure is reported', result.summary.includes('repeated actions'))
}

console.log('\n11. Folder creation is approved and checkpointed')
{
  const events = []
  let approvals = 0
  const ws = new VirtualWorkspace(WORKSPACE)
  const javelin = makeJavelin([
    { text: '', toolCalls: [{ id: 'dir1', name: 'create_folder', args: { path: 'src/modules' } }] },
    { text: '', toolCalls: [finish('dir2', 'Created src/modules', false)] },
  ])
  const result = await javelin.think({
    task: 'Create src/modules',
    workspace: ws,
    onEvent: (event) => events.push(event),
    requestApproval: async () => { approvals += 1; return { approved: true } },
  })
  check('folder creation asked for approval', approvals === 1, String(approvals))
  check('folder is present in the workspace tree', ws.isDirectory('src/modules'))
  check('folder creation appears as a successful tool result', events.some((event) => event.type === 'tool_result' && event.name === 'create_folder' && event.ok))
  check('baseline checkpoint can restore the new folder', ws.restore(result.baseline).includes('src/modules') && !ws.isDirectory('src/modules'))
}

console.log('\n12. New folders work in an empty workspace and directory tool aliases recover')
{
  const ws = new VirtualWorkspace()
  const events = []
  const javelin = makeJavelin([
    { text: '', toolCalls: [{ id: 'dir1', name: 'create_directory', args: { path: 'game/assets' } }] },
    { text: '', toolCalls: [finish('dir2', 'Created game/assets in the new workspace', false)] },
  ])
  const result = await javelin.think({
    task: 'Create a game/assets folder in a new workspace',
    workspace: ws,
    onEvent: (event) => events.push(event),
    requestApproval: alwaysApprove,
  })
  check('directory tool aliases normalize to create_folder', canonicalizeToolCall({ name: 'mkdir' }).name === 'create_folder')
  check('camelCase file aliases normalize to write_file', canonicalizeToolCall({ name: 'createFile' }).name === 'write_file')
  check('hyphenated file aliases normalize to write_file', canonicalizeToolCall({ name: 'new-file' }).name === 'write_file')
  check('shell command aliases normalize to run_command', canonicalizeToolCall({ name: 'runShellCommand' }).name === 'run_command')
  check('root and nested folders are created without an existing project folder', ws.isDirectory('game') && ws.isDirectory('game/assets'))
  check('the empty-workspace folder operation succeeds', result.status === 'done', result.summary)
  check('folder creation is reported in the tool timeline', events.some((event) => event.type === 'tool_result' && event.name === 'create_folder' && event.ok))
}

console.log('\n13. Javelin refuses to finish a create task after only listing files')
{
  const events = []
  const ws = new VirtualWorkspace({ 'chess-game/package-lock.json': '{}\n' })
  const javelin = makeJavelin([
    { text: '', toolCalls: [{ id: 'list-chess', name: 'list_files', args: { path: 'chess-game' } }] },
    { text: '', toolCalls: [finish('premature-finish', 'No code files were found', false)] },
    { text: '', toolCalls: [{ id: 'create-game', name: 'createFile', args: { path: 'chess-game/Game.js', content: 'export default class Game {}\\n' } }] },
    { text: '', toolCalls: [finish('finish-game', 'Created the chess game source file', false)] },
  ])
  const result = await javelin.think({
    task: 'Create a chess game in chess-game',
    workspace: ws,
    onEvent: (event) => events.push(event),
    requestApproval: alwaysApprove,
  })
  check('premature finish produces a completion-required event',
    events.some((event) => event.type === 'completion_required' && event.note.includes('no file or folder change has succeeded')))
  check('Javelin creates the requested file after refusing premature finish',
    ws.exists('chess-game/Game.js'))
  check('Javelin completes after a real file change', result.status === 'done', result.status)
}

console.log('\n13a. Informational requests finish with a direct answer')
{
  const answer = 'Download the installer from the project releases, then run the setup executable.'
  const events = []
  const javelin = makeJavelin([{ text: answer, toolCalls: [] }])
  const result = await javelin.think({
    task: 'How do I download the IDE?',
    workspace: new VirtualWorkspace(),
    onEvent: (event) => events.push(event),
    requestApproval: alwaysApprove,
  })
  check('informational Javelin task completes without a no-action failure',
    result.status === 'done' && result.summary.startsWith(answer), `${result.status}: ${result.summary}`)
  check('informational response does not trigger a file action',
    !events.some((event) => event.type === 'tool_call'))
}

console.log('\n12. Identical narration is shown once and stops retrying')
{
  const repeatedText = 'I will inspect the project files now.'
  const events = []
  const javelin = makeJavelin([
    { text: repeatedText, toolCalls: [] },
    { text: '  i will inspect the project files now!  ', toolCalls: [] },
    { text: repeatedText, toolCalls: [] },
  ])
  const result = await javelin.think({
    task: 'Fix the project',
    workspace: new VirtualWorkspace(WORKSPACE),
    onEvent: (event) => events.push(event),
    requestApproval: alwaysApprove,
  })
  check('duplicate Javelin narration is only emitted once',
    events.filter((event) => event.type === 'thinking' && !event.repeated).length === 1)
  check('the repeated streamed response is explicitly marked for UI cleanup',
    events.some((event) => event.type === 'thinking' && event.repeated))
  check('Javelin identifies repeated narration in the stop reason',
    result.status === 'failed' && result.summary.includes('kept repeating itself'))
}

console.log('\n13. Serialized tool responses are never shown as Javelin thinking')
{
  const protocolText = [
    '<tool_response> {"name":"create_checkpoint","arguments":{"label":"Initial state"}} </tool_response>',
    'Task complete. No changes were made as there was nothing to fix.',
    '<tool_response> {"name":"finish","arguments":{"summary":"No files with code were found","verified":false}} </tool_response>',
  ].join('\n\n')
  const events = []
  const ws = new VirtualWorkspace({ 'chess-game/package-lock.json': '{}\n' })
  const javelin = makeJavelin([
    {
      text: protocolText,
      toolCalls: [{ id: 'protocol-checkpoint', name: 'create_checkpoint', args: { label: 'Initial state' } }],
    },
    { text: protocolText, toolCalls: [finish('protocol-finish', 'No files with code were found', false)] },
    {
      text: '',
      toolCalls: [{ id: 'real-change', name: 'write_file', args: { path: 'chess-game/Game.js', content: 'export default class Game {}\\n' } }],
    },
    { text: '', toolCalls: [finish('real-finish', 'Created the requested source file', false)] },
  ])
  const result = await javelin.think({
    task: 'Create a chess game in chess-game',
    workspace: ws,
    onEvent: (event) => events.push(event),
    requestApproval: alwaysApprove,
  })
  check('protocol text and false completion claim are not emitted as thinking',
    !events.some((event) => event.type === 'thinking' && /tool_response|Task complete/i.test(event.content)))
  check('Javelin still performs the requested change', ws.exists('chess-game/Game.js'))
  check('Javelin finishes on the real result', result.status === 'done')
}

console.log('\n14. Continue reuses the previous task and still requires a real change')
{
  const generatedRequests = []
  const events = []
  const protocolText = '<tool_response> {"name":"finish"} </tool_response>'
  const ws = new VirtualWorkspace({ 'chess-game/package-lock.json': '{}\n' })
  const javelin = makeJavelin([
    { text: '', toolCalls: [finish('early-finish', 'There are no code files', false)] },
    { text: '', toolCalls: [{ id: 'create-game', name: 'write_file', args: { path: 'chess-game/Game.js', content: 'export default class Game {}\\n' } }] },
    { text: '', toolCalls: [finish('finish-game', 'Created the chess game source file', false)] },
  ], { onGenerate: (request) => generatedRequests.push(request) })
  const result = await javelin.think({
    task: 'continue',
    priorMessages: [
      { role: 'user', content: 'Create a chess game in chess-game' },
      { role: 'assistant', content: protocolText },
    ],
    workspace: ws,
    onEvent: (event) => events.push(event),
    requestApproval: alwaysApprove,
  })
  const firstPrompt = generatedRequests[0]?.messages?.map((message) => message.content).join('\n') ?? ''
  check('the original create request is restored into the model task',
    firstPrompt.includes('Create a chess game in chess-game'))
  check('serialized protocol output is excluded from prior conversation',
    !generatedRequests.some((request) => request.messages?.some((message) => String(message.content).includes('<tool_response>'))))
  check('an early finish is refused because no file changed',
    events.some((event) => event.type === 'completion_required'))
  check('the continued run creates the requested file', ws.exists('chess-game/Game.js'))
  check('the run completes only after making the change', result.status === 'done', result.status)
}

console.log('\n15. Runs cannot overlap and stop remains effective during inference')
{
  let releaseGeneration
  const registry = new EngineRegistry()
  registry.register({
    id: 'delayed',
    label: 'Delayed engine',
    capabilities: ['tools'],
    async probe() { return { ok: true } },
    generate() {
      return new Promise((resolve) => { releaseGeneration = resolve })
    },
  })
  const javelin = createJavelin({ engines: registry })
  const firstRun = javelin.think({
    task: 'wait for inference',
    workspace: new VirtualWorkspace(WORKSPACE),
    onEvent: () => {},
  })
  check('busy is set before inference yields', javelin.busy)

  let overlapRejected = false
  try {
    await javelin.think({
      task: 'overlapping task',
      workspace: new VirtualWorkspace(WORKSPACE),
      onEvent: () => {},
    })
  } catch (error) {
    overlapRejected = error.message.includes('already running')
  }
  check('a second task is rejected while the first is active', overlapRejected)

  await new Promise((resolve) => setTimeout(resolve, 0))
  javelin.stop()
  releaseGeneration({ text: '', toolCalls: [finish('stop1', 'stopped', false)] })
  const result = await firstRun
  check('the active run reports stopped', result.status === 'aborted', result.status)
  check('busy clears after stopping', !javelin.busy)
}

console.log('\n15. Unavailable shell commands are not offered to Javelin')
{
  const registry = new EngineRegistry()
  const engine = makeEngine([{ text: '', toolCalls: [finish('no-shell', 'Read-only response', false)] }])
  let commandToolOffered = true
  const generate = engine.generate.bind(engine)
  engine.generate = async (request) => {
    commandToolOffered = request.tools.some((tool) => tool.function.name === 'run_command')
    return generate(request)
  }
  registry.register(engine)
  registry.assign('primary', 'test-engine')
  const javelin = createJavelin({ engines: registry })
  await javelin.think({
    task: 'Explain the project',
    workspace: new VirtualWorkspace(WORKSPACE),
    requestApproval: alwaysApprove,
  })
  check('run_command is hidden when no command executor exists', !commandToolOffered)
  check('the shared tool registry is restored after the run', javelin.tools.has('run_command'))
}

console.log(`\n${failures === 0 ? 'ALL JAVELIN CORE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
