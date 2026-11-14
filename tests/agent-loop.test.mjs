/**
 * End-to-end test of the agent loop with a scripted fake model.
 *
 * We inject canned model responses with tool calls, then assert the loop's
 * behaviour: approval gating, failure memory (no repeat of
 * a failed call), edit application, and honest finish reporting.
 */

import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`) }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

function delCall(id, path) {
  return { id, name: 'delete_file', args: { path, reason: 'obsolete' } }
}

function finishCall(id, summary) {
  return { id, name: 'finish', args: { summary, verified: false } }
}

function scriptedCompletion(script, onGenerate) {
  let call = 0
  return async (request) => {
    onGenerate?.(request)
    const step = script[Math.min(call, script.length - 1)]
    call++
    return {
      content: step.content ?? '',
      toolCalls: step.toolCalls ?? [],
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
    }
  }
}

function textCompletion(script, readStream) {
  let call = 0
  return async ({ onToken, signal }) => {
    const text = script[Math.min(call, script.length - 1)]
    call += 1
    const event = `data: ${JSON.stringify({
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`
    return readStream(new Response(event), { onToken, signal })
  }
}

const script = [
  // Step 1: inspect (read a file that exists) + attempt an edit with a bad snippet.
  {
    content: 'Plan: 1) read the file 2) fix the bug 3) verify.',
    toolCalls: [
      { id: 'c1', name: 'read_file', args: { path: 'calc.js' } },
      { id: 'c2', name: 'edit_file', args: { path: 'calc.js', old_string: 'NOT THERE', new_string: 'x' } },
    ],
  },
  // Step 2: the model "retries" the identical failing edit — the loop must block it.
  {
    content: '',
    toolCalls: [
      { id: 'c3', name: 'edit_file', args: { path: 'calc.js', old_string: 'NOT THERE', new_string: 'x' } },
    ],
  },
  // Step 3: a correct edit, which must be gated behind approval.
  {
    content: '',
    toolCalls: [
      { id: 'c4', name: 'edit_file', args: { path: 'calc.js', old_string: 'return a - b', new_string: 'return a + b' } },
    ],
  },
  // Step 4: finish.
  {
    content: '',
    toolCalls: [
      { id: 'c5', name: 'finish', args: { summary: 'Fixed the subtraction bug in calc.js', verified: false } },
    ],
  },
]
const generate = scriptedCompletion(script)

const { runAgent } = await import('../src/lib/agent.js')

const events = []
const seen = { reminders: [], approvals: [], fileChanges: [], results: [] }
let approvalCount = 0

const ws = new VirtualWorkspace({
  'calc.js': 'function add(a, b) {\n  return a - b\n}\n',
})

const result = await runAgent({
  task: 'Fix the bug in calc.js',
  workspace: ws,
  provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
  generate,
  signal: new AbortController().signal,
  events: {
    emit: (evt) => {
      events.push(evt)
      if (evt.type === 'reminder') { seen.reminders.push(evt.text) }
      if (evt.type === 'file_changed') { seen.fileChanges.push(evt) }
      if (evt.type === 'tool_result') { seen.results.push(evt) }
      if (evt.type === 'approval_requested') { seen.approvals.push(evt) }
    },
    requestApproval: async () => {
      approvalCount++
      return { approved: true, remember: false }
    },
  },
})

console.log('\n1. Approval gate')
check('file edits triggered approval requests', seen.approvals.length >= 1, `got ${seen.approvals.length}`)
check('approval request carried a preview diff', seen.approvals.some((a) => a.diff), 'no diff attached')

console.log('\n2. Failure memory (no repeating a failed step)')
check('a reminder was emitted about the failed call', seen.reminders.length >= 1, JSON.stringify(seen.reminders))
check(
  'reminder names the exact failed action',
  seen.reminders.some((r) => r.includes('edit_file:calc.js')),
  JSON.stringify(seen.reminders),
)
const badEditResult = seen.results.find((r) => r.output && r.output.includes('not found'))
check('the bad edit was reported as failed', Boolean(badEditResult))

console.log('\n3. The good edit applied')
check('file changed event emitted', seen.fileChanges.length === 1, `got ${seen.fileChanges.length}`)
check('calc.js now uses +', ws.read('calc.js').includes('return a + b'))
check('calc.js no longer uses -', !ws.read('calc.js').includes('return a - b'))

console.log('\n4. Run finished honestly')
check('status is done', result.status === 'done', result.status)
check('summary is the model-provided one', result.summary.includes('Fixed the subtraction bug'))
check('steps were recorded', result.steps.length >= 3, `got ${result.steps.length}`)

console.log('\n5. Abort support')
{
  const ws2 = new VirtualWorkspace({ 'a.js': 'x\n' })
  const ctrl = new AbortController()
  ctrl.abort()
  const r2 = await runAgent({
    task: 'anything',
    workspace: ws2,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    signal: ctrl.signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })
  check('an aborted run reports aborted', r2.status === 'aborted', r2.status)
}

console.log('\n6. Deleting a file is gated and refused when denied')
{
  const deleteScript = [
    { content: '', toolCalls: [delCall('d1', 'old.js')] },
    { content: '', toolCalls: [finishCall('d2', 'user denied the delete')] },
  ]
  const generate = scriptedCompletion(deleteScript)

  const deleteEvents = []
  let approvalsForDelete = 0
  const wsDelete = new VirtualWorkspace({ 'old.js': 'obsolete\n', 'keep.js': 'keep\n' })

  await runAgent({
    task: 'Delete the obsolete file',
    workspace: wsDelete,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: {
      emit: (evt) => deleteEvents.push(evt),
      requestApproval: async (req) => {
        if (req.name === 'delete_file') approvalsForDelete++
        return { approved: false }
      },
    },
  })

  check('delete_file triggered an approval request', approvalsForDelete >= 1, String(approvalsForDelete))
  check('the file was NOT deleted after denial', wsDelete.exists('old.js'))
  check('the delete approval carried a diff',
    deleteEvents.some((e) => e.type === 'approval_requested' && e.name === 'delete_file' && e.diff))
}

console.log('\n7. Successful repeated reads stop instead of looping')
{
  const repeatedList = (id) => ({ id, name: 'list_files', args: { path: '' } })
  const generate = scriptedCompletion([
    { content: '', toolCalls: [repeatedList('l1')] },
    { content: '', toolCalls: [repeatedList('l2')] },
    { content: '', toolCalls: [repeatedList('l3')] },
    { content: '', toolCalls: [repeatedList('l4')] },
  ])
  const events = []
  const result = await runAgent({
    task: 'Understand the project',
    workspace: new VirtualWorkspace({ 'main.lua': 'print("hello")' }),
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: { emit: (event) => events.push(event), requestApproval: async () => ({ approved: true }) },
  })
  check('repeat-only activity ends as failed', result.status === 'failed', result.status)
  check('repeat stop reports why it stopped', result.summary.includes('repeated actions'))
  check('blocked repeats are visible', events.filter((event) => event.type === 'reminder').length === 3)
}

console.log('\n8. Narration-only turns stop early')
{
  const generate = scriptedCompletion([
    { content: 'I will inspect the project.' },
    { content: 'I am still inspecting.' },
    { content: 'I will continue now.' },
  ])
  const result = await runAgent({
    task: 'Fix the project',
    workspace: new VirtualWorkspace({ 'main.lua': 'print("hello")' }),
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })
  check('narration-only run stops as failed', result.status === 'failed', result.status)
  check('failure explains there was no tool action', result.summary.includes('without a tool action'))
}

console.log('\n9. Folder creation is approved and applied')
{
  const generate = scriptedCompletion([
    { content: '', toolCalls: [{ id: 'f1', name: 'create_folder', args: { path: 'src/modules' } }] },
    { content: '', toolCalls: [finishCall('f2', 'Created the modules folder')] },
  ])
  const events = []
  let approvals = 0
  const workspace = new VirtualWorkspace({ 'main.lua': 'print("hello")' })
  const result = await runAgent({
    task: 'Create src/modules',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: {
      emit: (event) => events.push(event),
      requestApproval: async (request) => {
        if (request.name === 'create_folder') approvals += 1
        return { approved: true }
      },
    },
  })
  check('folder creation requested approval', approvals === 1, String(approvals))
  check('folder exists in the workspace tree', workspace.isDirectory('src/modules'))
  check('folder creation was recorded as a successful tool result', events.some((event) => event.type === 'tool_result' && event.name === 'create_folder' && event.ok))
  check('the folder task completed', result.status === 'done', result.status)
}

console.log('\n10. Embedded local-model tool calls execute end to end')
{
  const { readStream } = await import('../src/lib/providers.js')
  const source = [
    '// src/chess/Game.js',
    '',
    'class Game {',
    '  constructor() { this.currentPlayer = "white"; }',
    '}',
    '',
    'export default Game;',
    '',
  ].join('\n')
  const generate = textCompletion([
    [
      'Create a new file `Game.js` inside the `src/chess` folder to define the game logic.',
      'javascriptCopy',
      '```',
      '// src/chess/Game.js',
      '',
      'class Game {',
      '  constructor() { this.currentPlayer = "white"; }',
      '}',
      '',
      'export default Game;',
      '```',
      'jsonCopy',
      '```',
      '{"name":"run_command","arguments":{"command":"npm test"}}',
      '```',
      'Run the project tests again:',
      'jsonCopy',
      '```',
      '{"name":"run_command","arguments":{"command":"npm test"}}',
      '```',
    ].join('\n'),
    [
      'The file was created and npm test passed.',
      '```jsonCopy',
      '{"name":"finish","arguments":{"summary":"Created Game.js and ran tests","verified":true}}',
      '```',
    ].join('\n'),
  ], readStream)

  const workspace = new VirtualWorkspace({ 'package.json': '{"scripts":{"test":"node test.js"}}' })
  const commands = []
  const result = await runAgent({
    task: 'Create a chess game module and run tests',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    runCommand: async (command) => {
      commands.push(command)
      return { exitCode: 0, stdout: 'tests passed', stderr: '' }
    },
    signal: new AbortController().signal,
    events: {
      emit: () => {},
      requestApproval: async () => ({ approved: true, remember: false }),
    },
  })

  check('the recovered write_file call created the requested file', workspace.read('src/chess/Game.js') === source)
  check('a repeated JSON command is only executed once', commands.length === 1 && commands[0] === 'npm test', JSON.stringify(commands))
  check('the agent finishes after executing its recovered calls', result.status === 'done', result.summary)
}

