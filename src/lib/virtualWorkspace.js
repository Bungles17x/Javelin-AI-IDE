/**
 * Virtual workspace for the web app.
 *
 * A browser page cannot read or write your real project directory. Rather than
 * pretend otherwise, the web build hands the agent an explicit, in-memory
 * workspace. You seed it by importing real files (paste / drag a folder / "load my
 * repo" JSON), and every edit the agent makes is a real, reviewable diff against
 * that snapshot that you can export back out.
 *
 * The VS Code build uses the real filesystem instead — see the same interface
 * implemented over `vscode.workspace.fs` there. The agent loop is unchanged because
 * both satisfy this interface.
 */

import { computeDiff, normalizeToolPath, PATH_ARGUMENTS } from './agentTools.js'

const MAX_FILE_SIZE = 2_000_000 // 2MB limit per file
const MAX_TOTAL_SIZE = 50_000_000 // 50MB total workspace limit

export class VirtualWorkspace {
  /** @param {Record<string, string>} [files] path -> content */
  constructor(files = {}, directories = []) {
    this.files = new Map()
    this.directories = new Set()
    this.checkpoints = []

    for (const directory of directories) this.addParentDirectories(directory, true)

    // Validate and set files with size limits
    let totalSize = 0
    for (const [rawPath, rawContent] of Object.entries(files)) {
      const path = normalizeToolPath(rawPath)
      const content = String(rawContent ?? '')
      if (!path) continue
      if (content.length > MAX_FILE_SIZE) {
        console.warn(`File ${path} exceeds size limit (${MAX_FILE_SIZE} bytes), skipping`)
        continue
      }

      if (totalSize + content.length > MAX_TOTAL_SIZE) {
        console.warn(`Workspace size limit reached, skipping ${path}`)
        continue
      }
      this.files.set(path, content)
      this.addParentDirectories(path)
      totalSize += content.length
    }
  }

  addParentDirectories(path, includeSelf = false) {
    const parts = normalizeWorkspacePath(path).split('/')
    const limit = includeSelf ? parts.length : parts.length - 1
    let current = ''
    for (const part of parts.slice(0, limit)) {
      current = current ? `${current}/${part}` : part
      this.directories.add(current)
    }
  }

  /**
   * Resolve a model-supplied path to a workspace-relative path.
   *
   * Models routinely send `./src/app.js`, `src\\app.js`, or an absolute path from
   * their own guess at where the project lives. All of those mean the same file, so
   * they are canonicalised here instead of failing with "File not found" and letting
   * the agent burn steps on a path it already wrote.
   */
  resolvePath(path) {
    if (typeof path !== 'string' || !path.trim()) {
      throw new Error('Path must be a non-empty string.')
    }
    const cleaned = normalizeToolPath(path)
    if (isAbsoluteWorkspacePath(cleaned)) {
      const recovered = this.matchExistingSuffix(cleaned)
      if (recovered) return recovered
      throw new Error(
        `Path must stay inside the workspace: ${path}. Use a path relative to the project root, for example "src/app.js".`,
      )
    }
    return normalizeWorkspacePath(cleaned)
  }

  /**
   * Recover the workspace-relative tail of an absolute path, longest match first.
   * `C:/Users/dev/project/src/app.js` resolves to `src/app.js` when that file exists.
   */
  matchExistingSuffix(absolutePath) {
    const parts = absolutePath.replace(/^[a-z]:/i, '').split('/').filter(Boolean)
    if (parts.some((part) => part === '..')) return null
    for (let start = 0; start < parts.length; start++) {
      const candidate = parts.slice(start).join('/')
      if (this.files.has(candidate) || this.directories.has(candidate)) return candidate
    }
    return null
  }

