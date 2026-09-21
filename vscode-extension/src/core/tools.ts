/**
 * Javelin Core for VS Code — tool registry.
 *
 * Tools are first-class registered objects with a declared risk class, so the
 * runtime can make policy decisions generically: anything above `read` needs
 * approval, `destructive` is refused outright.
 */

import { VsCodeWorkspace } from '../workspace';

export const RISK = {
    READ: 'read',
    WRITE: 'write',
    EXECUTE: 'execute',
    DESTRUCTIVE: 'destructive',
} as const;

export type Risk = typeof RISK[keyof typeof RISK];

/**
 * How much Javelin is trusted to act without asking. `ask` is the default; the
 * higher levels let it run the whole job (plan, edit, delete, run, verify) without
 * stopping at every change.
 */
export const AUTONOMY = {
    ASK: 'ask',
    AUTO_EDIT: 'auto-edit',
    FULL: 'full',
} as const;

export type Autonomy = typeof AUTONOMY[keyof typeof AUTONOMY];

const SAFE_COMMAND_PATTERNS = [
    /^npm (test|run test|run lint|run build|run typecheck|run type-check)\b/,
    /^npx (jest|vitest|tsc|eslint)\b/,
    /^pnpm (test|build|lint)\b/,
    /^yarn (test|build|lint)\b/,
    /^pytest\b/,
    /^python -m pytest\b/,
    /^cargo (test|check|build)\b/,
    /^go (test|build|vet)\b/,
    /^dotnet (test|build)\b/,
    /^mvn (test|verify)\b/,
    /^gradle(w)? (test|build)\b/,
    /^git (status|diff|log|branch)\b/,
];

const BLOCKED_COMMAND_PATTERNS = [
    /\brm\s+-rf\s+[\\/]/,
    /\bformat\s+[a-z]:/i,
    /\bmkfs\b/,
    /:\(\)\s*\{.*\};\s*:/,
    />\s*\/dev\/sd/,
    /\b(shutdown|reboot)\b/,
    /\bdel\s+\/[sf]\b/i,
];

export function isSafeCommand(command: string): boolean {
    return SAFE_COMMAND_PATTERNS.some((re) => re.test(String(command).trim()));
}

export function isBlockedCommand(command: string): boolean {
    return BLOCKED_COMMAND_PATTERNS.some((re) => re.test(String(command)));
}

export interface ToolContext {
    workspace: VsCodeWorkspace;
    runCommand?: (cmd: string, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string; output?: string }>;
    emit: (evt: any) => void;
    signal?: AbortSignal;
}

export interface Tool {
    name: string;
    description: string;
    parameters: any;
    risk: Risk;
    autoSafe: boolean;
    /**
     * A destructive tool marked approvable is gated behind the approval prompt
     * instead of being refused outright — e.g. delete_file, which the user asked
     * to be able to run with permission.
     */
    approvable?: boolean;
    execute(args: any, ctx: ToolContext): Promise<{ ok: boolean; output: string; diff?: any; exitCode?: number }>;
}

export class ToolRegistry {
    private tools = new Map<string, Tool>();
    private disabled = new Set<string>();

    register(tool: Tool): this {
        this.tools.set(tool.name, tool);
        return this;
    }

    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    has(name: string): boolean {
        return this.tools.has(name) && !this.disabled.has(name);
    }

    disable(name: string): void { this.disabled.add(name); }
    enable(name: string): void { this.disabled.delete(name); }

    active(): Tool[] {
        return [...this.tools.values()].filter((t) => !this.disabled.has(t.name));
    }

    schemas(): any[] {
        return this.active().map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
    }

    requiresApproval(name: string, args: any): boolean {
        const tool = this.get(name);
        if (!tool || tool.risk === RISK.READ) {
            return false;
        }
        if (tool.risk === RISK.EXECUTE && tool.autoSafe && isSafeCommand(args?.command ?? '')) {
            return false;
        }
        return true;
    }

    /**
     * Does this call need a human prompt, given the run's autonomy level?
     * A catastrophic command is never auto-approved at any level.
     */
    approvalNeeded(name: string, args: any, autonomy: Autonomy = AUTONOMY.ASK): boolean {
        const tool = this.get(name);
        if (!tool) {
            return false;
        }
        if (autonomy === AUTONOMY.FULL) {
            return false;
        }
        if (autonomy === AUTONOMY.AUTO_EDIT) {
            if (tool.risk === RISK.EXECUTE) {
                return this.requiresApproval(name, args) && !isSafeCommand(args?.command ?? '');
            }
            return false;
        }
        return this.requiresApproval(name, args);
    }

    isForbidden(name: string, args: any): boolean {
        const tool = this.get(name);
        if (!tool) {
            return false;
        }
        if (tool.risk === RISK.DESTRUCTIVE && !tool.approvable) {
            return true;
        }
        if (name === 'run_command' && isBlockedCommand(args?.command ?? '')) {
            return true;
        }
        return false;
    }
}