console.log('\n11. Commands stream output and are only offered when executable')
{
  const commandScript = scriptedCompletion([
    { content: '', toolCalls: [{ id: 'cmd1', name: 'run_command', args: { command: 'npm test' } }] },
    { content: '', toolCalls: [finishCall('cmd2', 'Tests passed')] },
  ])
  const events = []
  let offeredTools = []
  const result = await runAgent({
    task: 'Run project tests',
    workspace: new VirtualWorkspace({ 'package.json': '{"scripts":{"test":"node test.js"}}' }),
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate: async (request) => {
      offeredTools = request.tools
      return commandScript(request)
    },
    runCommand: async (_command, _signal, onOutput) => {
      onOutput({ stream: 'stdout', text: 'live test output' })
      return { exitCode: 0, stdout: 'live test output', stderr: '' }
    },
    signal: new AbortController().signal,
    events: {
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
    },
  })
  check('run_command is available when the desktop executor exists',
    offeredTools.some((tool) => tool.function.name === 'run_command'))
  check('command output is streamed with its tool id',
    events.some((event) => event.type === 'command_output' && event.id === 'cmd1' && event.text === 'live test output'))
  check('the command task completes', result.status === 'done', result.status)

  let browserTools = []
  await runAgent({
    task: 'Explain this code',
    workspace: new VirtualWorkspace({ 'main.js': 'export const value = 1' }),
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate: async (request) => {
      browserTools = request.tools
      return { content: '', toolCalls: [finishCall('browser-finish', 'Explained')] }
    },
    signal: new AbortController().signal,
    events: { emit: () => {}, requestApproval: async () => ({ approved: true }) },
  })
  check('run_command is not offered when shell execution is unavailable',
    !browserTools.some((tool) => tool.function.name === 'run_command'))
}

