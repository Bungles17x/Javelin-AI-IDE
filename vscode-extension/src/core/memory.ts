/**
 * Javelin Core for VS Code — memory.
 *
 * Three stores: project index (what the code contains), episodic memory (what
 * Javelin did), semantic memory (what it learned). The failure record is what
 * makes self-correction real: a failed action is never repeated verbatim.
 */

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

export function actionSignature(name: string, args: any): string {
    const a = args ?? {};
    switch (name) {
        case 'read_file': return `read_file:${a.path}`;
        case 'edit_file': return `edit_file:${a.path}::${String(a.old_string ?? '').slice(0, 80)}`;
        case 'write_file': return `write_file:${a.path}`;
        case 'run_command': return `run_command:${String(a.command ?? '').trim()}`;
        case 'search_code': return `search_code:${a.query}`;
        case 'list_files': return `list_files:${a.path ?? '.'}`;
        default: return `${name}:${JSON.stringify(a).slice(0, 120)}`;
    }
}

export interface Episode {
    task: string;
    signature: string;
    tool: string;
    args: any;
    outcome: 'success' | 'failure';
    detail?: string;
    ts: number;
}

export interface Fact {
    id: string;
    fact: string;
    confidence: number;
    hits: number;
    scope: string;
    ts: number;
}

export class EpisodicMemory {
    episodes: Episode[] = [];
    constructor(private limit = 300) { }

    record(episode: Omit<Episode, 'ts'> & { ts?: number }): void {
        this.episodes.push({ ...episode, ts: episode.ts ?? Date.now() });
        if (this.episodes.length > this.limit) {
            this.episodes.shift();
        }
    }

    failedSignatures(): Set<string> {
        const failed = new Set<string>();
        for (const e of this.episodes) {
            if (!e.signature) {
                continue;
            }
            if (e.outcome === 'failure') {
                failed.add(e.signature);
            } else {
                failed.delete(e.signature);
            }
        }
        return failed;
    }

    recent(n = 10): Episode[] {
        return this.episodes.slice(-n);
    }
}

export class SemanticMemory {
    facts = new Map<string, Fact>();

    learn(fact: string, opts: { scope?: string; confidence?: number } = {}): Fact {
        const scope = opts.scope ?? 'project';
        // An explicit `remember` is deliberate, so it starts already trusted.
        const confidence = opts.confidence ?? 0.7;
        const id = `${scope}:${hash(fact)}`;
        const existing = this.facts.get(id);
        if (existing) {
            existing.hits++;
            existing.confidence = Math.min(1, existing.confidence + 0.15);
            existing.ts = Date.now();
        } else {
            this.facts.set(id, { id, fact, confidence, hits: 1, scope, ts: Date.now() });
        }
        return this.facts.get(id)!;
    }

    contradict(fact: string, opts: { scope?: string } = {}): Fact | null {
        const scope = opts.scope ?? 'project';
        const id = `${scope}:${hash(fact)}`;
        const existing = this.facts.get(id);
        if (!existing) {
            return null;
        }
        existing.confidence -= 0.4;
        if (existing.confidence <= 0) {
            this.facts.delete(id);
            return null;
        }
        return existing;
    }

    recall(query: string, limit = 5): Fact[] {
        const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
        if (!terms.length) {
            return [];
        }
        return [...this.facts.values()]
            .map((f) => {
                const lower = f.fact.toLowerCase();
                const overlap = terms.filter((t) => lower.includes(t)).length;
                return { fact: f, score: overlap * f.confidence };
            })
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ fact }) => fact);
    }

    strong(threshold = 0.6): Fact[] {
        return [...this.facts.values()].filter((f) => f.confidence >= threshold);
    }
}

export interface ProjectIndex {
    files: Map<string, { path: string; lang: string; lines: number; symbols: string[] }>;
    symbols: Map<string, { path: string; line: number; kind: string }[]>;
    languages: Map<string, number>;
    totalLines: number;
}

const SYMBOL_PATTERNS: Record<string, { re: RegExp; kind: string }[]> = {
    typescript: [
        { re: /^\s*export\s+(?:async\s+)?function\s+(\w+)/, kind: 'function' },
        { re: /^\s*(?:async\s+)?function\s+(\w+)/, kind: 'function' },
        { re: /^\s*export\s+class\s+(\w+)/, kind: 'class' },
        { re: /^\s*class\s+(\w+)/, kind: 'class' },
        { re: /^\s*export\s+interface\s+(\w+)/, kind: 'interface' },
        { re: /^\s*export\s+const\s+(\w+)\s*=/, kind: 'const' },
    ],
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
};

function languageOf(path: string): string {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const map: Record<string, string> = {
        js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
        ts: 'typescript', tsx: 'typescript',
        py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
        c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
        html: 'html', css: 'css', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml',
    };
    return map[ext] ?? 'text';
}

