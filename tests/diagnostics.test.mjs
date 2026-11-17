import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  editorDiagnostics,
  mergeProblems,
  normalizeProblemPath,
  offsetToPosition,
  parseProblems,
  summarizeProblems,
} from '../src/lib/diagnostics.js'

test('Babel reports JavaScript syntax errors without executing the file', () => {
  const problems = editorDiagnostics('javascript', 'const answer = ;\n', 'src/answer.js')
  assert.ok(problems.length >= 1)
  assert.equal(problems[0].severity, 'error')
  assert.equal(problems[0].path, 'src/answer.js')
  assert.equal(problems[0].line, 1)
  assert.match(problems[0].message, /Unexpected token/i)
})

test('Babel parses valid TypeScript and reports malformed type syntax', () => {
  assert.deepEqual(editorDiagnostics('typescript', 'const value: number = 2\n', 'src/value.ts'), [])
  const problems = editorDiagnostics('typescript', 'const value: = 2\n', 'src/value.ts')
  assert.ok(problems.length >= 1)
  assert.equal(problems[0].path, 'src/value.ts')
})

test('JSON diagnostics include a usable line and column', () => {
  const problems = editorDiagnostics('json', '{\n  "answer": ,\n}\n', 'config.json')
  assert.equal(problems.length, 1)
  assert.equal(problems[0].severity, 'error')
  assert.equal(problems[0].line, 2)
  assert.match(problems[0].message, /Unexpected token|Expected/)
})

test('debugger statements are warnings rather than errors', () => {
  const problems = editorDiagnostics('javascript', 'function run() {\n  debugger\n}\n', 'src/run.js')
  assert.equal(problems.length, 1)
  assert.equal(problems[0].severity, 'warning')
  assert.equal(problems[0].line, 2)
})

test('JSONC comments and trailing commas are accepted, including launch.json', () => {
  const valid = '{\n  // launch configuration\n  "configurations": [\n    { "type": "node", },\n  ],\n}\n'
  assert.deepEqual(editorDiagnostics('json', valid, '.vscode/launch.json'), [])
  const malformed = '{\n  // comment\n  "program": ,\n}\n'
  const problems = editorDiagnostics('json', malformed, '.vscode/launch.json')
  assert.equal(problems.length, 1)
  assert.equal(problems[0].line, 3)
})

test('non-JavaScript bracket diagnostics avoid strings and comments', () => {
  const valid = 'def run():\n    text = "("\n    return text\n'
  assert.deepEqual(editorDiagnostics('python', valid, 'run.py'), [])
  const broken = 'def run():\n    return {\n'
  const problems = editorDiagnostics('python', broken, 'run.py')
  assert.equal(problems.length, 1)
  assert.equal(problems[0].line, 2)
  assert.match(problems[0].message, /Unclosed/)
})

test('TypeScript compiler output is parsed with path, line, column and code', () => {
  const problems = parseProblems('src/index.ts(3,7): error TS2322: Type string is not assignable to type number.\n')
  assert.equal(problems.length, 1)
  assert.deepEqual(
    { path: problems[0].path, line: problems[0].line, column: problems[0].column, severity: problems[0].severity, code: problems[0].code },
    { path: 'src/index.ts', line: 3, column: 7, severity: 'error', code: 'TS2322' },
  )
})

test('ESLint stylish output uses the preceding file heading', () => {
  const text = 'src/app.js\n  4:11  error  Unexpected var  no-var\n  8:1  warning  Unexpected console  no-console\n'
  const problems = parseProblems(text, { defaultPath: 'src/app.js' })
  assert.equal(problems.length, 2)
  assert.equal(problems[0].path, 'src/app.js')
  assert.equal(problems[0].line, 4)
  assert.equal(problems[0].code, 'no-var')
  assert.equal(problems[1].severity, 'warning')
})

test('Node stack traces keep the exception message', () => {
  const text = [
    'TypeError: Cannot read properties of undefined (reading "name")',
    '    at loadUser (src/users.js:12:9)',
    '    at src/index.js:4:1',
  ].join('\n')
  const problems = parseProblems(text)
  assert.equal(problems.length, 2)
  assert.equal(problems[0].path, 'src/users.js')
  assert.equal(problems[0].line, 12)
  assert.match(problems[0].message, /Cannot read properties/)
})

test('root-relative paths are normalized and deduplicated', () => {
  assert.equal(normalizeProblemPath('C:\\work\\project\\src\\main.js', 'C:/work/project'), 'src/main.js')
  const first = { path: 'src/a.js', line: 1, column: 1, severity: 'error', message: 'Same', code: '', source: 'tsc' }
  const second = { ...first }
  const result = mergeProblems([first], [second])
  assert.equal(result.length, 1)
  assert.deepEqual(summarizeProblems(result), { errors: 1, warnings: 0, total: 1 })
})

test('offset positions are one-based and handle line starts', () => {
  assert.deepEqual(offsetToPosition('abc\ndef', 0), { line: 1, column: 1 })
  assert.deepEqual(offsetToPosition('abc\ndef', 4), { line: 2, column: 1 })
  assert.deepEqual(offsetToPosition('abc\ndef', 6), { line: 2, column: 3 })
})