console.log('\n12. A failed ambiguous edit does not block a different targeted edit')
{
  const workspace = new VirtualWorkspace({
    'board.py': [
      'def place_piece(piece, square):',
      '    pass',
      '',
      'def remove_piece(square):',
      '    pass',
      '',
      'def move_piece(source, target):',
      '    pass',
    ].join('\n'),
  })
  const generate = scriptedCompletion([
    {
      content: '',
      toolCalls: [{
        id: 'ambiguous-edit',
        name: 'edit_file',
        args: { path: 'board.py', old_string: '    pass', new_string: '    return piece' },
      }],
    },
    {
      content: '',
      toolCalls: [{
        id: 'targeted-edit',
        name: 'edit_file',
        args: {
          path: 'board.py',
          old_string: '    pass',
          new_string: '    return square',
          occurrence: 2,
        },
      }],
    },
    { content: '', toolCalls: [finishCall('finish-board', 'Implemented the selected method')] },
  ])
  const events = []
  const result = await runAgent({
    task: 'Implement the remove_piece method',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: {
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
    },
  })
  check('ambiguous edit reports occurrence context',
    events.some((event) => event.type === 'tool_result' && event.id === 'ambiguous-edit' &&
      event.output.includes('#2 line 5: def remove_piece')))
  check('different replacement and occurrence are not blocked as a repeat',
    events.some((event) => event.type === 'tool_result' && event.id === 'targeted-edit' && event.ok))
  check('only the requested method was changed',
    workspace.read('board.py').includes('def remove_piece(square):\n    return square') &&
      workspace.read('board.py').includes('def place_piece(piece, square):\n    pass') &&
      workspace.read('board.py').includes('def move_piece(source, target):\n    pass'))
  check('agent finishes after the targeted recovery', result.status === 'done', result.status)
}

