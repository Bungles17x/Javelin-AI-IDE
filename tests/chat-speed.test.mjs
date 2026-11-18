import { CHAT_MAX_OUTPUT_TOKENS, LOCAL_CHAT_MAX_OUTPUT_TOKENS, streamChat, trimChatHistory } from '../src/lib/ai.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Chat history is bounded by turns and characters')
{
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
  }))
  const kept = trimChatHistory(messages)
  check('only the newest 16 messages are kept', kept.length === 16, String(kept.length))
  check('the oldest kept turn is the expected one', kept[0]?.content === 'message 4', kept[0]?.content)

  const large = Array.from({ length: 5 }, () => ({
    role: 'user',
    content: 'x'.repeat(10_000),
  }))
  const bounded = trimChatHistory(large)
  check('the character budget stops older turns', bounded.length === 3, String(bounded.length))

  const oversized = trimChatHistory([{ role: 'user', content: 'x'.repeat(40_000) }])
  check('the newest message is never dropped', oversized.length === 1, String(oversized.length))
}

console.log('\n2. Chat requests carry a short output budget')
{
  const originalFetch = globalThis.fetch
  let captured = null
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) }
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  try {
    await streamChat({
      providerId: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('hosted chat gets the hosted response cap', captured.body.max_tokens === CHAT_MAX_OUTPUT_TOKENS, String(captured.body.max_tokens))
    check('only the newest turns reach the request', captured.body.messages.length <= 17, String(captured.body.messages.length))

    await streamChat({
      providerId: 'javelin',
      model: 'javelin-coder:latest',
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('local chat gets the smaller local cap', captured.body.max_tokens === LOCAL_CHAT_MAX_OUTPUT_TOKENS, String(captured.body.max_tokens))
  } finally {
    globalThis.fetch = originalFetch
  }
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
