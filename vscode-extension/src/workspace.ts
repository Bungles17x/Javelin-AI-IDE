/**
 * Real-filesystem workspace adapter for VS Code.
 *
 * Implements the same interface as the web app's VirtualWorkspace so the agent
 * loop is shared verbatim. Differences that matter:
 *  - Reads/writes go through vscode.workspace.fs, respecting the user's files.
 *  - Every write respects the user's open editor: we snapshot the file first so
 *    checkpoints can truly revert it.
 *  - Paths are validated to stay inside the workspace root.
 */

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import * as vscode from 'vscode';

export interface FileChange {
    path: string;
    before: string;
    after: string;
    diff: DiffResult;
    action: 'write' | 'edit' | 'delete';
}

export interface DiffLine {
    type: 'context' | 'add' | 'remove';
    text: string;
    aLine?: number;
    bLine?: number;
}

export interface DiffResult {
    lines: DiffLine[];
    added: number;
    removed: number;
}

export interface LiveEditOptions {
    /** Drive the change through a real visible editor instead of a silent disk write. */
    enabled: boolean;
    /** Animate added lines so the user watches the code being typed in. */
    animate: boolean;
    /** Milliseconds between animated chunks. */
    stepDelayMs: number;
}

export const DEFAULT_LIVE_EDIT: LiveEditOptions = {
    enabled: true,
    animate: true,
    stepDelayMs: 24,
};

/**
 * Directories never walked or listed. These are build output, dependencies or
 * VCS internals — large, generated, and irrelevant to editing the user's code.
 */
export const SKIP_DIRS = new Set([
    'node_modules', '.git', 'out', 'dist', 'build', '.next',
    '__pycache__', '.venv', 'venv', '.idea', '.vscode-test', 'coverage',
]);

export class VsCodeWorkspace {
    private checkpoints: {
        id: string;
        label: string;
        timestamp: number;
        files: Map<string, string>;
    }[] = [];

    constructor(
        private readonly root: vscode.Uri,
        private liveEdit: LiveEditOptions = DEFAULT_LIVE_EDIT,
    ) { }

    /** Update live-edit behaviour (driven by the user's settings). */
    public setLiveEdit(options: Partial<LiveEditOptions>): void {
        this.liveEdit = { ...this.liveEdit, ...options };
    }

    /** Absolute URI for a workspace-relative path, rejecting escapes. */
    private uri(relPath: string): vscode.Uri {
        const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const resolved = vscode.Uri.joinPath(this.root, normalized);
        const rootPath = this.root.fsPath.replace(/\\/g, '/');
        const filePath = resolved.fsPath.replace(/\\/g, '/');
        if (!filePath.startsWith(rootPath)) {
            throw new Error(`Refusing to touch a path outside the workspace: ${relPath}`);
        }
        return resolved;
    }

    private async readRaw(relPath: string): Promise<string> {
        const bytes = await vscode.workspace.fs.readFile(this.uri(relPath));
        return Buffer.from(bytes).toString('utf8');
    }