console.log('\n13. A listing and checkpoint cannot finish a requested implementation')
{
  const workspace = new VirtualWorkspace({ 'chess-game/package-lock.json': '{}\n' })
  const generate = scriptedCompletion([
    { content: '', toolCalls: [{ id: 'list-chess', name: 'list_files', args: { path: 'chess-game' } }] },
    { content: '', toolCalls: [{ id: 'checkpoint-chess', name: 'create_checkpoint', args: { label: 'Initial state' } }] },
    { content: '', toolCalls: [finishCall('premature-finish', 'No code files were found')] },
    { content: '', toolCalls: [{ id: 'create-game', name: 'createFile', args: { path: 'chess-game/Game.js', content: 'export default class Game {}\\n' } }] },
    { content: '', toolCalls: [finishCall('finish-game', 'Created the chess game source file')] },
  ])
  const events = []
  const result = await runAgent({
    task: 'Create a chess game in chess-game',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: {
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
    },
  })
  check('premature finish is explicitly rejected',
    events.some((event) => event.type === 'tool_result' && event.id === 'premature-finish' &&
      event.ok === false && event.output.includes('no file or folder change has succeeded')))
  check('agent creates the requested file despite only seeing a package lock',
    workspace.exists('chess-game/Game.js'))
  check('agent finishes only after successful implementation',
    result.status === 'done' && events.some((event) => event.type === 'tool_result' && event.id === 'create-game' && event.ok),
    `${result.status}: ${result.summary}`)
}

console.log('\n14. Completion prose without a finish tool is never success')
{
  const workspace = new VirtualWorkspace({ 'chess-game/package-lock.json': '{}\n' })
  const generate = scriptedCompletion([
    { content: '', toolCalls: [{ id: 'list-before-prose', name: 'list_files', args: { path: 'chess-game' } }] },
    { content: 'Task complete. No source files were found.', toolCalls: [] },
  ])
  const result = await runAgent({
    task: 'Create a chess game in chess-game',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: { emit: () => {}, requestApproval: async () => ({ approved: true }) },
  })
  check('text-only completion after inspection ends as failed, not done',
    result.status === 'failed' && result.summary.includes('without a tool action'), `${result.status}: ${result.summary}`)
}