  list(dir = '') {
    if (dir) dir = this.resolvePath(dir)
    const prefix = dir && !dir.endsWith('/') ? `${dir}/` : dir
    const entries = new Map()
    const add = (path, type) => {
      if (!path.startsWith(prefix)) return
      const rest = path.slice(prefix.length)
      if (!rest) return
      const slash = rest.indexOf('/')
      const childPath = slash === -1 ? path : `${prefix}${rest.slice(0, slash)}`
      const childType = slash === -1 ? type : 'dir'
      entries.set(childPath, { path: childPath, type: childType })
    }
    for (const path of this.directories) add(path, 'dir')
    for (const path of this.files.keys()) add(path, 'file')
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * The whole project as an indented tree — nested folders AND files.
   *
   * `list` shows one level at a time, which makes the agent guess at structure.
   * This walks the full tree in one call so it can see how the project is actually
   * laid out before touching anything.
   *
   * @param {string} [dir] subfolder to root at
   * @param {number} [maxDepth] how deep to walk
   */
  tree(dir = '', maxDepth = 6) {
    if (dir) dir = this.resolvePath(dir)
    const prefix = dir && !dir.endsWith('/') ? `${dir}/` : dir
    // Build the nested shape from the flat path -> content map.
    const root = { dirs: new Map(), files: [] }
    const ensureDirectory = (parts) => {
      let node = root
      for (const name of parts) {
        if (!node.dirs.has(name)) node.dirs.set(name, { dirs: new Map(), files: [] })
        node = node.dirs.get(name)
      }
      return node
    }
    for (const path of this.directories) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest) ensureDirectory(rest.split('/'))
    }
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (!rest) continue
      const parts = rest.split('/')
      let node = root
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.dirs.has(parts[i])) {
          node.dirs.set(parts[i], { dirs: new Map(), files: [] })
        }
        node = node.dirs.get(parts[i])
      }
      node.files.push(parts[parts.length - 1])
    }

    const out = []
    const walk = (node, depth, pad) => {
      const dirs = [...node.dirs.keys()].sort()
      const files = [...node.files].sort()
      const entries = [
        ...dirs.map((name) => ({ name, isDir: true })),
        ...files.map((name) => ({ name, isDir: false })),
      ]
      entries.forEach((entry, i) => {
        const last = i === entries.length - 1
        out.push(`${pad}${last ? '\u2514\u2500 ' : '\u251c\u2500 '}${entry.name}${entry.isDir ? '/' : ''}`)
        if (entry.isDir) {
          if (depth + 1 >= maxDepth) {
            out.push(`${pad}${last ? '   ' : '\u2502  '}\u2514\u2500 \u2026 (depth limit)`)
          } else {
            walk(node.dirs.get(entry.name), depth + 1, `${pad}${last ? '   ' : '\u2502  '}`)
          }
        }
      })
    }
    walk(root, 0, '')
    return out.length ? out.join('\n') : '(empty workspace) \u2014 no files or folders to show.'
  }

  read(path, start, end) {
    path = this.resolvePath(path)
    if (!this.files.has(path)) {
      throw new Error(`File not found: ${path}. Use list_files to see what exists.`)
    }
    const content = this.files.get(path)
    if (start == null && end == null) return content
    const lines = content.split('\n')
    const from = Math.max(0, (start ?? 1) - 1)
    const to = end == null ? lines.length : end
    if (from >= lines.length) {
      throw new Error(`Start line ${start} is beyond file length (${lines.length} lines).`)
    }
    if (to < from) {
      throw new Error(`End line ${end} must be greater than start line ${start}.`)
    }
    return lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join('\n')
  }

  exists(path) {
    try {
      return this.files.has(this.resolvePath(path))
    } catch {
      return false
    }
  }

  /**
   * Compute what an operation WOULD do, without applying it. Used by the approval
   * dialog so the user sees the real diff before consenting.
   */
  preview(name, args) {
    try {
      args = { ...(args ?? {}) }
      for (const key of PATH_ARGUMENTS[name] ?? []) {
        if (typeof args[key] === 'string' && args[key].trim()) args[key] = this.resolvePath(args[key])
      }
      if (name === 'write_file') {
        const before = this.files.get(args.path) ?? ''
        return { diff: computeDiff(before, args.content ?? '') }
      }
      if (name === 'edit_file') {
        const before = this.files.get(args.path)
        if (before == null) return { diff: null, error: `File not found: ${args.path}` }
        const indexes = findOccurrences(before, args.old_string)
        if (indexes.length === 0) return { diff: null, error: `old_string not found in ${args.path}.` }
        if (args.replace_all && args.occurrence != null) {
          return { diff: null, error: 'Use either occurrence or replace_all, not both.' }
        }
        if (args.occurrence != null && (!Number.isInteger(args.occurrence) || args.occurrence < 1 || args.occurrence > indexes.length)) {
          return { diff: null, error: `occurrence must be between 1 and ${indexes.length} for this snippet in ${args.path}.` }
        }
        if (indexes.length > 1 && !args.replace_all && args.occurrence == null) {
          return {
            diff: null,
            error: `old_string appears ${indexes.length} times in ${args.path}. Choose the intended match after inspecting its context, then retry with occurrence: N (1-based), or provide more surrounding text. Matches: ${formatOccurrenceContexts(before, indexes).join('; ')}`,
          }
        }
        const index = args.occurrence == null ? indexes[0] : indexes[args.occurrence - 1]
        const after = args.replace_all
          ? before.split(args.old_string).join(args.new_string)
          : index == null
            ? before
            : before.slice(0, index) + args.new_string + before.slice(index + args.old_string.length)
        return { diff: computeDiff(before, after) }
      }
      if (name === 'delete_file') {
        const before = this.files.get(args.path)
        if (before == null) return { diff: null, error: `File not found: ${args.path}` }
        // A deletion is a diff that removes every line, so the approval dialog can
        // show exactly what would be lost before the user consents.
        return { diff: computeDiff(before, ''), deletes: true }
      }
      if (name === 'rename_file') {
        const before = this.files.get(args.old_path)
        if (before == null) return { diff: null, error: `File not found: ${args.old_path}` }
        if (this.files.has(args.new_path)) return { diff: null, error: `Target already exists: ${args.new_path}` }
        // Rename doesn't change content, just location
        return { diff: { lines: [], added: 0, removed: 0 }, rename: true, old_path: args.old_path, new_path: args.new_path }
      }
      if (name === 'copy_file') {
        const before = this.files.get(args.source_path)
        if (before == null) return { diff: null, error: `Source not found: ${args.source_path}` }
        if (this.files.has(args.dest_path)) return { diff: null, error: `Target already exists: ${args.dest_path}` }
        // Copy creates a new file with same content
        return { diff: computeDiff('', before), copy: true, source_path: args.source_path, dest_path: args.dest_path }
      }
    } catch {
      return { diff: null }
    }
    return { diff: null }
  }

  search(query, isRegex = false) {
    const re = isRegex ? new RegExp(query, 'i') : null
    const needle = isRegex ? null : query.toLowerCase()
    const hits = []
    let filesSearched = 0
    const MAX_FILES_TO_SEARCH = 100 // Limit search to avoid performance issues

    for (const [path, content] of this.files) {
      if (filesSearched >= MAX_FILES_TO_SEARCH) break
      filesSearched++

      // Skip very large files in search
      if (content.length > 500_000) {
        hits.push({ path, line: 0, text: '(file too large to search efficiently)' })
        continue
      }

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const match = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle)
        if (match) hits.push({ path, line: i + 1, text: lines[i].trim().slice(0, 200) })
        if (hits.length >= 200) return hits
      }
    }
    return hits
  }

  /** Full-file write. Refuses to clobber an existing file unless overwrite is set. */
  write(path, content, overwrite = false) {
    if (!path || typeof path !== 'string') {
      throw new Error('File path must be a non-empty string.')
    }
    if (content == null) {
      throw new Error('File content cannot be null or undefined.')
    }
    const normalized = this.resolvePath(path)
    if (this.directories.has(normalized)) {
      throw new Error(`A directory already exists at ${normalized}.`)
    }
    const parts = normalized.split('/')
    let parent = ''
    for (const part of parts.slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part
      if (this.files.has(parent)) throw new Error(`A file already exists at ${parent}.`)
    }
    if (this.files.has(normalized) && !overwrite) {
      throw new Error(
        `File "${normalized}" already exists. Use edit_file for targeted changes, or pass overwrite: true if you truly mean to replace the whole file.`,
      )
    }
    const before = this.files.get(normalized) ?? ''
    this.addParentDirectories(normalized)
    this.files.set(normalized, content)
    return { path: normalized, before, after: content, diff: computeDiff(before, content), action: 'write' }
  }

  /**
   * Append text to a file, creating it if it does not exist yet.
   *
   * This is how a large file gets built when the model cannot emit it in one call:
   * each chunk is a small, verifiable write instead of one truncated file.
   */
  append(path, content) {
    const normalized = this.resolvePath(path)
    if (content == null) {
      throw new Error('File content cannot be null or undefined.')
    }
    const before = this.files.get(normalized) ?? ''
    return this.write(normalized, before + String(content), true)
  }

  /** Targeted snippet replacement — the safe default for modifying existing code. */
  edit(path, oldString, newString, replaceAll = false, occurrence) {
    path = this.resolvePath(path)
    if (oldString == null || newString == null) {
      throw new Error('old_string and new_string cannot be null or undefined.')
    }
    if (!this.files.has(path)) {
      throw new Error(`File not found: ${path}. Use write_file to create it.`)
    }
    const before = this.files.get(path)
    if (oldString === newString) {
      throw new Error('old_string and new_string are identical — nothing to change.')
    }
    if (replaceAll && occurrence != null) {
      throw new Error('Use either occurrence or replace_all, not both.')
    }

    const indexes = findOccurrences(before, oldString)
    if (indexes.length === 0) {
      throw new Error(
        `old_string not found in ${path}. It must match the file exactly, including indentation. Read the file and copy the snippet verbatim.`,
      )
    }
    if (occurrence != null && (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > indexes.length)) {
      throw new Error(`occurrence must be between 1 and ${indexes.length} for this snippet in ${path}.`)
    }
    if (indexes.length > 1 && !replaceAll && occurrence == null) {
      throw new Error(
        `old_string appears ${indexes.length} times in ${path}. Choose the intended match after inspecting its context, then retry with occurrence: N (1-based), or provide more surrounding text. Matches: ${formatOccurrenceContexts(before, indexes).join('; ')}`,
      )
    }

    let after
    if (replaceAll) {
      after = before.split(oldString).join(newString)
    } else {
      const index = occurrence == null ? indexes[0] : indexes[occurrence - 1]
      after = before.slice(0, index) + newString + before.slice(index + oldString.length)
    }
    this.files.set(path, after)
    return { path, before, after, diff: computeDiff(before, after), action: 'edit' }
  }

  /**
   * Delete a file. Returns the removed content and a diff so the change is
   * reviewable and a checkpoint taken beforehand can restore it.
   */
  delete(path) {
    path = this.resolvePath(path)
    if (!this.files.has(path)) {
      throw new Error(`File not found: ${path}. Use list_files to see what exists.`)
    }
    const before = this.files.get(path)
    this.files.delete(path)
    return { path, before, after: '', diff: computeDiff(before, ''), action: 'delete' }
  }

  createDirectory(path) {
    const normalized = this.resolvePath(path)
    const parts = normalized.split('/')
    let checkPath = ''
    for (const part of parts) {
      checkPath = checkPath ? `${checkPath}/${part}` : part
      if (this.files.has(checkPath)) throw new Error(`A file already exists at ${checkPath}.`)
    }
    const created = []
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      if (!this.directories.has(current)) {
        this.directories.add(current)
        created.push(current)
      }
    }
    return { path: normalized, created, action: 'create_directory' }
  }

  isDirectory(path) {
    try {
      return this.directories.has(this.resolvePath(path))
    } catch {
      return false
    }
  }

  directoryPaths() {
    return [...this.directories].sort()
  }

  removeDirectory(path) {
    const normalized = this.resolvePath(path)
    const prefix = `${normalized}/`
    if ([...this.files.keys()].some((file) => file.startsWith(prefix))) {
      throw new Error(`Directory ${normalized} is not empty.`)
    }
    if ([...this.directories].some((directory) => directory.startsWith(prefix))) {
      throw new Error(`Directory ${normalized} still contains a subdirectory.`)
    }
    if (!this.directories.delete(normalized)) throw new Error(`Directory not found: ${normalized}.`)
    return { path: normalized, action: 'remove_directory' }
  }

  /**
   * Rename or move a file within the workspace.
   */
  rename(oldPath, newPath) {
    if (!oldPath || !newPath || typeof oldPath !== 'string' || typeof newPath !== 'string') {
      throw new Error('Both old_path and new_path must be non-empty strings.')
    }
    oldPath = this.resolvePath(oldPath)
    newPath = this.resolvePath(newPath)
    if (!this.files.has(oldPath)) {
      throw new Error(`File not found: ${oldPath}. Use list_files to see what exists.`)
    }
    if (this.files.has(newPath)) {
      throw new Error(`Target path already exists: ${newPath}. Use a different destination or delete the target first.`)
    }
    const content = this.files.get(oldPath)
    this.files.delete(oldPath)
    this.files.set(newPath, content)
    this.addParentDirectories(newPath)
    return {
      old_path: oldPath,
      new_path: newPath,
      before: content,
      after: content,
      diff: { lines: [], added: 0, removed: 0 },
      action: 'rename',
    }
  }

  /**
   * Copy a file to a new location within the workspace.
   */
  copy(sourcePath, destPath) {
    if (!sourcePath || !destPath || typeof sourcePath !== 'string' || typeof destPath !== 'string') {
      throw new Error('Both source_path and dest_path must be non-empty strings.')
    }
    sourcePath = this.resolvePath(sourcePath)
    destPath = this.resolvePath(destPath)
    if (!this.files.has(sourcePath)) {
      throw new Error(`Source file not found: ${sourcePath}. Use list_files to see what exists.`)
    }
    if (this.files.has(destPath)) {
      throw new Error(`Destination path already exists: ${destPath}. Use a different destination or delete the target first.`)
    }
    const content = this.files.get(sourcePath)
    this.files.set(destPath, content)
    this.addParentDirectories(destPath)
    return {
      source_path: sourcePath,
      dest_path: destPath,
      before: '',
      after: content,
      diff: computeDiff('', content),
      action: 'copy',
    }
  }

  /** Snapshot the whole workspace. */
  snapshot(label) {
    const cp = {
      id: `cp_${Date.now()}_${this.checkpoints.length}`,
      label,
      timestamp: Date.now(),
      files: new Map(this.files),
      directories: new Set(this.directories),
    }
    this.checkpoints.push(cp)
    return { id: cp.id, label: cp.label, timestamp: cp.timestamp, fileCount: cp.files.size }
  }

  /** Restore a snapshot. Returns the list of paths that changed. */
  restore(id) {
    const cp = this.checkpoints.find((c) => c.id === id)
    if (!cp) throw new Error(`No checkpoint with id ${id}`)
    const changed = []
    const allPaths = new Set([...this.files.keys(), ...cp.files.keys()])
    for (const path of allPaths) {
      if (this.files.get(path) !== cp.files.get(path)) changed.push(path)
    }
    for (const path of new Set([...this.directories, ...cp.directories])) {
      if (this.directories.has(path) !== cp.directories.has(path)) changed.push(path)
    }
    this.files = new Map(cp.files)
    this.directories = new Set(cp.directories)
    return changed
  }

  toJSON() {
    return Object.fromEntries(this.files)
  }
}

function isAbsoluteWorkspacePath(path) {
  return /^[a-z]:\//i.test(path) || path.startsWith('/')
}

function normalizeWorkspacePath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Path must be a non-empty string.')
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Path must stay inside the workspace: ${path}`)
  }
  return normalized
}

function findOccurrences(haystack, needle) {
  if (!needle) return []
  const indexes = []
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    indexes.push(index)
    index = haystack.indexOf(needle, index + needle.length)
  }
  return indexes
}

function formatOccurrenceContexts(content, indexes) {
  const lines = content.split('\n')
  return indexes.map((index, i) => {
    const lineNumber = content.slice(0, index).split('\n').length
    const context = lines
      .slice(Math.max(0, lineNumber - 2), Math.min(lines.length, lineNumber + 1))
      .map((line) => line.trim())
      .join(' | ')
      .slice(0, 180)
    return `#${i + 1} line ${lineNumber}: ${context}`
  })
}
