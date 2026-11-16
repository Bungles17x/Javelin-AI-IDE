import { isLongForm, plainTextFromMarkdown, shouldUseMarkdown } from '../src/lib/responseFormat.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Normal conversation stays plain')
check('a short answer is plain', shouldUseMarkdown('Hello there. How can I help?') === false)
check('bold syntax alone does not force rich text', shouldUseMarkdown('This is **important**.') === false)
check('a short multi-paragraph answer is plain', shouldUseMarkdown('First paragraph.\n\nSecond paragraph.') === false)

console.log('\n2. Code gets Markdown and copy controls')
check('a fenced code block is rich', shouldUseMarkdown('Try this:\n```js\nconsole.log(1)\n```') === true)
check('inline code is rich', shouldUseMarkdown('Run `npm test` before shipping.') === true)

console.log('\n3. Essays and explicit requests get rich text')
const essay = `${'A considered sentence about the subject. '.repeat(40)}\n\n${'A second paragraph develops the argument. '.repeat(40)}`
check('a long multi-paragraph essay is rich', isLongForm(essay) && shouldUseMarkdown(essay) === true)
check('a request for Markdown is rich', shouldUseMarkdown('Here is the answer.', 'Please use Markdown') === true)
check('a request for an essay is rich', shouldUseMarkdown('Here is the answer.', 'Write an essay about it') === true)
check('a request for copyable output is rich', shouldUseMarkdown('Here is the answer.', 'Make this copyable') === true)
check('a request for code is rich', shouldUseMarkdown('Here is the answer.', 'Write a script for this') === true)

console.log('\n4. Plain rendering removes decoration but keeps the words')
const plain = plainTextFromMarkdown('## Update\n\n**Bold** and *italic* with [docs](https://example.com).')
check('headings lose their hashes', !plain.includes('##'))
check('bold and italic markers are removed', !plain.includes('**') && !plain.includes('*italic*'))
check('link text and destination are kept', plain.includes('Bold') && plain.includes('docs (https://example.com)'))
check('multiplication is not mistaken for italic markup', plainTextFromMarkdown('2 * 3 * 4') === '2 * 3 * 4')

console.log(`\n${failures === 0 ? 'ALL RESPONSE FORMAT CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)