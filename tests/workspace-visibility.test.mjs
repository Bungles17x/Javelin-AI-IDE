/**
 * Workspace visibility and task plans.
 *
 * Two claims these tests exist to prove:
 *
 *  A. The agent can SEE the whole project — folders and files, nested — not just one
 *     flat directory level. `get_tree` is the tool that makes this real, and `tree()`
 *     is the mechanism under it.
 *
 *  B. A stated plan becomes a CHECKLIST the UI can tick off, so "what will it do" and
 *     "what has it done" are the same view. `extractPlanSteps` is what makes a plan
 *     actionable rather than decorative.
 */

import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'
import { createStandardToolset, AUTONOMY } from '../src/core/tools.js'
import { extractPlan, extractPlanSteps } from '../src/core/brain.js'
import { createJavelin, EngineRegistry, JavelinMemory } from '../src/core/index.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const NESTED = {
  'README.md': '# Project\n',
  'src/index.js': 'export const x = 1\n',
  'src/lib/util.js': 'export function noop() {}\n',
  'src/lib/deep/nested/thing.js': 'export const deep = true\n',
  'tests/a.test.js': 'test("a", () => {})\n',
}

console.log('\n1. tree() shows folders AND files, nested')
{
  const ws = new VirtualWorkspace(NESTED)
  const tree = ws.tree()

  check('it includes a top-level file', tree.includes('README.md'), tree)
  check('it includes a top-level folder with a trailing slash', /src\//.test(tree), tree)
  check('it nests children under their folder', tree.includes('index.js'), tree)
  check('it shows a folder inside a folder', /lib\//.test(tree), tree)
  check('it reaches deeply nested files', tree.includes('thing.js'), tree)
  check('it does not flatten folders away', tree.split('\n').length >= 5, String(tree.split('\n').length))
}

console.log('\n2. tree() honours a depth limit and says so, rather than truncating silently')
{
  const ws = new VirtualWorkspace(NESTED)
  const shallow = ws.tree('', 1)
  check('a depth-1 tree does not reach the deepest file', !shallow.includes('thing.js'), shallow)
  check('it explains the limit instead of hiding it',
    shallow.includes('depth limit'), shallow)
}

console.log('\n3. tree() can be rooted at a subfolder')
{
  const ws = new VirtualWorkspace(NESTED)
  const sub = ws.tree('src')
  check('a subfolder tree excludes files outside it', !sub.includes('README.md'), sub)
  check('and includes files inside it', sub.includes('index.js'), sub)
}

console.log('\n4. An empty workspace is reported honestly, not as a blank string')
{
  const ws = new VirtualWorkspace({})
  const tree = ws.tree()
  check('an empty workspace says so', /empty/i.test(tree), tree)
}

console.log('\n5. get_tree is a registered, read-only tool the agent can actually call')
{
  const tools = createStandardToolset()
  const tool = tools.get('get_tree')
  check('get_tree exists', Boolean(tool))
  check('it is classified as read-only', tool?.risk === 'read', tool?.risk)
  check('it needs no approval', !tools.requiresApproval('get_tree', {}))
  check('it appears in the schemas sent to the model',
    tools.schemas().some((s) => s.function.name === 'get_tree'))
}

console.log('\n6. get_tree returns a real tree for a real workspace')
{
  const tools = createStandardToolset()
  const ws = new VirtualWorkspace(NESTED)
  const tool = tools.get('get_tree')
  const out = await tool.execute({}, {
    workspace: ws,
    emit: () => { },
  })
  check('the tool succeeded', out.ok, out.output)
  check('the output is a nested tree, not a flat list',
    out.output.includes('src/') && out.output.includes('thing.js'), out.output)
}

console.log('\n7. get_tree degrades gracefully if a workspace cannot build a tree')
{
  const tools = createStandardToolset()
  const ws = new VirtualWorkspace(NESTED)
  // Simulate an older/simpler workspace that only offers list().
  const bare = { list: (dir) => ws.list(dir) }
  const out = await tools.get('get_tree').execute({}, { workspace: bare, emit: () => { } })
  check('it still returns something useful rather than throwing', out.ok, out.output)
  check('and that something names real paths', out.output.includes('src'), out.output)
}

console.log('\n8. extractPlanSteps turns a plan into ordered tasks')
{
  const plan = extractPlan(
    'Here is my plan:\n1. Read calc.js\n2. Fix the operator\n3. Run the tests\n',
  )
  check('extractPlan still returns the raw plan', Boolean(plan), String(plan))

  const steps = extractPlanSteps(plan)
  check('it produces one task per plan step', steps.length === 3, String(steps.length))
  check('the first task is the first step', steps[0] === 'Read calc.js', steps[0])
  check('the last task is the last step', steps[2] === 'Run the tests', steps[2])
}

console.log('\n9. extractPlanSteps handles bullets, bold and blank input')
{
  const steps = extractPlanSteps('- **Investigate** the bug\n- Patch it\n')
  check('bullet lists are parsed', steps.length === 2, String(steps.length))
  check('bold markers are stripped', steps[0] === 'Investigate the bug', steps[0])

  check('null input yields no steps', extractPlanSteps(null).length === 0)
  check('prose without a list yields no steps',
    extractPlanSteps('I will look around and see.').length === 0)
}

console.log('\n10. A real run emits the plan AND its steps together')
{
  const engine = {
    id: 'test-engine',
    label: 'Test engine',
    capabilities: ['tools', 'offline'],
    async probe() {
      return { ok: true }
    },
    async generate() {
      return {
        text: 'Plan:\n1. Look at the code\n2. Change it\n',
        toolCalls: [],
        finishReason: 'stop',
        engineId: 'test-engine',
      }
    },
  }
  const registry = new EngineRegistry()
  registry.register(engine)
  registry.assign('primary', 'test-engine')
  const javelin = createJavelin({ engines: registry, memory: new JavelinMemory() })

  const events = []
  await javelin.think({
    task: 'make a plan',
    workspace: new VirtualWorkspace(NESTED),
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    onEvent: (e) => events.push(e),
    requestApproval: async () => ({ approved: true }),
    autonomy: AUTONOMY.FULL,
    maxSteps: 2,
  })

  const planEvent = events.find((e) => e.type === 'plan')
  check('a plan event was emitted', Boolean(planEvent))
  check('the plan event carries parsed task steps',
    Array.isArray(planEvent?.steps) && planEvent.steps.length === 2,
    JSON.stringify(planEvent?.steps))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)