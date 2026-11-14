/**
 * Files a task explicitly names.
 *
 * A model that writes one of two requested files and then narrates "done" has not
 * finished the job. The requested paths give the engine something objective to check
 * before it accepts `finish` or a prose summary — no guessing about intent.
 *
 * Only tokens that look like a real file path (a directory-relative name with a known
 * source/data extension) are treated as required. Commands (`npm test`), versions and
 * prose are ignored.
 */

import { normalizeToolPath } from '../lib/agentTools.js'

const FILE_EXTENSIONS =
  'js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|markdown|css|scss|sass|less|html|htm|py|rb|go|rs|java|kt|kts|cs|php|sh|ps1|bat|yml|yaml|toml|ini|cfg|xml|sql|txt|csv|env|gitignore'

/** A path may appear anywhere, but must not be glued to another word. */
const PATH_PATTERN = new RegExp(
  `(?:^|[\\s\`'"([{,:])` + // boundary
    `((?:[\\w.-]+\\/)*[\\w.-]+\\.(?:${FILE_EXTENSIONS}))` + // path/with/file.ext
    `(?=$|[\\s\`'"),;:!?}])`,
  'gi',
)

/**
 * Paths the task names, normalised. Absolute paths, URLs and `..` traversal are
 * dropped: they are not things the agent may create inside a workspace.
 */
export function requestedPaths(task) {
  const text = String(task ?? '')
  const found = new Set()
  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1]
    if (!raw) continue
    if (/^https?:/i.test(raw)) continue
    if (/^[a-z]:[\\/]/i.test(raw)) continue
    const path = normalizeToolPath(raw)
    if (!path || path.includes('..') || path.startsWith('/')) continue
    found.add(path)
  }
  return [...found]
}

/** Which of the named files do not exist in the workspace yet. */
export async function missingRequestedPaths(task, workspace) {
  const missing = []
  for (const path of requestedPaths(task)) {
    let exists = false
    try {
      exists = Boolean(await workspace.exists(path))
    } catch {
      exists = false
    }
    if (!exists) missing.push(path)
  }
  return missing
}