export function createStandardToolset(): ToolRegistry {
    const registry = new ToolRegistry();

    registry.register({
        name: 'list_files',
        description: 'List files in the workspace so you understand its structure before changing anything.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
        },
        risk: RISK.READ,
        autoSafe: true,
        async execute(args, ctx) {
            return { ok: true, output: await ctx.workspace.list(args.path ?? '') };
        },
    });

    registry.register({
        name: 'read_file',
        description: 'Read a file. Always read a file before editing it.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                start: { type: 'integer' },
                end: { type: 'integer' },
            },
            required: ['path'],
        },
        risk: RISK.READ,
        autoSafe: true,
        async execute(args, ctx) {
            return { ok: true, output: truncate(await ctx.workspace.read(args.path, args.start, args.end), 16000) };
        },
    });

    registry.register({
        name: 'search_code',
        description: 'Search the workspace for a string or regular expression. Locate symbols instead of guessing.',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string' }, isRegex: { type: 'boolean' } },
            required: ['query'],
        },
        risk: RISK.READ,
        autoSafe: true,
        async execute(args, ctx) {
            return { ok: true, output: await ctx.workspace.search(args.query, Boolean(args.isRegex)) };
        },
    });

    registry.register({
        name: 'write_file',
        description:
            'Create a NEW file, or fully rewrite one if overwrite is true. REPLACES the entire file — prefer edit_file. Refused if the file exists and overwrite is omitted.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                overwrite: { type: 'boolean' },
            },
            required: ['path', 'content'],
        },
        risk: RISK.WRITE,
        autoSafe: false,
        async execute(args, ctx) {
            const outcome = await ctx.workspace.write(args.path, args.content, Boolean(args.overwrite));
            ctx.emit({ type: 'file_changed', ...outcome });
            const verb = outcome.before ? 'Rewrote' : 'Created';
            return {
                ok: true,
                diff: outcome.diff,
                output: `${verb} ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
            };
        },
    });

    registry.register({
        name: 'edit_file',
        description:
            'Replace an exact snippet in an existing file — the safe way to modify code. old_string must appear exactly once unless replace_all is true.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' },
            },
            required: ['path', 'old_string', 'new_string'],
        },
        risk: RISK.WRITE,
        autoSafe: false,
        async execute(args, ctx) {
            const outcome = await ctx.workspace.edit(
                args.path, args.old_string, args.new_string, Boolean(args.replace_all),
            );
            ctx.emit({ type: 'file_changed', ...outcome });
            return {
                ok: true,
                diff: outcome.diff,
                output: `Edited ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
            };
        },
    });

    registry.register({
        name: 'delete_file',
        description:
            'Delete a file from the workspace. Destructive — always requires the user to approve it. Prefer edit_file when you only need to remove some code. Take a checkpoint first if part of a larger change.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File to delete, relative to the workspace root.' },
                reason: { type: 'string', description: 'One line on why the file should be removed.' },
            },
            required: ['path'],
        },
        risk: RISK.DESTRUCTIVE,
        autoSafe: false,
        approvable: true,
        async execute(args, ctx) {
            const outcome = await ctx.workspace.delete(args.path);
            ctx.emit({ type: 'file_changed', ...outcome });
            return {
                ok: true,
                diff: outcome.diff,
                output: `Deleted ${outcome.path} (-${outcome.diff.removed} lines).`,
            };
        },
    });

    registry.register({
        name: 'run_command',
        description:
            'Run a test, build, linter or type-check to verify your changes. Non-allowlisted commands need approval.',
        parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
        },
        risk: RISK.EXECUTE,
        autoSafe: true,
        async execute(args, ctx) {
            const command = args.command ?? '';
            if (isBlockedCommand(command)) {
                return { ok: false, output: 'Blocked: this command is on the never-run list for safety.' };
            }
            if (!ctx.runCommand) {
                return { ok: false, output: 'Command execution is unavailable.' };
            }
            ctx.emit({ type: 'command_started', command });
            const res = await ctx.runCommand(command, ctx.signal);
            const output = [
                `$ ${command}`,
                `exit code: ${res.exitCode}`,
                res.output ? truncate(res.output, 4000) : '(no output)',
            ].join('\n');
            ctx.emit({ type: 'command_finished', command, exitCode: res.exitCode, output });
            return { ok: res.exitCode === 0, output, exitCode: res.exitCode };
        },
    });

    registry.register({
        name: 'create_checkpoint',
        description: 'Snapshot the workspace so the user can revert. Call this BEFORE a batch of related edits.',
        parameters: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
        },
        risk: RISK.READ,
        autoSafe: true,
        async execute(args, ctx) {
            const cp = await ctx.workspace.snapshot(args.label ?? 'checkpoint');
            ctx.emit({ type: 'checkpoint', checkpoint: cp });
            return { ok: true, output: `Checkpoint "${cp.label}" created (${cp.fileCount} file(s)).` };
        },
    });

    registry.register({
        name: 'remember',
        description:
            'Store a durable fact about this project, available in future sessions. Use it when you learn something a future run would need.',
        parameters: {
            type: 'object',
            properties: { fact: { type: 'string' } },
            required: ['fact'],
        },
        risk: RISK.READ,
        autoSafe: true,
        async execute(args, ctx) {
            ctx.emit({ type: 'memory_learn', fact: args.fact });
            return { ok: true, output: `Noted: ${args.fact}` };
        },
    });

    registry.register({
        name: 'recall',
        description: 'Search your own memory of this project for relevant past learnings and failures.',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        },
        risk: RISK.READ,
        autoSafe: true,
        async execute(args, ctx) {
            ctx.emit({ type: 'memory_recall', query: args.query });
            return { ok: true, output: `Recalled context for "${args.query}" (see the injected memory block).` };
        },
    });

    registry.register({
        name: 'finish',
        description:
            'Signal the task is complete. Summarise honestly what changed and what you verified. Set verified true only if tests or a build actually passed.',
        parameters: {
            type: 'object',
            properties: { summary: { type: 'string' }, verified: { type: 'boolean' } },
            required: ['summary'],
        },
        risk: RISK.READ,
        autoSafe: true,
        async execute(args) {
            return { ok: true, output: args.summary ?? 'Completed.' };
        },
    });

    return registry;
}

function truncate(text: string, max: number): string {
    const s = String(text ?? '');
    return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}
