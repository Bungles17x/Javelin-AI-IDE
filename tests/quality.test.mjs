import {
  IDENTITY_TRAINING_PROMPT,
  IDENTITY_VERSION,
  MODEL_IDENTITY,
  identityFingerprint,
  renderModelIdentity,
} from '../src/core/identity.js'
import { QUALITY_CONTRACT } from '../src/core/quality.js'
import { SYSTEM_PROMPT } from '../src/lib/ai.js'
import { AGENT_SYSTEM_PROMPT } from '../src/engine/reasoning.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Javelin has a distinct voice')
check('it refuses to be a generic assistant', /not a generic assistant wearing a different name/i.test(MODEL_IDENTITY))
check('it is direct and allergic to filler', /direct, grounded/i.test(MODEL_IDENTITY) && /allergic to filler/i.test(MODEL_IDENTITY))
check('it answers before explaining', /answer first/i.test(MODEL_IDENTITY))
check('it does not flatter', /no\s+flattery/i.test(MODEL_IDENTITY))
check('it disagrees with bad premises', /disagree when the evidence says so/i.test(MODEL_IDENTITY))
check('it keeps its warmth and humour', /good company/i.test(MODEL_IDENTITY) && /dry humour/i.test(MODEL_IDENTITY))

console.log('\n2. The quality bar is explicit and shared')
check('the contract exists', QUALITY_CONTRACT.length > 500)
check('it demands one recommendation, not a menu', /recommend one option/i.test(QUALITY_CONTRACT))
check('it forbids invented facts', /Never invent an API/i.test(QUALITY_CONTRACT))
check('it separates observation from inference', /observed from what you inferred/i.test(QUALITY_CONTRACT))
check('it asks for the simpler answer', /simpler, more direct version/i.test(QUALITY_CONTRACT))
check('it uses a senior-engineer test', /Would a senior engineer trust this/i.test(QUALITY_CONTRACT))
check('the identity contains the contract', renderModelIdentity().includes(QUALITY_CONTRACT))
check('the training target contains the contract', IDENTITY_TRAINING_PROMPT.includes(QUALITY_CONTRACT))
check('chat uses the contract', SYSTEM_PROMPT.includes(QUALITY_CONTRACT))
check('agent mode uses the contract', AGENT_SYSTEM_PROMPT.includes(QUALITY_CONTRACT))

console.log('\n3. Agent and chat share the same character')
check('agent mode includes the identity', AGENT_SYSTEM_PROMPT.includes(MODEL_IDENTITY.slice(0, 60)))
check('agent mode names its mode', /AGENT MODE/.test(AGENT_SYSTEM_PROMPT))
check('the identity still names no tools', ['read_file', 'edit_file', 'run_command', 'list_files'].every((name) => !MODEL_IDENTITY.includes(name)))
check('the identity is versioned after the change', IDENTITY_VERSION === '1.1.0')
check('the fingerprint is stable', identityFingerprint() === identityFingerprint())

console.log(`\n${failures === 0 ? 'ALL QUALITY CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