export function buildProjectIndex(files: Record<string, string>): ProjectIndex {
    const index: ProjectIndex = {
        files: new Map(),
        symbols: new Map(),
        languages: new Map(),
        totalLines: 0,
    };

    for (const [path, content] of Object.entries(files)) {
        const lang = languageOf(path);
        const lineCount = content.split('\n').length;
        const symbols = extractSymbols(content, lang);

        index.files.set(path, { path, lang, lines: lineCount, symbols: symbols.map((s) => s.name) });
        index.totalLines += lineCount;
        index.languages.set(lang, (index.languages.get(lang) ?? 0) + 1);

        for (const sym of symbols) {
            const list = index.symbols.get(sym.name) ?? [];
            list.push({ path, line: sym.line, kind: sym.kind });
            index.symbols.set(sym.name, list);
        }
    }

    return index;
}

function extractSymbols(content: string, lang: string): { name: string; kind: string; line: number }[] {
    const patterns = SYMBOL_PATTERNS[lang];
    if (!patterns) {
        return [];
    }
    const found: { name: string; kind: string; line: number }[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        for (const { re, kind } of patterns) {
            const m = lines[i].match(re);
            if (m && m[1]) {
                found.push({ name: m[1], kind, line: i + 1 });
                break;
            }
        }
    }
    return found;
}

/** Javelin's composite memory. */
export class JavelinMemory {
    index: ProjectIndex | null = null;
    episodic = new EpisodicMemory();
    semantic = new SemanticMemory();

    constructor(private persist?: (snapshot: MemorySnapshot) => void) { }

    indexProject(files: Record<string, string>): ProjectIndex {
        this.index = buildProjectIndex(files);
        return this.index;
    }

    /** The context block handed to the reasoner before it decides anything. */
    contextFor(task: string): string | null {
        const parts: string[] = [];

        if (this.index) {
            const langs = [...this.index.languages.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([lang, n]) => `${lang}(${n})`)
                .join(', ');
            parts.push(
                `PROJECT: ${this.index.files.size} files, ${this.index.totalLines} lines. Languages: ${langs}.`,
            );

            const terms = task.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
            const relevant: string[] = [];
            for (const [name, refs] of this.index.symbols) {
                if (terms.some((t) => name.toLowerCase().includes(t))) {
                    relevant.push(`${name} → ${refs.map((r) => `${r.path}:${r.line}`).join(', ')}`);
                }
                if (relevant.length >= 8) {
                    break;
                }
            }
            if (relevant.length) {
                parts.push(`RELEVANT SYMBOLS:\n${relevant.join('\n')}`);
            }
        }

        const learned = this.semantic.recall(task, 5);
        if (learned.length) {
            parts.push(`LEARNED ABOUT THIS PROJECT:\n${learned.map((f) => `- ${f.fact}`).join('\n')}`);
        }

        const poisoned = this.episodic.failedSignatures();
        if (poisoned.size) {
            parts.push(
                `ACTIONS THAT ALREADY FAILED (never repeat verbatim):\n${[...poisoned].map((s) => `- ${s}`).join('\n')}`,
            );
        }

        return parts.length ? parts.join('\n\n') : null;
    }

    observe(episode: Omit<Episode, 'ts'>): void {
        this.episodic.record(episode);

        if (episode.outcome === 'failure' && episode.detail) {
            const detail = episode.detail;
            if (/not found/i.test(detail) && episode.tool === 'edit_file') {
                this.semantic.learn(
                    `edit_file on ${episode.args?.path} requires reading it first for an exact snippet.`,
                    { confidence: 0.5 },
                );
            } else if (/appears \d+ times/i.test(detail)) {
                this.semantic.learn(
                    `${episode.args?.path} has repeated blocks — edits there need more surrounding context.`,
                    { confidence: 0.5 },
                );
            }
        }
        this.flush();
    }

    snapshot(): MemorySnapshot {
        return {
            episodic: this.episodic.episodes,
            semantic: [...this.semantic.facts.values()],
        };
    }

    static restore(data: MemorySnapshot | undefined): JavelinMemory {
        const mem = new JavelinMemory();
        if (data) {
            mem.episodic.episodes = Array.isArray(data.episodic) ? data.episodic : [];
            for (const f of Array.isArray(data.semantic) ? data.semantic : []) {
                mem.semantic.facts.set(f.id, f);
            }
        }
        return mem;
    }

    flush(): void {
        try {
            this.persist?.(this.snapshot());
        } catch {
            // persistence must never break a run
        }
    }
}

export interface MemorySnapshot {
    episodic: Episode[];
    semantic: Fact[];
}

function hash(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
        h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}
