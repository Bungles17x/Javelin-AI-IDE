/**
 * Reliability tests for multi-step agent runs.
 *
 * These cover the failure modes that stop a run from finishing real coding work:
 *  - a model that answers without calling a tool, or repeats itself;
 *  - paths drifting between `./src/a.js`, `src\\a.js` and absolute paths;
 *  - tool results missing from the transcript sent back to the model;
 *  - the same call being repeated instead of using its result;
 *  - transient model failures ending the whole run;
 *  - a write that "succeeds" without changing the workspace;
 *  - approval requirements being lost in the process.
 */

import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'
import { normalizeToolPath, signatureOf } from '../src/lib/agentTools.js'
import { runAgent } from '../src/lib/agent.js'
import { ERROR_CODES } from '../src/engine/errors.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`) }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

function finishCall(id, summary, verified = false) {
  return { id, name: 'finish', args: { summary, verified } }
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

const provider = { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' }
const eventsFor = () => {
  const events = []
  return { events, emit: (event) => events.push(event) }
}

/** A transcript is invalid if a tool call has no result, or a result has no call. */
function transcriptProblems(messages) {
  const problems = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue

    const ids = message.tool_calls.map((call) => call.id)
    if (new Set(ids).size !== ids.length) problems.push(`duplicate tool call id in one turn: ${ids.join(', ')}`)
    if (ids.some((id) => !id)) problems.push('a tool call had no id')

    const answered = []
    let next = index + 1
    while (messages[next]?.role === 'tool') {
      answered.push(messages[next].tool_call_id)
      next++
    }
    for (const id of ids) {
      if (!answered.includes(id)) problems.push(`no tool result for ${id}`)
    }
    for (const id of answered) {
      if (!ids.includes(id)) problems.push(`tool result ${id} has no matching call`)
    }
    if (messages[next]?.role === 'system') problems.push('a system message interrupts tool results')
  }
  return problems
}

console.log('\n1. Paths are canonicalised before they reach the workspace')
{
  check('a backslash path becomes a workspace path', normalizeToolPath('src\\utils\\helper.js') === 'src/utils/helper.js')
  check('a ./ prefix is stripped', normalizeToolPath('./src/app.js') === 'src/app.js')
  check('a quoted path is unwrapped', normalizeToolPath('`src/app.js`') === 'src/app.js')
  check('duplicate separators collapse', normalizeToolPath('src//app.js') === 'src/app.js')
  check('a file:// prefix is unwrapped', normalizeToolPath('file:///src/app.js') === '/src/app.js')

  const ws = new VirtualWorkspace({ 'src/app.js': 'export const value = 1\n' })
  check('reading with ./ resolves the file the agent wrote', ws.read('./src/app.js').includes('const value'))
  check('exists() accepts a windows separator', ws.exists('src\\app.js'))
  check('an absolute path inside the project recovers', ws.read('/home/dev/project/src/app.js').includes('const value'))
  check('a windows absolute path inside the project recovers', ws.read('C:\\Users\\dev\\project\\src\\app.js').includes('const value'))

  let traversal = ''
  try { ws.read('../secret.txt') } catch (error) { traversal = error.message }
  check('parent traversal is still refused', /inside the workspace/i.test(traversal), traversal)
  check('a same-file signature is stable across path spellings',
    signatureOf('read_file', { path: './src/app.js' }) === signatureOf('read_file', { path: 'src\\app.js' }))
}

console.log('\n2. A multi-step edit works even when the model changes path spelling')
{
  const workspace = new VirtualWorkspace({ 'src/app.js': 'export function value() {\n  return 1\n}\n' })
  const generate = scriptedCompletion([
    {
      content: 'Plan: 1) read app.js 2) rename the function 3) finish.',
      toolCalls: [
        { id: 'p1', name: 'write_file', args: { path: 'src\\app.js', content: 'export function value() {\n  return 1\n}\n', overwrite: true } },
      ],
    },
    { content: '', toolCalls: [{ id: 'p2', name: 'read_file', args: { path: './src/app.js' } }] },
    {
      content: '',
      toolCalls: [{
        id: 'p3',
        name: 'edit_file',
        args: { path: '/home/dev/project/src/app.js', old_string: 'return 1', new_string: 'return 42' },
      }],
    },
    { content: '', toolCalls: [finishCall('p4', 'Updated the value')] },
  ])
  const { events, emit } = eventsFor()
  const result = await runAgent({
    task: 'Update the value in src/app.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })

  check('no tool failed because of a path mismatch',
    !events.some((event) => event.type === 'tool_result' && !event.ok), JSON.stringify(events.filter((e) => e.type === 'tool_result' && !e.ok)))
  check('the edit applied through the recovered absolute path', workspace.read('src/app.js').includes('return 42'))
  check('only one file exists for the file the model wrote', workspace.list('src').length === 1, JSON.stringify(workspace.list('src')))
  check('the multi-step run finished', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n3. Every tool call the model issues gets a result back')
{
  const requests = []
  const workspace = new VirtualWorkspace({ 'src/app.js': 'const value = 1\n' })
  const generate = scriptedCompletion([
    {
      content: '',
      toolCalls: [
        { id: 'same', name: 'read_file', args: { path: './src/app.js' } },
        { id: 'same', name: 'edit_file', args: { path: 'src/app.js', old_string: 'NOPE', new_string: 'x' } },
      ],
    },
    { content: '', toolCalls: [{ id: 'same', name: 'edit_file', args: { path: 'src/app.js', old_string: 'NOPE', new_string: 'x' } }] },
    {
      content: '',
      toolCalls: [{ id: 'same', name: 'edit_file', args: { path: 'src/app.js', old_string: 'const value = 1', new_string: 'const value = 2' } }],
    },
    { content: '', toolCalls: [finishCall('done', 'Updated value')] },
  ], (request) => requests.push(request))

  const result = await runAgent({
    task: 'Change the value in src/app.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })

  const problems = requests.flatMap((request) => transcriptProblems(request.messages))
  check('no request had a missing, orphaned or duplicated tool result', problems.length === 0, problems.join(' | '))
  const twoCallTurn = requests
    .flatMap((request) => request.messages)
    .find((message) => Array.isArray(message.tool_calls) && message.tool_calls.length === 2)
  check('a duplicate call id from the model was rewritten per call',
    Boolean(twoCallTurn) && new Set(twoCallTurn.tool_calls.map((call) => call.id)).size === 2,
    JSON.stringify(twoCallTurn?.tool_calls?.map((call) => call.id)))
  check('the repeated failed call was blocked rather than executed again',
    requests.at(-1)?.messages.some((message) => message.role === 'system' && message.content.includes('edit_file:src/app.js')))
  check('the run still completed after the blocked repeat', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n4. Repeated calls are detected, but real follow-up work is not blocked')
{
  const workspace = new VirtualWorkspace({ 'src/app.js': ['const a = 1', 'const b = 2', 'const c = 3'].join('\n') })
  const { events, emit } = eventsFor()
  const generate = scriptedCompletion([
    {
      content: '',
      toolCalls: [
        { id: 'r1', name: 'read_file', args: { path: 'src/app.js' } },
        { id: 'r2', name: 'read_file', args: { path: './src/app.js' } },
      ],
    },
    { content: '', toolCalls: [{ id: 'r3', name: 'read_file', args: { path: 'src/app.js', start: 2, end: 2 } }] },
    { content: '', toolCalls: [{ id: 'r4', name: 'finish', args: { summary: 'Read the file' } }] },
  ])
  const result = await runAgent({
    task: 'Explain src/app.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })

  const results = events.filter((event) => event.type === 'tool_result' && ['r1', 'r2', 'r3'].includes(event.id))
  check('re-reading the same file is served again instead of blocked', results.find((event) => event.id === 'r2')?.ok === true, JSON.stringify(results))
  check('re-reading does not count as a blocked repeat', result.metrics.duplicatesBlocked === 0, JSON.stringify(result.metrics))
  check('a different line range of the same file is allowed', results.find((event) => event.id === 'r3')?.ok === true, JSON.stringify(results))
  check('the informational task still completes', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n4b. Different cached calls are not collapsed into one repeated-action loop')
{
  const workspace = new VirtualWorkspace({
    'src/app.js': 'export const app = 1\n',
    'docs/guide.md': '# Guide\n',
  })
  const list = (id, path) => ({ id, name: 'list_files', args: { path } })
  const { events, emit } = eventsFor()
  const generate = scriptedCompletion([
    { content: '', toolCalls: [list('a1', ''), list('a2', 'src'), list('a3', 'docs')] },
    { content: '', toolCalls: [list('b1', ''), list('b2', 'src'), list('b3', 'docs')] },
    { content: '', toolCalls: [finishCall('done', 'Explored the project')] },
  ])
  const result = await runAgent({
    task: 'Understand the project',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  check('three different cached calls do not fail the run', result.status === 'done', `${result.status}: ${result.summary}`)
  check('the three different calls are each still reported as blocked', events.filter((event) => event.type === 'reminder').length === 3, String(events.filter((event) => event.type === 'reminder').length))
}

console.log('\n5. Model failures are retried a bounded number of times')
{
  let attempts = 0
  const { events, emit } = eventsFor()
  const flaky = async () => {
    attempts++
    if (attempts < 3) throw new Error('fetch failed')
    return { content: '', toolCalls: [finishCall('after-retry', 'Recovered')], finishReason: 'stop' }
  }
  const result = await runAgent({
    task: 'Say hello',
    workspace: new VirtualWorkspace(),
    provider,
    generate: flaky,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  check('two transient failures were retried', attempts === 3, String(attempts))
  check('the retry is visible to the user', events.some((event) => event.type === 'status' && /retrying/i.test(event.text)))
  check('the run completes after the retry', result.status === 'done', `${result.status}: ${result.summary}`)

  let hardAttempts = 0
  const broken = async () => { hardAttempts++; throw new Error('fetch failed') }
  const brokenResult = await runAgent({
    task: 'Say hello',
    workspace: new VirtualWorkspace(),
    provider,
    generate: broken,
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })
  check('a permanent transport failure stops after the retry budget', hardAttempts === 3, String(hardAttempts))
  check('the permanent failure is reported honestly', brokenResult.status === 'failed' && brokenResult.summary.includes('fetch failed'))

  let singleAttempt = 0
  const fatal = async () => { singleAttempt++; throw new Error('Model "x" not found (404)') }
  await runAgent({
    task: 'Say hello',
    workspace: new VirtualWorkspace(),
    provider,
    generate: fatal,
    signal: new AbortController().signal,
    events: { emit: () => { }, requestApproval: async () => ({ approved: true }) },
  })
  check('a non-retryable error is not retried', singleAttempt === 1, String(singleAttempt))
}

console.log('\n6. A write is verified against the workspace, not just trusted')
{
  // A workspace that claims every write succeeded but persists nothing.
  class DroppingWorkspace extends VirtualWorkspace {
    write(path, content) {
      return { path, before: '', after: content, diff: { lines: [], added: 0, removed: 0 }, action: 'write' }
    }
  }

  const workspace = new DroppingWorkspace()
  const { events, emit } = eventsFor()
  const generate = scriptedCompletion([
    { content: '', toolCalls: [{ id: 'ghost', name: 'write_file', args: { path: 'src/ghost.js', content: 'export const ghost = 1\n' } }] },
    { content: '', toolCalls: [{ id: 'ghost2', name: 'write_file', args: { path: 'src/ghost.js', content: 'export const ghost = 2\n', overwrite: true } }] },
    { content: '', toolCalls: [finishCall('ghost-finish', 'Created the file')] },
    { content: '', toolCalls: [finishCall('ghost-finish-2', 'Created the file')] },
    { content: '', toolCalls: [finishCall('ghost-finish-3', 'Created the file')] },
  ])
  const result = await runAgent({
    task: 'Create src/ghost.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })

  const ghostResult = events.find((event) => event.type === 'tool_result' && event.id === 'ghost')
  check('the dropped write is reported as a failure', ghostResult?.ok === false && ghostResult.output.includes('VERIFICATION FAILED'), JSON.stringify(ghostResult))
  check('the verification names the missing file', ghostResult.output.includes('does not exist'))
  check('finish is refused because nothing actually changed',
    events.some((event) => event.type === 'tool_result' && event.id === 'ghost-finish' && !event.ok && event.output.includes('no file or folder change has succeeded')))
  check('the run never claims success', result.status === 'failed', `${result.status}: ${result.summary}`)
  check('repeated premature finishes are not mislabeled as a repeated-action loop', result.code !== ERROR_CODES.REPEATED_ACTIONS, String(result.code))
  check('the failure names the missing file instead', result.code === ERROR_CODES.MISSING_FILES, String(result.code))
  check('no file was invented by the loop', !workspace.exists('src/ghost.js'))
}

console.log('\n7. A silently truncated write is caught')
{
  class TruncatingWorkspace extends VirtualWorkspace {
    write(path, content, overwrite) {
      return super.write(path, String(content).slice(0, 8), overwrite)
    }
  }
  const workspace = new TruncatingWorkspace()
  const { events, emit } = eventsFor()
  const generate = scriptedCompletion([
    { content: '', toolCalls: [{ id: 'cut', name: 'write_file', args: { path: 'src/cut.js', content: 'export const total = 41 + 1\n' } }] },
    { content: '', toolCalls: [finishCall('cut-finish', 'Wrote the file')] },
    { content: '', toolCalls: [finishCall('cut-finish-2', 'Wrote the file')] },
    { content: '', toolCalls: [finishCall('cut-finish-3', 'Wrote the file')] },
  ])
  await runAgent({
    task: 'Create src/cut.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  const cut = events.find((event) => event.type === 'tool_result' && event.id === 'cut')
  check('a truncated file fails verification', cut?.ok === false && cut.output.includes('does not match the content'), JSON.stringify(cut))
  check('the file the user is left with is reported, not hidden', workspace.read('src/cut.js').length === 8)
}

console.log('\n8. Approval requirements survive the reliability changes')
{
  const workspace = new VirtualWorkspace()
  const approvals = []
  const { emit } = eventsFor()
  const generate = scriptedCompletion([
    { content: '', toolCalls: [{ id: 'a1', name: 'write_file', args: { path: 'a.js', content: 'a\n' } }] },
    { content: '', toolCalls: [{ id: 'a2', name: 'write_file', args: { path: 'b.js', content: 'b\n' } }] },
    { content: '', toolCalls: [{ id: 'a3', name: 'write_file', args: { path: 'c.js', content: 'c\n' } }] },
    { content: '', toolCalls: [finishCall('a4', 'Created b.js and c.js')] },
  ])
  const result = await runAgent({
    task: 'Create the project files',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: {
      emit,
      requestApproval: async (request) => {
        approvals.push(request.args.path)
        if (request.args.path === 'a.js') return { approved: false, remember: false }
        return { approved: true, remember: true }
      },
    },
  })

  check('every new file was gated before it was written', approvals.slice(0, 2).join(',') === 'a.js,b.js', JSON.stringify(approvals))
  check('a denial stops that write', !workspace.exists('a.js'))
  check('"remember" still avoids a repeat prompt', approvals.length === 2, JSON.stringify(approvals))
  check('approved writes actually happened', workspace.exists('b.js') && workspace.exists('c.js'))
  check('the run can still finish after an approved change', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n9. A full multi-step workflow: create, test, fix, re-test, finish')
{
  const workspace = new VirtualWorkspace({
    'package.json': '{"scripts":{"test":"node test.js"}}',
  })
  const commands = []
  const { events, emit } = eventsFor()
  const generate = scriptedCompletion([
    {
      content: '',
      toolCalls: [{
        id: 'm1',
        name: 'write_file',
        args: { path: 'src/sum.js', content: 'export function sum(a, b) {\n  return a - b\n}\n' },
      }],
    },
    { content: '', toolCalls: [{ id: 'm2', name: 'run_command', args: { command: 'npm test' } }] },
    { content: '', toolCalls: [{ id: 'm3', name: 'edit_file', args: { path: 'src\\sum.js', old_string: 'return a - b', new_string: 'return a + b' } }] },
    { content: '', toolCalls: [{ id: 'm4', name: 'run_command', args: { command: 'npm test' } }] },
    { content: '', toolCalls: [finishCall('m5', 'Fixed sum() and verified with npm test', true)] },
  ])

  const result = await runAgent({
    task: 'Fix the failing sum function',
    workspace,
    provider,
    generate,
    runCommand: async (command) => {
      commands.push(command)
      const failing = workspace.read('src/sum.js').includes('a - b')
      return failing
        ? { exitCode: 1, stdout: '', stderr: 'expected 3, received -1' }
        : { exitCode: 0, stdout: '1 passing', stderr: '' }
    },
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })

  check('the failing test run was reported as failed',
    events.some((event) => event.type === 'tool_result' && event.id === 'm2' && event.ok === false))
  check('the same test command can be re-run after the fix', commands.length === 2, JSON.stringify(commands))
  check('the re-run passed and was reported as ok',
    events.some((event) => event.type === 'tool_result' && event.id === 'm4' && event.ok === true))
  check('the edit applied through the backslash path', workspace.read('src/sum.js').includes('return a + b'))
  check('the workflow finished with a verified result',
    result.status === 'done' && result.summary.includes('npm test'), `${result.status}: ${result.summary}`)
  check('every successful step is in the recorded timeline',
    result.steps.filter((step) => step.ok).length === 3, JSON.stringify(result.steps.map((s) => `${s.name}:${s.ok}`)))
}

console.log('\n10. Repeated no-tool responses stop instead of burning the step budget')
{
  const identical = 'I will inspect the project files now.'
  const generate = scriptedCompletion([
    { content: identical },
    { content: '  i will inspect the project files now!  ' },
    { content: identical },
    { content: identical },
  ])
  const { events, emit } = eventsFor()
  const result = await runAgent({
    task: 'Fix the project',
    workspace: new VirtualWorkspace({ 'main.js': 'export {}\n' }),
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  check('an identical repeated answer ends the run early', result.status === 'failed', result.status)
  check('the stop reason names the repetition', result.summary.includes('kept repeating itself'), result.summary)
  check('it stopped after three identical answers, allowing one forced retry',
    result.summary.includes('3 identical responses'), result.summary)
  check('progress is still visible in the UI',
    events.some((event) => event.type === 'status' && /repeated itself/i.test(event.text)))
}

console.log(`\n${failures === 0 ? 'ALL AGENT-RELIABILITY CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
