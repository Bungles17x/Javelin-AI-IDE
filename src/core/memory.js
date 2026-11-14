/**
 * Javelin Core — Memory
 * =====================
 *
 * Javelin remembers. Three distinct stores, because they serve different purposes:
 *
 *  1. **Project index**  — what the codebase *contains* (files, symbols, structure).
 *                         Built by scanning, used to ground every decision in reality.
 *  2. **Episodic memory** — what Javelin *did* and what happened. The raw log of
 *                         attempts, successes and failures, per task.
 *  3. **Semantic memory** — what Javelin *learned*. Durable facts distilled from
 *                         episodes: "edits to X need Y", "command Z fails here".
 *
 * The failure store is the part that makes self-correction real: an action that
 * failed is recorded with its error, and the loop refuses to repeat it verbatim
 * while surfacing it back to the reasoner as a constraint.
 */

/** A stable signature for an action, so repeats are detectable. */
export function actionSignature(name, args) {
  const a = args ?? {}
  switch (name) {
    case 'read_file':
      return `read_file:${a.path}`
    case 'edit_file':
      return `edit_file:${a.path}:${hash(JSON.stringify([
        a.old_string,
        a.new_string,
        Boolean(a.replace_all),
        a.occurrence ?? null,
      ]))}`
    case 'write_file':
      return `write_file:${a.path}`
    case 'create_folder':
      return `create_folder:${a.path}`
    case 'delete_file':
      return `delete_file:${a.path}`
    case 'rename_file':
      return `rename_file:${a.old_path}->${a.new_path}`
    case 'copy_file':
      return `copy_file:${a.source_path}->${a.dest_path}`
    case 'run_command':
      return `run_command:${String(a.command ?? '').trim()}`
    case 'search_code':
      return `search_code:${a.query}`
    case 'list_files':
      return `list_files:${a.path ?? '.'}`
    default:
      return `${name}:${JSON.stringify(a).slice(0, 120)}`
  }
}

/** ------------------------------------------------------------------ *
 * Project index
 * ------------------------------------------------------------------ */

/**
 * Build a lightweight structural index of a workspace.
 * Deliberately dependency-free: we extract symbols with regexes tuned per
 * language rather than shipping a full parser, which keeps the core small and
 * works for the languages people actually edit here.
 */
export function buildProjectIndex(files) {
  const index = {
    files: new Map(),
    symbols: new Map(), // symbol -> [{path, line, kind}]
    languages: new Map(),
    totalLines: 0,
  }

  for (const [path, content] of Object.entries(files)) {
    const lang = languageOf(path)
    const lines = content.split('\n')
    const symbols = extractSymbols(content, lang, path)

    index.files.set(path, {
      path,
      lang,
      lines: lines.length,
      bytes: content.length,
      symbols: symbols.map((s) => s.name),
    })
    index.totalLines += lines.length

    index.languages.set(lang, (index.languages.get(lang) ?? 0) + 1)

    for (const sym of symbols) {
      const list = index.symbols.get(sym.name) ?? []
      list.push({ path, line: sym.line, kind: sym.kind })
      index.symbols.set(sym.name, list)
    }
  }

  return index
}

function languageOf(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    html: 'html', css: 'css', scss: 'css', json: 'json', md: 'markdown',
    yml: 'yaml', yaml: 'yaml', sh: 'shell', sql: 'sql',
  }
  return map[ext] ?? 'text'
}

