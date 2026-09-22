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

import { computeDiff } from './agentTools'

export class VirtualWorkspace {
  /** @param {Record<string, string>} [files] path -> content */
  constructor(files = {}) {
    this.files = new Map(Object.entries(files))
    this.checkpoints = []
  }

  list(dir = '') {
    const prefix = dir && !dir.endsWith('/') ? `${dir}/` : dir
    const seen = new Set()
    const entries = []

    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (!rest) continue
      const slash = rest.indexOf('/')
      if (slash === -1) {
        entries.push({ path, type: 'file' })
      } else {
        const folder = prefix + rest.slice(0, slash)
        if (!seen.has(folder)) {
          seen.add(folder)
          entries.push({ path: folder, type: 'dir' })
        }
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path))
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
    const prefix = dir && !dir.endsWith('/') ? `${dir}/` : dir
    // Build the nested shape from the flat path -> content map.
    const root = { dirs: new Map(), files: [] }
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
    if (!this.files.has(path)) {
      throw new Error(`File not found: ${path}. Use list_files to see what exists.`)
    }
    const content = this.files.get(path)
    if (start == null && end == null) return content
    const lines = content.split('\n')
    const from = Math.max(0, (start ?? 1) - 1)
    const to = end == null ? lines.length : end
    return lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join('\n')
  }

  exists(path) {
    return this.files.has(path)
  }

  /**
   * Compute what an operation WOULD do, without applying it. Used by the approval
   * dialog so the user sees the real diff before consenting.
   */
  preview(name, args) {
    try {
      if (name === 'write_file') {
        const before = this.files.get(args.path) ?? ''
        return { diff: computeDiff(before, args.content ?? '') }
      }
      if (name === 'edit_file') {
        const before = this.files.get(args.path)
        if (before == null) return { diff: null, error: `File not found: ${args.path}` }
        const after = args.replace_all
          ? before.split(args.old_string).join(args.new_string)
          : before.replace(args.old_string, args.new_string)
        return { diff: computeDiff(before, after) }
      }
      if (name === 'delete_file') {
        const before = this.files.get(args.path)
        if (before == null) return { diff: null, error: `File not found: ${args.path}` }
        // A deletion is a diff that removes every line, so the approval dialog can
        // show exactly what would be lost before the user consents.
        return { diff: computeDiff(before, ''), deletes: true }
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
    for (const [path, content] of this.files) {
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
    if (this.files.has(path) && !overwrite) {
      throw new Error(
        `File "${path}" already exists. Use edit_file for targeted changes, or pass overwrite: true if you truly mean to replace the whole file.`,
      )
    }
    const before = this.files.get(path) ?? ''
    this.files.set(path, content)
    return { path, before, after: content, diff: computeDiff(before, content), action: 'write' }
  }

  /** Targeted snippet replacement — the safe default for modifying existing code. */
  edit(path, oldString, newString, replaceAll = false) {
    if (!this.files.has(path)) {
      throw new Error(`File not found: ${path}. Use write_file to create it.`)
    }
    const before = this.files.get(path)
    if (oldString === newString) {
      throw new Error('old_string and new_string are identical — nothing to change.')
    }

    const occurrences = countOccurrences(before, oldString)
    if (occurrences === 0) {
      throw new Error(
        `old_string not found in ${path}. It must match the file exactly, including indentation. Read the file and copy the snippet verbatim.`,
      )
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string appears ${occurrences} times in ${path}. Add more surrounding context to make it unique, or set replace_all: true.`,
      )
    }

    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString)
    this.files.set(path, after)
    return { path, before, after, diff: computeDiff(before, after), action: 'edit' }
  }

  /**
   * Delete a file. Returns the removed content and a diff so the change is
   * reviewable and a checkpoint taken beforehand can restore it.
   */
  delete(path) {
    if (!this.files.has(path)) {
      throw new Error(`File not found: ${path}. Use list_files to see what exists.`)
    }
    const before = this.files.get(path)
    this.files.delete(path)
    return { path, before, after: '', diff: computeDiff(before, ''), action: 'delete' }
  }

  /** Snapshot the whole workspace. */
  snapshot(label) {
    const cp = {
      id: `cp_${Date.now()}_${this.checkpoints.length}`,
      label,
      timestamp: Date.now(),
      files: new Map(this.files),
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
    this.files = new Map(cp.files)
    return changed
  }

  toJSON() {
    return Object.fromEntries(this.files)
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