    private async exists(relPath: string): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(this.uri(relPath));
            return true;
        } catch {
            return false;
        }
    }

    async list(dir = ''): Promise<string> {
        const folder = dir
            ? this.uri(dir)
            : this.root;
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(folder);
        } catch {
            return `(could not read directory: ${dir || '.'})`;
        }

        const lines = entries
            .filter(([name]) => !SKIP_DIRS.has(name))
            .slice(0, 300)
            .map(([name, type]) => {
                const childPath = dir ? `${dir}/${name}` : name;
                return type === vscode.FileType.Directory ? `${childPath}/` : childPath;
            });
        return lines.length ? lines.join('\n') : '(empty)';
    }

    /**
     * The whole project as an indented tree — folders AND files, nested.
     *
     * `list` shows one directory at a time, which forces the agent to guess at
     * structure and repeatedly call list on paths it has not seen. This walks the
     * tree instead, so a single call gives an accurate, complete picture of how the
     * project is laid out: which folders exist, what is inside them, and how deep.
     *
     * Depth and entry count are capped so a huge repository cannot flood the model's
     * context; when a cap is hit the output says so rather than truncating silently.
     */
    async tree(dir = '', maxDepth = 4, maxEntries = 400): Promise<string> {
        const out: string[] = [];
        let truncated = false;

        const walk = async (rel: string, depth: number, prefix: string): Promise<void> => {
            if (out.length >= maxEntries) {
                truncated = true;
                return;
            }
            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(rel ? this.uri(rel) : this.root);
            } catch {
                return;
            }

            // Folders first, then files, each alphabetical — a stable, readable order.
            const visible = entries.filter(([name]) => !SKIP_DIRS.has(name));
            visible.sort((a, b) => {
                const aDir = a[1] === vscode.FileType.Directory;
                const bDir = b[1] === vscode.FileType.Directory;
                if (aDir !== bDir) {
                    return aDir ? -1 : 1;
                }
                return a[0].localeCompare(b[0]);
            });

            for (let i = 0; i < visible.length; i++) {
                if (out.length >= maxEntries) {
                    truncated = true;
                    return;
                }
                const [name, type] = visible[i];
                const isDir = type === vscode.FileType.Directory;
                const childRel = rel ? `${rel}/${name}` : name;
                const isLast = i === visible.length - 1;
                out.push(`${prefix}${isLast ? '└─ ' : '├─ '}${name}${isDir ? '/' : ''}`);

                if (isDir) {
                    if (depth + 1 >= maxDepth) {
                        out.push(`${prefix}${isLast ? '   ' : '│  '}└─ … (depth limit)`);
                    } else {
                        await walk(childRel, depth + 1, `${prefix}${isLast ? '   ' : '│  '}`);
                    }
                }
            }
        };

        await walk(dir, 0, '');
        if (!out.length) {
            return '(empty workspace) — no files or folders to show.';
        }
        const body = out.join('\n');
        return truncated
            ? `${body}\n… [tree truncated at ${maxEntries} entries — use list_files on a subfolder to go deeper]`
            : body;
    }

    async read(relPath: string, start?: number, end?: number): Promise<string> {
        if (!(await this.exists(relPath))) {
            throw new Error(`File not found: ${relPath}. Use list_files to see what exists.`);
        }
        const content = await this.readRaw(relPath);
        if (start == null && end == null) {
            return content;
        }
        const lines = content.split('\n');
        const from = Math.max(0, (start ?? 1) - 1);
        const to = end == null ? lines.length : end;
        return lines
            .slice(from, to)
            .map((l, i) => `${from + i + 1}\t${l}`)
            .join('\n');
    }

    /**
     * Search the workspace. Uses VS Code's own search so we honour the user's
     * .gitignore and exclude settings.
     */
    async search(query: string, isRegex = false): Promise<string> {
        if (!query) {
            return 'No query given.';
        }
        let pattern: string;
        try {
            pattern = isRegex ? query : escapeRegExp(query);
            const matches = await vscode.workspace.findFiles(
                '**/*',
                '**/{node_modules,.git,out,dist,build,.next,__pycache__,.venv}/**',
                400,
            );
            const re = new RegExp(pattern, 'i');
            const hits: string[] = [];
            for (const file of matches) {
                if (hits.length >= 150) {
                    break;
                }
                let text: string;
                try {
                    text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
                } catch {
                    continue;
                }
                const lines = text.split('\n');
                const rel = vscode.workspace.asRelativePath(file);
                for (let i = 0; i < lines.length; i++) {
                    if (re.test(lines[i])) {
                        hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                        if (hits.length >= 150) {
                            break;
                        }
                    }
                }
            }
            return hits.length ? hits.join('\n') : `No matches for "${query}".`;
        } catch (error: any) {
            return `Search failed: ${error.message}`;
        }
    }

    /** Full-file write. Refuses to clobber an existing file unless overwrite is set. */
    async write(relPath: string, content: string, overwrite = false): Promise<FileChange> {
        const alreadyThere = await this.exists(relPath);
        if (alreadyThere && !overwrite) {
            throw new Error(
                `File "${relPath}" already exists. Use edit_file for targeted changes, or pass overwrite: true to replace the whole file.`,
            );
        }
        const before = alreadyThere ? await this.readRaw(relPath) : '';
        await this.applyContent(relPath, content);
        return { path: relPath, before, after: content, diff: computeDiff(before, content), action: 'write' };
    }

    /** Targeted snippet replacement — the safe default for existing files. */
    async edit(
        relPath: string,
        oldString: string,
        newString: string,
        replaceAll = false,
        occurrence?: number,
    ): Promise<FileChange> {
        if (!(await this.exists(relPath))) {
            throw new Error(`File not found: ${relPath}. Use write_file to create it.`);
        }
        const before = await this.readRaw(relPath);
        if (oldString === newString) {
            throw new Error('old_string and new_string are identical — nothing to change.');
        }
        if (replaceAll && occurrence != null) {
            throw new Error('Use either occurrence or replace_all, not both.');
        }
        const indexes = findOccurrences(before, oldString);
        if (indexes.length === 0) {
            throw new Error(
                `old_string not found in ${relPath}. It must match the file exactly, including indentation. Read the file and copy the snippet verbatim.`,
            );
        }
        if (occurrence != null && (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > indexes.length)) {
            throw new Error(`occurrence must be between 1 and ${indexes.length} for this snippet in ${relPath}.`);
        }
        if (indexes.length > 1 && !replaceAll && occurrence == null) {
            const lines = before.split('\n');
            const locations = indexes.map((index, i) => {
                const lineNumber = before.slice(0, index).split('\n').length;
                const context = lines
                    .slice(Math.max(0, lineNumber - 2), Math.min(lines.length, lineNumber + 1))
                    .map((line) => line.trim())
                    .join(' | ')
                    .slice(0, 180);
                return `#${i + 1} line ${lineNumber}: ${context}`;
            });
            throw new Error(
                `old_string appears ${indexes.length} times in ${relPath}. Choose the intended match after inspecting its context, then retry with occurrence: N (1-based), or provide more surrounding text. Matches: ${locations.join('; ')}`,
            );
        }
        let after: string;
        if (replaceAll) {
            after = before.split(oldString).join(newString);
        } else {
            const index = occurrence == null ? indexes[0] : indexes[occurrence - 1];
            after = before.slice(0, index) + newString + before.slice(index + oldString.length);
        }
        await this.applyContent(relPath, after);
        return { path: relPath, before, after, diff: computeDiff(before, after), action: 'edit' };
    }

    /**
     * Apply new content to a file so the user can SEE it happen.
     *
     * When live editing is on, the change is driven through a real visible editor:
     * the file is opened (if needed), revealed, and the new text is written in —
     * animated when the user asked for it — so the edit looks like it is being typed
     * rather than silently rewritten on disk. The document is saved afterwards.
     *
     * Falls back to a plain filesystem write when live editing is off.
     */
    private async applyContent(relPath: string, content: string): Promise<void> {
        if (!this.liveEdit.enabled) {
            await vscode.workspace.fs.writeFile(this.uri(relPath), Buffer.from(content, 'utf8'));
            return;
        }

        const uri = this.uri(relPath);
        let editor: vscode.TextEditor | undefined;
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            editor = await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: true,
            });
        } catch {
            // No editor available (e.g. a binary or a closed virtual FS) — write plainly.
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            return;
        }

        const doc = editor.document;
        const current = doc.getText();

        if (this.liveEdit.animate && current !== content) {
            await this.animateIntoEditor(editor, content);
        } else {
            const full = new vscode.Range(doc.positionAt(0), doc.positionAt(current.length));
            await editor.edit((b) => b.replace(full, content));
        }

        // Make sure the on-disk file matches what the user now sees.
        if (doc.isDirty) {
            await doc.save();
        }
    }

    /**
     * Type the new content in progressively.
     *
     * Rather than diffing every keystroke (slow and jittery), the file is cleared
     * and the target text is revealed in line-sized chunks on a short timer. The
     * editor's cursor and scroll follow along, so it reads as the agent inputting
     * the code.
     */
    private async animateIntoEditor(editor: vscode.TextEditor, content: string): Promise<void> {
        const doc = editor.document;
        const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        await editor.edit((b) => b.delete(full));

        // Chunk by line, but cap the number of pauses so large files stay quick.
        const lines = content.split('\n');
        const maxPauses = 60;
        const groupSize = Math.max(1, Math.ceil(lines.length / maxPauses));

        // Track the insertion point as a line/column cursor instead of re-reading the
        // whole document each pass, which would be quadratic on large files.
        let line = 0;
        let column = 0;

        for (let i = 0; i < lines.length; i += groupSize) {
            const chunk = lines.slice(i, i + groupSize).join('\n');
            const text = i === 0 ? chunk : '\n' + chunk;
            const insertAt = new vscode.Position(line, column);
            await editor.edit((b) => b.insert(insertAt, text));

            // Advance the cursor past everything just inserted.
            const addedLines = text.split('\n');
            if (addedLines.length > 1) {
                line += addedLines.length - 1;
                column = addedLines[addedLines.length - 1].length;
            } else {
                column += text.length;
            }

            const end = new vscode.Position(line, column);
            editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.Default);
            await delay(this.liveEdit.stepDelayMs);
        }
    }

    /**
     * Delete a file from the real filesystem.
     *
     * Asks VS Code to move it to the OS trash where supported (useTrash), so a
     * mistaken deletion is recoverable outside Javelin as well as via a checkpoint.
     */
    /**
     * Append text to a file, creating it if it does not exist yet.
     *
     * This is how a large file gets built when the model cannot emit it in one call.
     */
    async append(relPath: string, content: string): Promise<FileChange> {
        const exists = await this.exists(relPath);
        const before = exists ? await this.readRaw(relPath) : '';
        return this.write(relPath, before + String(content ?? ''), true);
    }

    async delete(relPath: string): Promise<FileChange> {
        if (!(await this.exists(relPath))) {
            throw new Error(`File not found: ${relPath}. Use list_files to see what exists.`);
        }
        const before = await this.readRaw(relPath);
        await vscode.workspace.fs.delete(this.uri(relPath), { useTrash: true, recursive: false });
        return { path: relPath, before, after: '', diff: computeDiff(before, ''), action: 'delete' };
    }

    /**
     * Create a directory (and any missing parents) inside the workspace.
     */
    async createFolder(relPath: string): Promise<{ path: string; created: boolean }> {
        const target = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!target) {
            throw new Error('A folder path is required.');
        }
        const existed = await this.exists(target);
        await vscode.workspace.fs.createDirectory(this.uri(target));
        return { path: target, created: !existed };
    }

    /**
     * Rename or move a file within the workspace.
     */
    async rename(oldPath: string, newPath: string): Promise<FileChange> {
        if (!(await this.exists(oldPath))) {
            throw new Error(`Source file not found: ${oldPath}. Use list_files to see what exists.`);
        }
        if (await this.exists(newPath)) {
            throw new Error(`Destination already exists: ${newPath}. Delete it first or choose a different name.`);
        }
        if (oldPath === newPath) {
            throw new Error('Source and destination are the same path.');
        }
        const before = await this.readRaw(oldPath);
        await vscode.workspace.fs.rename(this.uri(oldPath), this.uri(newPath), { overwrite: false });
        return { path: newPath, before, after: before, diff: computeDiff(before, before), action: 'edit' };
    }

    /**
     * Copy a file within the workspace.
     */
    async copy(sourcePath: string, destPath: string): Promise<FileChange> {
        if (!(await this.exists(sourcePath))) {
            throw new Error(`Source file not found: ${sourcePath}. Use list_files to see what exists.`);
        }
        if (await this.exists(destPath)) {
            throw new Error(`Destination already exists: ${destPath}. Delete it first or choose a different name.`);
        }
        if (sourcePath === destPath) {
            throw new Error('Source and destination are the same path.');
        }
        const content = await this.readRaw(sourcePath);
        await vscode.workspace.fs.writeFile(this.uri(destPath), Buffer.from(content, 'utf8'));
        return { path: destPath, before: '', after: content, diff: computeDiff('', content), action: 'write' };
    }

    /** Preview an operation without applying it, for the approval dialog. */
    async preview(name: string, args: any): Promise<{ diff: DiffResult | null }> {
        try {
            if (name === 'write_file') {
                const exists = await this.exists(args.path);
                const before = exists ? await this.readRaw(args.path) : '';
                return { diff: computeDiff(before, args.content ?? '') };
            }
            if (name === 'delete_file') {
                if (!(await this.exists(args.path))) {
                    return { diff: null };
                }
                const before = await this.readRaw(args.path);
                // Show every line as removed so the user sees exactly what is lost.
                return { diff: computeDiff(before, '') };
            }
            if (name === 'edit_file') {
                if (!(await this.exists(args.path))) {
                    return { diff: null };
                }
                const before = await this.readRaw(args.path);
                const after = args.replace_all
                    ? before.split(args.old_string).join(args.new_string)
                    : before.replace(args.old_string, args.new_string);
                return { diff: computeDiff(before, after) };
            }
        } catch {
            return { diff: null };
        }
        return { diff: null };
    }

    /** Snapshot every file the agent has touched (plus optionally all workspace files). */
    async snapshot(label: string, paths?: string[]): Promise<{ id: string; label: string; timestamp: number; fileCount: number }> {
        const files = new Map<string, string>();
        const targets = paths ?? (await this.allFiles());
        for (const p of targets) {
            try {
                files.set(p, await this.readRaw(p));
            } catch {
                // Deleted or unreadable — skip; restore will leave it alone.
            }
        }
        const cp = {
            id: `cp_${Date.now()}_${this.checkpoints.length}`,
            label,
            timestamp: Date.now(),
            files,
        };
        this.checkpoints.push(cp);
        return { id: cp.id, label: cp.label, timestamp: cp.timestamp, fileCount: cp.files.size };
    }

    /** Restore a snapshot. Returns the paths that actually changed. */
    async restore(id: string): Promise<string[]> {
        const cp = this.checkpoints.find((c) => c.id === id);
        if (!cp) {
            throw new Error(`No checkpoint with id ${id}`);
        }
        const changed: string[] = [];
        for (const [relPath, content] of cp.files) {
            const current = (await this.exists(relPath)) ? await this.readRaw(relPath) : null;
            if (current !== content) {
                await vscode.workspace.fs.writeFile(this.uri(relPath), Buffer.from(content, 'utf8'));
                changed.push(relPath);
            }
        }
        return changed;
    }

    /** All workspace files as a path→content map, for project indexing. */
    async snapshotFiles(limit = 300): Promise<Record<string, string>> {
        const paths = await this.allFiles(limit);
        const out: Record<string, string> = {};
        for (const p of paths) {
            try {
                const content = await this.readRaw(p);
                // Skip very large or binary-looking files — they add noise, not signal.
                if (content.length > 200_000 || content.includes('\u0000')) {
                    continue;
                }
                out[p] = content;
            } catch {
                // Unreadable — skip.
            }
        }
        return out;
    }

    private async allFiles(limit = 400): Promise<string[]> {
        const uris = await vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,out,dist,build,.next,__pycache__,.venv}/**',
            limit,
        );
        return uris.map((u) => vscode.workspace.asRelativePath(u).replace(/\\/g, '/'));
    }
}

/** Line-level LCS diff. Kept dependency-free to match the web implementation. */
export function computeDiff(before: string, after: string): DiffResult {
    const a = before.split('\n');
    const b = after.split('\n');
    const m = a.length;
    const n = b.length;

    const lcs: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j]
                ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const lines: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            lines.push({ type: 'context', text: a[i], aLine: i + 1, bLine: j + 1 });
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            lines.push({ type: 'remove', text: a[i], aLine: i + 1 });
            i++;
        } else {
            lines.push({ type: 'add', text: b[j], bLine: j + 1 });
            j++;
        }
    }
    while (i < m) {
        lines.push({ type: 'remove', text: a[i], aLine: ++i });
    }
    while (j < n) {
        lines.push({ type: 'add', text: b[j], bLine: ++j });
    }

    return {
        lines,
        added: lines.filter((l) => l.type === 'add').length,
        removed: lines.filter((l) => l.type === 'remove').length,
    };
}

function findOccurrences(haystack: string, needle: string): number[] {
    if (!needle) {
        return [];
    }
    const indexes: number[] = [];
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        indexes.push(index);
        index = haystack.indexOf(needle, index + needle.length);
    }
    return indexes;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