const SYMBOL_PATTERNS = {
  javascript: [
    { re: /^\s*export\s+(?:async\s+)?function\s+(\w+)/, kind: 'function' },
    { re: /^\s*(?:async\s+)?function\s+(\w+)/, kind: 'function' },
    { re: /^\s*export\s+class\s+(\w+)/, kind: 'class' },
    { re: /^\s*class\s+(\w+)/, kind: 'class' },
    { re: /^\s*export\s+const\s+(\w+)\s*=/, kind: 'const' },
  ],
  python: [
    { re: /^\s*def\s+(\w+)/, kind: 'function' },
    { re: /^\s*class\s+(\w+)/, kind: 'class' },
  ],
  go: [{ re: /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: 'function' }],
  rust: [
    { re: /^\s*pub\s+fn\s+(\w+)/, kind: 'function' },
    { re: /^\s*fn\s+(\w+)/, kind: 'function' },
    { re: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: 'struct' },
  ],
  java: [
    { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*\{/, kind: 'method' },
    { re: /^\s*(?:public|private)?\s*class\s+(\w+)/, kind: 'class' },
  ],
}

function extractSymbols(content, lang, path) {
  const patterns = SYMBOL_PATTERNS[lang]
  if (!patterns) {
    return []
  }
  const found = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const { re, kind } of patterns) {
      const m = lines[i].match(re)
      if (m && m[1]) {
        found.push({ name: m[1], kind, line: i + 1 })
        break
      }
    }
  }
  return found
}

/** ------------------------------------------------------------------ *
 * Episodic memory — the log of what happened
 * ------------------------------------------------------------------ */

export class EpisodicMemory {
  constructor(limit = 200) {
    this.limit = limit
    this.episodes = []
  }

  record(episode) {
    this.episodes.push({ ...episode, ts: episode.ts ?? Date.now() })
    if (this.episodes.length > this.limit) {
      this.episodes.shift()
    }
    return this
  }

  /** Every recorded attempt at a given action signature. */
  attemptsFor(signature) {
    return this.episodes.filter((e) => e.signature === signature)
  }

  failedSignatures() {
    const failed = new Set()
    for (const e of this.episodes) {
      if (e.outcome === 'failure' && e.signature) {
        failed.add(e.signature)
      }
      if (e.outcome === 'success' && e.signature && failed.has(e.signature)) {
        // A later success means the signature is no longer poison.
        failed.delete(e.signature)
      }
    }
    return failed
  }

  recent(n = 10) {
    return this.episodes.slice(-n)
  }

  toJSON() {
    return this.episodes
  }

  static fromJSON(data) {
    const mem = new EpisodicMemory()
    mem.episodes = Array.isArray(data) ? data : []
    return mem
  }
}

/** ------------------------------------------------------------------ *
 * Semantic memory — durable learnings
 * ------------------------------------------------------------------ */

export class SemanticMemory {
  constructor() {
    /** @type {Map<string, {id: string, fact: string, confidence: number, hits: number, scope: string, ts: number}>} */
    this.facts = new Map()
  }

  /**
   * Learn a fact. An explicit `remember` is a deliberate act, so it starts
   * already-trusted (0.7); incidental inferences start lower and must be
   * reinforced. Repeated confirmations raise confidence; contradictions lower it
   * so a stale belief fades rather than persisting forever.
   */
  learn(fact, { scope = 'project', confidence = 0.7 } = {}) {
    const id = `${scope}:${hash(fact)}`
    const existing = this.facts.get(id)
    if (existing) {
      existing.hits++
      existing.confidence = Math.min(1, existing.confidence + 0.15)
      existing.ts = Date.now()
    } else {
      this.facts.set(id, { id, fact, confidence, hits: 1, scope, ts: Date.now() })
    }
    return this.facts.get(id)
  }

  /** Weaken or remove a belief that turned out to be wrong. */
  contradict(fact, { scope = 'project' } = {}) {
    const id = `${scope}:${hash(fact)}`
    const existing = this.facts.get(id)
    if (!existing) {
      return null
    }
    existing.confidence -= 0.4
    if (existing.confidence <= 0) {
      this.facts.delete(id)
      return null
    }
    return existing
  }

