/**
 * End-to-end test of the agent loop with a scripted fake model.
 *
 * We stub global fetch so streamCompletion returns canned SSE with tool calls,
 * then assert the loop's behaviour: approval gating, failure memory (no repeat of
 * a failed call), edit application, and honest finish reporting.
 */

import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`) }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** Build an SSE body from a scripted list of steps. */
function sseFor({ content = '', toolCalls = [] }) {
  const chunks = []
  const delta = { role: 'assistant' }
  if (content) { delta.content = content }
  if (toolCalls.length) {
    delta.tool_calls = toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }))
  }
  chunks.push(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
  chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  chunks.push('data: [DONE]\n\n')
  return chunks.join('')
}

function delCall(id, path) {
  return { id, name: 'delete_file', args: { path, reason: 'obsolete' } }
}

function finishCall(id, summary) {
  return { id, name: 'finish', args: { summary, verified: false } }
}

function mockFetch(script) {
  let call = 0
  return async () => {
    const step = script[Math.min(call, script.length - 1)]
    call++
    const body = sseFor(step)
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let sent = false
          return {
            async read() {
              if (sent) { return { done: true } }
              sent = true
              return { value: new TextEncoder().encode(body), done: false }
            },
            releaseLock() { },
          }
        },
      },
    }
  }
}

// The agent imports streamCompletion from providers, which uses global fetch.
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

globalThis.fetch = mockFetch(script)

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
  globalThis.fetch = mockFetch(deleteScript)

  const deleteEvents = []
  let approvalsForDelete = 0
  const wsDelete = new VirtualWorkspace({ 'old.js': 'obsolete\n', 'keep.js': 'keep\n' })

  await runAgent({
    task: 'Delete the obsolete file',
    workspace: wsDelete,
    provider: { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' },
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

console.log(`\n${failures === 0 ? 'ALL AGENT-LOOP CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
