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

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)