console.log('\n15. Identical narration is shown once and stops retrying')
{
  const repeatedText = 'I will inspect the project files now.'
  const generate = scriptedCompletion([
    { content: repeatedText },
    { content: '  i will inspect the project files now!  ' },
    { content: repeatedText },
  ])
  const events = []
  const result = await runAgent({
    task: 'Fix the project',
    workspace: new VirtualWorkspace({ 'main.js': 'export {}\n' }),
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: { emit: (event) => events.push(event), requestApproval: async () => ({ approved: true }) },
  })
  check('intermediate model narration is not emitted as chat messages',
    !events.some((event) => event.type === 'assistant_message'))
  check('progress remains visible without exposing model narration',
    events.some((event) => event.type === 'status' && /repeated itself|workspace action/i.test(event.text)))
  check('identical narration is identified in the stop reason',
    result.status === 'failed' && result.summary.includes('kept repeating itself'))
}

console.log('\n16. Serialized tool responses are never shown as assistant messages')
{
  const protocolText = [
    '<tool_response> {"name":"create_checkpoint","arguments":{"label":"Initial state"}} </tool_response>',
    'Task complete. No changes were made as there was nothing to fix.',
    '<tool_response> {"name":"finish","arguments":{"summary":"No files with code were found","verified":false}} </tool_response>',
  ].join('\n\n')
  const workspace = new VirtualWorkspace({ 'chess-game/package-lock.json': '{}\n' })
  const generate = scriptedCompletion([
    {
      content: protocolText,
      toolCalls: [{ id: 'protocol-checkpoint', name: 'create_checkpoint', args: { label: 'Initial state' } }],
    },
    {
      content: protocolText,
      toolCalls: [finishCall('protocol-finish', 'No files with code were found')],
    },
    {
      content: '',
      toolCalls: [{ id: 'real-change', name: 'write_file', args: { path: 'chess-game/Game.js', content: 'export default class Game {}\\n' } }],
    },
    { content: '', toolCalls: [finishCall('real-finish', 'Created the requested source file')] },
  ])
  const events = []
  const result = await runAgent({
    task: 'Create a chess game in chess-game',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: { emit: (event) => events.push(event), requestApproval: async () => ({ approved: true }) },
  })
  check('protocol text and the false completion claim are not emitted',
    !events.some((event) => event.type === 'assistant_message' && /tool_response|Task complete/i.test(event.content)))
  check('the actual requested workspace change still occurs',
    workspace.exists('chess-game/Game.js'))
  check('the agent finishes on the real result',
    result.status === 'done' && result.summary === 'Created the requested source file')
}

