import {
  estimateTokens,
  formatTokenCount,
  MEMBER_TOKEN_LIMIT,
  tokensForExchange,
  tokensFromUsage,
} from '../src/lib/usage.js'
import { readStream } from '../src/lib/providers.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Allowance and formatting')
check('signed-in accounts get 100 million tokens', MEMBER_TOKEN_LIMIT === 100_000_000)
check('the allowance is readable', formatTokenCount(MEMBER_TOKEN_LIMIT) === '100,000,000')
check('remaining usage never renders negative', formatTokenCount(-5) === '0')

console.log('\n2. Provider usage')
check('prompt and completion tokens are summed', tokensFromUsage({ prompt_tokens: 120, completion_tokens: 30 }) === 150)
check('a total token count wins when present', tokensFromUsage({ total_tokens: 400, prompt_tokens: 1, completion_tokens: 1 }) === 400)
check('missing usage is zero', tokensFromUsage(null) === 0)
check('fallback estimates use the crossed text', tokensForExchange({ usage: null, inputTokens: 100, outputTokens: 25 }) === 125)
check('four characters are roughly one token', estimateTokens('12345678') === 2)

console.log('\n3. Stream usage is preserved')
const stream = new Response(
  'data: ' + JSON.stringify({
    choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 2 },
  }) + '\n\ndata: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
)
const result = await readStream(stream)
check('the streamed answer is returned', result.content === 'hello')
check('the stream keeps the provider usage', result.usage?.prompt_tokens === 12 && result.usage?.completion_tokens === 2)

if (failures) {
  console.error(`\n${failures} token usage check(s) failed.`)
  process.exit(1)
}
console.log('\nALL TOKEN USAGE CHECKS PASSED\n')