  recall(query, limit = 5) {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2)
    if (!terms.length) {
      return []
    }
    return [...this.facts.values()]
      .map((f) => {
        const lower = f.fact.toLowerCase()
        const overlap = terms.filter((t) => lower.includes(t)).length
        return { fact: f, score: overlap * f.confidence }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ fact }) => fact)
  }

  strong(threshold = 0.6) {
    return [...this.facts.values()].filter((f) => f.confidence >= threshold)
  }

  toJSON() {
    return [...this.facts.values()]
  }

  static fromJSON(data) {
    const mem = new SemanticMemory()
    for (const f of Array.isArray(data) ? data : []) {
      mem.facts.set(f.id, f)
    }
    return mem
  }
}

/** ------------------------------------------------------------------ *
 * The composite memory Javelin actually uses
 * ------------------------------------------------------------------ */

export class JavelinMemory {
  constructor({ persist } = {}) {
    this.index = null
    this.episodic = new EpisodicMemory()
    this.semantic = new SemanticMemory()
    /** @type {(snapshot: object) => void} [persist] */
    this.persist = persist
  }

  /** Rebuild the project index from raw files. */
  indexProject(files) {
    this.index = buildProjectIndex(files)
    return this.index
  }

  /**
   * The block of context we hand the reasoner before it decides anything.
   * This is what makes Javelin feel like it "knows the project".
   */
  contextFor(task) {
    const parts = []

    if (this.index) {
      const langs = [...this.index.languages.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([lang, n]) => `${lang}(${n})`)
        .join(', ')
      parts.push(
        `PROJECT: ${this.index.files.size} files, ${this.index.totalLines} lines. Languages: ${langs}.`,
      )

      // Surface symbols whose names relate to the task — cheap lexical grounding.
      const terms = task.toLowerCase().split(/\W+/).filter((t) => t.length > 3)
      const relevant = []
      for (const [name, refs] of this.index.symbols) {
        if (terms.some((t) => name.toLowerCase().includes(t))) {
          relevant.push(`${name} → ${refs.map((r) => `${r.path}:${r.line}`).join(', ')}`)
        }
        if (relevant.length >= 8) {
          break
        }
      }
      if (relevant.length) {
        parts.push(`RELEVANT SYMBOLS:\n${relevant.join('\n')}`)
      }
    }

    const learned = this.semantic.recall(task, 5)
    if (learned.length) {
      parts.push(`LEARNED ABOUT THIS PROJECT:\n${learned.map((f) => `- ${f.fact}`).join('\n')}`)
    }

    const poisoned = this.episodic.failedSignatures()
    if (poisoned.size) {
      parts.push(
        `ACTIONS THAT ALREADY FAILED (never repeat verbatim):\n${[...poisoned].map((s) => `- ${s}`).join('\n')}`,
      )
    }

    return parts.length ? parts.join('\n\n') : null
  }

  /** Record an attempt and extract any durable learning from it. */
  observe({ task, signature, tool, args, outcome, detail }) {
    this.episodic.record({ task, signature, tool, args, outcome, detail })

    // Distil a durable fact from notable failures.
    if (outcome === 'failure' && detail) {
      if (/not found/i.test(detail) && tool === 'edit_file') {
        this.semantic.learn(`In this project, edit_file on ${args?.path} requires reading it first for an exact snippet.`)
      } else if (/appears \d+ times/i.test(detail)) {
        this.semantic.learn(`${args?.path} has repeated blocks — edits there need extra surrounding context.`)
      } else if (/command not found|not recognized/i.test(detail)) {
        this.semantic.learn(`Command "${args?.command}" is unavailable in this environment.`)
      }
    }
    this.flush()
  }

  snapshot() {
    return {
      episodic: this.episodic.toJSON(),
      semantic: this.semantic.toJSON(),
    }
  }

  static restore(data) {
    const mem = new JavelinMemory()
    if (data) {
      mem.episodic = EpisodicMemory.fromJSON(data.episodic)
      mem.semantic = SemanticMemory.fromJSON(data.semantic)
    }
    return mem
  }

  flush() {
    try {
      this.persist?.(this.snapshot())
    } catch {
      // Persistence must never break a run.
    }
  }
}

function hash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