console.log('\n17. Continue restores the previous task and requires a real change')
{
  const generatedRequests = []
  const events = []
  const workspace = new VirtualWorkspace({ 'chess-game/package-lock.json': '{}\n' })
  const generate = scriptedCompletion([
    { content: '', toolCalls: [finishCall('early-finish', 'There are no code files')] },
    { content: '', toolCalls: [{ id: 'create-game', name: 'write_file', args: { path: 'chess-game/Game.js', content: 'export default class Game {}\\n' } }] },
    { content: '', toolCalls: [finishCall('finish-game', 'Created the chess game source file')] },
  ], (request) => generatedRequests.push(request))
  const result = await runAgent({
    task: 'continue',
    priorMessages: [
      { role: 'user', content: 'Create a chess game in chess-game' },
      { role: 'assistant', content: '<tool_response> {"name":"finish"} </tool_response>' },
    ],
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: { emit: (event) => events.push(event), requestApproval: async () => ({ approved: true }) },
  })
  const firstPrompt = generatedRequests[0]?.messages?.map((message) => message.content).join('\n') ?? ''
  check('the original request is restored into the model task',
    firstPrompt.includes('Create a chess game in chess-game'))
  check('serialized protocol text is omitted from prior context',
    !generatedRequests.some((request) => request.messages?.some((message) => String(message.content).includes('<tool_response>'))))
  check('premature finish is refused',
    events.some((event) => event.type === 'tool_result' && event.id === 'early-finish' &&
      event.ok === false && event.output.includes('no file or folder change has succeeded')))
  check('the continued run creates the requested file and completes',
    workspace.exists('chess-game/Game.js') && result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n11a. Narrated source code is imported into the requested workspace file')
{
  const { readStream } = await import('../src/lib/providers.js')
  const source = [
    'Write the initial code for the game logic in `flappy_bird/game.js`.',
    '```javascript',
    '// flappy_bird/game.js',
    'export function startGame() {}',
    '```',
  ].join('\n')
  const generate = textCompletion([
    source,
    '{"name":"finish","arguments":{"summary":"Created the game module","verified":false}}',
  ], readStream)
  const workspace = new VirtualWorkspace()
  const events = []
  const result = await runAgent({
    task: 'Create a game module',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: {
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
    },
  })
  check('the narrated code is written to the named workspace path',
    workspace.read('flappy_bird/game.js')?.includes('export function startGame() {}'))
  check('the code narration is never appended as assistant chat',
    !events.some((event) => event.type === 'assistant_message'))
  check('the real write action is visible to the activity timeline',
    events.some((event) => event.type === 'tool_call' && event.name === 'write_file' && event.args.path === 'flappy_bird/game.js'))
  check('the task completes after importing the code',
    result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n11b. Unsupported tool names return guidance and can recover')
{
  const workspace = new VirtualWorkspace()
  const events = []
  const generate = scriptedCompletion([
    { content: '', toolCalls: [{ id: 'bad-tool', name: 'create_html_file', args: { path: 'index.html', content: '<main />' } }] },
    { content: '', toolCalls: [{ id: 'good-tool', name: 'createFile', args: { path: 'index.html', content: '<main />' } }] },
    { content: '', toolCalls: [finishCall('finish-html', 'Created index.html')] },
  ])
  const result = await runAgent({
    task: 'Create index.html',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: {
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
    },
  })
  const unsupported = events.find((event) => event.type === 'tool_result' && event.id === 'bad-tool')
  check('an unsupported tool error names valid replacements',
    unsupported?.output.includes('Available tools:') && unsupported.output.includes('write_file'))
  check('the agent recovers with a supported file creation alias',
    workspace.exists('index.html') &&     result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n11b. File-creation explanations create only their declared source files')
{
  const { readStream } = await import('../src/lib/providers.js')
  const narration = [
    'First, create a Python script for the game. Let us call it `guess_the_number.py`.',
    'pythonCopy',
    '```',
    '# guess_the_number.py',
    'def play_game():',
    '    return "ready"',
    '```',
    'Now, create an HTML file to load this script.',
    'htmlCopy',
    '```',
    '<!-- flappy_bird/index.html -->',
    '<!doctype html>',
    '<script src="game.js"></script>',
    '```',
    'For an optional import example in another script, use:',
    '```python',
    '# main.py',
    'from guess_the_number import play_game',
    '```',
  ].join('\n')
  const generate = textCompletion([
    narration,
    '{"name":"finish","arguments":{"summary":"Created the requested files","verified":false}}',
  ], readStream)
  const workspace = new VirtualWorkspace()
  const result = await runAgent({
    task: 'Create a guessing game and its HTML loader',
    workspace,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: { emit: () => {}, requestApproval: async () => ({ approved: true }) },
  })
  check('both explicitly named files are actually written',
    workspace.exists('guess_the_number.py') && workspace.exists('flappy_bird/index.html'))
  check('an optional import example is not written as an extra file',
    !workspace.exists('main.py'))
  check('the model cannot claim completion without the recovered writes',
    result.status === 'done' && result.steps.some((step) => step.name === 'write_file' && step.ok),
    `${result.status}: ${result.summary}`)
}

console.log('\n11c. Informational requests can finish without a workspace tool call')
{
  const answer = 'Download the Windows installer from the project release page, then run the setup executable.'
  const generate = scriptedCompletion([{ content: answer }])
  const events = []
  const result = await runAgent({
    task: 'How do I download the IDE?',
    workspace: new VirtualWorkspace(),
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    generate,
    signal: new AbortController().signal,
    events: { emit: (event) => events.push(event), requestApproval: async () => ({ approved: true }) },
  })
  check('an informational answer completes without the three-turn no-tool failure',
    result.status === 'done' && result.summary === answer, `${result.status}: ${result.summary}`)
  check('informational completion does not invent file activity',
    !events.some((event) => event.type === 'tool_call'))
}

console.log(`\n${failures === 0 ? 'ALL AGENT-LOOP CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
