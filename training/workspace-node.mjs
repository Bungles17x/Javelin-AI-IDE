/**
 * NodeWorkspace — a real-filesystem workspace for Javelin outside the browser.
 * ===========================================================================
 *
 * The web app hands Javelin a VirtualWorkspace (in memory, because a page cannot
 * touch disk). VS Code hands it VsCodeWorkspace. Neither is usable from a Node CLI
 * — capture, headless runs, CI — so this is the third implementation of the same
 * interface, over `node:fs`.
 *
 * Same contract, so the agent loop is unchanged:
 *   list / read / exists / write / edit / delete / preview / search / snapshot / restore
 *
 * Paths are validated to stay inside the root, exactly as the VS Code adapter does.
 * A workspace tool that can escape its root is not a sandbox, it is a liability.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { spawn } from 'node:child_process'

import { computeDiff } from '../src/lib/agentTools.js'

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.next', '__pycache__', '.venv'])

export class NodeWorkspace {
  /** @param {string} root absolute path to the workspace root */
  constructor(root) {
    this.root = resolve(root)
    this.checkpoints = []
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true })
    }
  }

  /** Resolve a workspace-relative path, refusing anything that escapes the root. */
  _resolve(relPath) {
    const target = resolve(this.root, relPath ?? '')
    const rel = relative(this.root, target)
    if (rel.startsWith('..') || (rel !== '' && resolve(this.root, rel) !== target && !target.startsWith(this.root + sep))) {
      throw new Error(`Refusing to touch a path outside the workspace: ${relPath}`)
    }
    return target
  }

  list(dir = '') {
    const abs = this._resolve(dir)
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((e) => !SKIP_DIRS.has(e.name))
      .slice(0, 300)
      .map((e) => {
        const rel = dir ? `${dir.replace(/\\/g, '/')}/${e.name}` : e.name
        return { path: rel, type: e.isDirectory() ? 'dir' : 'file' }
      })
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  exists(relPath) {
    return existsSync(this._resolve(relPath))
  }

  read(relPath, start, end) {
    const abs = this._resolve(relPath)
    if (!existsSync(abs)) {
      throw new Error(`File not found: ${relPath}. Use list_files to see what exists.`)
    }
    const content = readFileSync(abs, 'utf8')
    if (start == null && end == null) {
      return content
    }
    const lines = content.split('\n')
    const from = Math.max(0, (start ?? 1) - 1)
    const to = end == null ? lines.length : end
    return lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join('\n')
  }

  search(query, isRegex = false) {
    if (!query) return []
    const re = isRegex ? new RegExp(query, 'i') : null
    const needle = isRegex ? null : query.toLowerCase()
    const hits = []
    const walk = (absDir) => {
      if (hits.length >= 200) return
      let entries
      try {
        entries = readdirSync(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (hits.length >= 200) return
        if (SKIP_DIRS.has(e.name)) continue
        const abs = join(absDir, e.name)
        if (e.isDirectory()) {
          walk(abs)
        } else {
          let text
          try {
            if (statSync(abs).size > 500_000) continue
            text = readFileSync(abs, 'utf8')
          } catch {
            continue
          }
          const rel = relative(this.root, abs).replace(/\\/g, '/')
          const lines = text.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const match = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle)
            if (match) {
              hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
              if (hits.length >= 200) return
            }
          }
        }
      }
    }
    walk(this.root)
    return hits
  }

  preview(name, args) {
    try {
      if (name === 'write_file') {
        const abs = this._resolve(args.path)
        const before = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
        return { diff: computeDiff(before, args.content ?? '') }
      }
      if (name === 'edit_file') {
        const abs = this._resolve(args.path)
        if (!existsSync(abs)) return { diff: null, error: `File not found: ${args.path}` }
        const before = readFileSync(abs, 'utf8')
        const after = args.replace_all
          ? before.split(args.old_string).join(args.new_string)
          : before.replace(args.old_string, args.new_string)
        return { diff: computeDiff(before, after) }
      }
      if (name === 'delete_file') {
        const abs = this._resolve(args.path)
        if (!existsSync(abs)) return { diff: null, error: `File not found: ${args.path}` }
        const before = readFileSync(abs, 'utf8')
        return { diff: computeDiff(before, ''), deletes: true }
      }
    } catch {
      return { diff: null }
    }
    return { diff: null }
  }

  write(relPath, content, overwrite = false) {
    const abs = this._resolve(relPath)
    const alreadyThere = existsSync(abs)
    if (alreadyThere && !overwrite) {
      throw new Error(
        `File "${relPath}" already exists. Use edit_file for targeted changes, or pass overwrite: true to replace the whole file.`,
      )
    }
    const before = alreadyThere ? readFileSync(abs, 'utf8') : ''
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    return { path: relPath, before, after: content, diff: computeDiff(before, content), action: 'write' }
  }

  edit(relPath, oldString, newString, replaceAll = false) {
    const abs = this._resolve(relPath)
    if (!existsSync(abs)) {
      throw new Error(`File not found: ${relPath}. Use write_file to create it.`)
    }
    const before = readFileSync(abs, 'utf8')
    if (oldString === newString) {
      throw new Error('old_string and new_string are identical — nothing to change.')
    }
    const occurrences = countOccurrences(before, oldString)
    if (occurrences === 0) {
      throw new Error(
        `old_string not found in ${relPath}. It must match the file exactly, including indentation.`,
      )
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string appears ${occurrences} times in ${relPath}. Add surrounding context, or set replace_all: true.`,
      )
    }
    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString)
    writeFileSync(abs, after, 'utf8')
    return { path: relPath, before, after, diff: computeDiff(before, after), action: 'edit' }
  }

  delete(relPath) {
    const abs = this._resolve(relPath)
    if (!existsSync(abs)) {
      throw new Error(`File not found: ${relPath}. Use list_files to see what exists.`)
    }
    const before = readFileSync(abs, 'utf8')
    rmSync(abs)
    return { path: relPath, before, after: '', diff: computeDiff(before, ''), action: 'delete' }
  }

  snapshot(label) {
    const files = new Map()
    for (const p of this._allFiles()) {
      try {
        files.set(p, readFileSync(this._resolve(p), 'utf8'))
      } catch {
        // unreadable — skip
      }
    }
    const cp = { id: `cp_${Date.now()}_${this.checkpoints.length}`, label, timestamp: Date.now(), files }
    this.checkpoints.push(cp)
    return { id: cp.id, label: cp.label, timestamp: cp.timestamp, fileCount: cp.files.size }
  }

  restore(id) {
    const cp = this.checkpoints.find((c) => c.id === id)
    if (!cp) throw new Error(`No checkpoint with id ${id}`)
    const changed = []
    for (const [relPath, content] of cp.files) {
      const abs = this._resolve(relPath)
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      if (current !== content) {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content, 'utf8')
        changed.push(relPath)
      }
    }
    return changed
  }

  _allFiles(limit = 400) {
    const out = []
    const walk = (absDir) => {
      if (out.length >= limit) return
      let entries
      try {
        entries = readdirSync(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= limit) return
        if (SKIP_DIRS.has(e.name)) continue
        const abs = join(absDir, e.name)
        if (e.isDirectory()) walk(abs)
        else out.push(relative(this.root, abs).replace(/\\/g, '/'))
      }
    }
    walk(this.root)
    return out
  }

  toJSON() {
    const map = {}
    for (const p of this._allFiles()) {
      try {
        map[p] = readFileSync(this._resolve(p), 'utf8')
      } catch {
        // skip
      }
    }
    return map
  }

  /**
   * Run a command in the workspace root. Bound so it can be passed to the runtime
   * as `runCommand` without losing `this`.
   */
  runCommand = (command, signal) =>
    new Promise((resolvePromise) => {
      const child = spawn(command, { cwd: this.root, shell: true, signal })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (b) => (stdout += b.toString()))
      child.stderr?.on('data', (b) => (stderr += b.toString()))
      child.on('error', (err) => resolvePromise({ exitCode: 1, stdout, stderr: err.message }))
      child.on('close', (code) => resolvePromise({ exitCode: code ?? 0, stdout, stderr }))
    })
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
