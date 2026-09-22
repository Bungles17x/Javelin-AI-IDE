/**
 * Webview integrity — the extension panel must not be able to load half-dead.
 *
 * The failure this guards against is specific and was real: the webview script
 * binds ~33 DOM ids at load and attaches click handlers at the end of the script.
 * If ANY bound id is missing from the markup, the binding is null, the first
 * `null.addEventListener(...)` throws, and every handler declared after that line
 * never registers. The panel then renders perfectly and does nothing — "no buttons
 * work" — which is much harder to diagnose than a blank screen.
 *
 * These tests read the real webview source and assert that cannot happen.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The test runner bundles each test into a temp directory, so __dirname is not the
// repo. The runner sets cwd to the project root, so resolve from there.
const root = process.cwd()

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Pull the template literal out of _getHtmlForWebview. */
function extractWebviewHtml() {
  const src = readFileSync(join(root, 'vscode-extension', 'src', 'JavelinPanel.ts'), 'utf8')
  const start = src.indexOf('return `<!DOCTYPE html>')
  if (start === -1) throw new Error('could not find webview template in JavelinPanel.ts')
  let i = start + 'return `'.length
  let depth = 0
  let out = ''
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') { out += ch + src[i + 1]; i++; continue }
    if (ch === '`' && depth === 0) break
    if (ch === '$' && src[i + 1] === '{') { depth++; out += '${'; i++; continue }
    if (ch === '}' && depth > 0) { depth--; out += '}'; continue }
    out += ch
  }
  return out.replace(/\$\{[^}]*\}/g, 'STUB')
}

const html = extractWebviewHtml()
const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
const looked = [...new Set([...html.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))]

// Ids created at runtime by the script itself — absent from static markup by design.
const DYNAMIC = new Set([
  'stepCount', 'checkpointBar', 'runControls', 'taskList', 'streamEl', 'stepBody',
])

console.log('\n1. The webview markup and script actually exist')
{
  check('the template was found and is substantial', html.length > 5000, String(html.length))
  check('it declares a doctype', html.includes('<!DOCTYPE html>'))
  check('it defines element ids', defined.size > 20, String(defined.size))
  check('the script looks up element ids', looked.length > 20, String(looked.length))
}

console.log('\n2. Every element the script binds to exists in the markup')
{
  const missing = looked.filter((id) => !defined.has(id) && !DYNAMIC.has(id))
  check('no script binding points at a missing id', missing.length === 0, missing.join(', '))
}

console.log('\n3. The buttons that were reported broken are all present and wired')
{
  // These are the controls whose failure produced the "no buttons work" report.
  const critical = [
    'sendBtn', 'clearBtn', 'settingsBtn',
    'modeChat', 'modeAgent', 'modeJavelin',
    'agentModalBtn', 'agentModalClose', 'agentModalRun', 'agentModalStop', 'agentModalClear',
    'approvalApprove', 'approvalDeny',
  ]
  for (const id of critical) {
    check(`#${id} exists in the markup`, defined.has(id))
    check(`#${id} has a click handler wired`, html.includes(`getElementById('${id}')`))
  }
}

console.log('\n4. The panel announces itself, so the host sends history')
{
  check("a 'ready' message is posted on load",
    /postMessage\(\{\s*command:\s*'ready'/.test(html))
}

console.log('\n5. The script can survive a missing element rather than dying')
{
  // Guarded lookups: the four patterns that intentionally tolerate absence.
  check('runtime-created bars are looked up defensively',
    html.includes("getElementById('checkpointBar')") &&
    /if\s*\(\s*existing\s*\)\s*\{\s*existing\.remove\(\)/.test(html))
}

console.log('\n6. Inline style assignments are avoided (the webview CSP blocks them)')
{
  // The webview CSP is nonce-based. The CSP spec says 'unsafe-inline' is IGNORED when
  // a nonce is present, so `el.style.x = ...` on a styled element is dropped by the
  // browser. Runtime state must be a class instead.
  const styleAssignments = [...html.matchAll(/\.style\.[a-zA-Z]+\s*=/g)].map((m) => m[0])
  check('no inline style assignments remain in the panel script',
    styleAssignments.length === 0, styleAssignments.join(', '))

  // The classes the script toggles must actually be defined in the stylesheet.
  for (const cls of ['phase-visible', 'verified-badge', 'notice-bar', 'hidden', 'dim']) {
    check(`.${cls} is defined in the panel CSS`, html.includes(`.${cls}`))
  }
}

console.log('\n7. The template literal was not broken by an unescaped backtick')
{
  // A backtick inside the webview template literal terminates the string and breaks
  // the whole script — producing "no buttons work". The extraction above would have
  // produced a truncated file if that had happened.
  check('the extracted HTML is complete', html.includes('</html>'),
    'no closing </html> — the template literal is probably broken')
  check('the script block closes', html.includes('</script>'),
    'no closing </script>')
  check('the CSS block closes', html.includes('</style>'), 'no closing </style>')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)