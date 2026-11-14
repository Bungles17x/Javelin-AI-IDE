/**
 * Local owner access and guest quota invariants.
 *
 * The owner screen is a local gate, but the credential must still be stored as a
 * salted hash and must never accept a wrong passphrase.
 */

import {
  createOwnerCredential, GUEST_DAILY_LIMIT, OWNER_USERNAME, todayKey, verifyOwnerPassphrase,
} from '../src/lib/ownerAuth.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Owner credential creation')
const credential = await createOwnerCredential('correct horse battery staple')
check('the fixed owner name is used', credential.username === OWNER_USERNAME)
check('the passphrase is not stored in the credential', !JSON.stringify(credential).includes('correct horse'))
check('a salt is stored', typeof credential.salt === 'string' && credential.salt.length >= 16)
check('a hash is stored', typeof credential.hash === 'string' && credential.hash.length >= 32)
check('PBKDF2 iterations are recorded', credential.iterations >= 100_000)

console.log('\n2. Verification')
check('the right passphrase is accepted', await verifyOwnerPassphrase(credential, 'correct horse battery staple'))
check('a wrong passphrase is refused', !(await verifyOwnerPassphrase(credential, 'wrong passphrase')))
check('an empty passphrase is refused', !(await verifyOwnerPassphrase(credential, '')))
check('missing credential data is refused', !(await verifyOwnerPassphrase({}, 'anything')))

console.log('\n3. Credentials are salted independently')
const second = await createOwnerCredential('correct horse battery staple')
check('two credentials use different salts', credential.salt !== second.salt)
check('two credentials store different hashes', credential.hash !== second.hash)
check('both still verify', await verifyOwnerPassphrase(second, 'correct horse battery staple'))

console.log('\n4. Setup rules')
let shortRefused = false
try {
  await createOwnerCredential('short')
} catch {
  shortRefused = true
}
check('short owner passphrases are refused', shortRefused)
check('guest allowance is a positive daily limit', GUEST_DAILY_LIMIT > 0)
check('usage keys use the local calendar day', todayKey(new Date(2026, 10, 13, 12, 0, 0)) === '2026-11-13')

if (failures) {
  console.error(`\n${failures} owner access check(s) failed.`)
  process.exit(1)
}
console.log('\nALL OWNER ACCESS CHECKS PASSED\n')
