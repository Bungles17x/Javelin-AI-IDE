import {
  classifyMessage,
  isConversational,
  withConversationContext,
  isEcho,
  CONVERSATION_STYLE,
} from '../src/core/conversation.js'
import { SYSTEM_PROMPT } from '../src/lib/ai.js'
import { MODEL_IDENTITY } from '../src/core/identity.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Short conversational messages are recognised')
check('a greeting is conversational', isConversational('hi'))
check('"lol" is laughter, not a task', classifyMessage('lol').kind === 'laugh')
check('"lmao" is laughter', isConversational('lmao 😂'))
check('"you?" is a reaction to the thread', classifyMessage('you?').kind === 'reaction')
check('"why?" is a reaction, not a request', classifyMessage('why?').kind === 'reaction')
check('"really?" is a reaction', classifyMessage('really?').kind === 'reaction')
check('"same" continues the conversation', isConversational('same'))
check('"thanks" is appreciated', classifyMessage('thanks!').kind === 'thanks')
check('"who are you?" is an identity question', classifyMessage('who are you?').kind === 'identity')
check('"I\'m dying" reads as a joke, not an emergency', classifyMessage("I'm dying 😂").kind === 'laugh')

console.log('\n2. Real work is never mistaken for chat')
check('a bug fix is a task', classifyMessage('fix the login bug').kind === 'task')
check('a friendly request with a verb is still a task', classifyMessage('hey can you fix this').kind === 'task')
check('a question about a file is a task', classifyMessage('why does src/auth.js throw?').kind === 'task')
check('a build request is a task', classifyMessage('build the project').kind === 'task')

console.log('\n3. Short messages resolve against the thread')
const history = [
  { role: 'user', content: 'Why is my fetch returning undefined?' },
  { role: 'assistant', content: 'Because response.json() is async and you forgot to await it.' },
]
const resolved = withConversationContext('why?', history)
check('a bare "why?" carries the previous exchange', resolved.includes('response.json()'))
check('the user\'s words are kept intact', resolved.startsWith('why?'))
check('no context is invented without a history', withConversationContext('why?', []) === 'why?')
check('a greeting is not dressed up as context', withConversationContext('hi', history) === 'hi')

console.log('\n4. Repeating the user is detectable')
check('an exact echo is caught', isEcho('hi', 'hi') === true)
check('a real greeting reply is not an echo', isEcho('Hi! What are you building?', 'hi') === false)
check('a full answer is not an echo', isEcho('Use await on response.json().', 'why?') === false)
check('echo ignores case and punctuation', isEcho('LOL!', 'lol') === true)

console.log('\n5. The conversation layer sits alongside the engineering identity')
check('style forbids echoing the user', /repeating their message back/i.test(CONVERSATION_STYLE))
check('style covers humour as figurative', /figurative/i.test(CONVERSATION_STYLE))
check('style forbids refusing harmless messages', /Never refuse a harmless message/i.test(CONVERSATION_STYLE))
check('chat prompt still contains the engineering identity', SYSTEM_PROMPT.includes(MODEL_IDENTITY.slice(0, 60)))
check('chat prompt keeps the verify-before-claiming standard', /VERIFY, DO NOT ASSUME/.test(SYSTEM_PROMPT))
check('chat prompt now includes the conversation rules', SYSTEM_PROMPT.includes(CONVERSATION_STYLE))
check('identity mentions being good company', /good company/i.test(MODEL_IDENTITY))

console.log(`\n${failures === 0 ? 'ALL CONVERSATION CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
