/**
 * The agent loop for VS Code.
 *
 * Same plan/act/verify/recover shape as the web build, but tools run against the
 * real filesystem and a real shell. Key behaviours:
 *  - Never repeats an identical call that already failed (failure memory).
 *  - Asks for approval before any workspace mutation or non-allowlisted command,
 *    showing a preview diff so the decision is informed.
 *  - Runs commands in a real VS Code task/terminal and reads the exit code.
 */

import * as vscode from 'vscode';
import { streamCompletion, ToolCall } from './providers';
import { VsCodeWorkspace, DiffResult } from './workspace';
import { AUTONOMY, Autonomy } from './core/tools';

export const MAX_STEPS = 24;

export const AGENT_SYSTEM_PROMPT = `You are Javelin AI, an autonomous coding agent working inside a real VS Code workspace. You do not just answer questions — you inspect the codebase, plan, make edits, run tests, and fix your own mistakes.

Operating rules:
1. INVESTIGATE BEFORE EDITING. Call list_files / read_file / search_code to understand the relevant code first. Never invent file paths — verify they exist.
2. READ BEFORE YOU WRITE. Always read a file before editing it. Use edit_file with an exact snippet for changes; only use write_file for genuinely new files or a deliberate full replacement.
3. NEVER OVERWRITE BLINDLY. Do not replace a whole file to change a few lines. Match the existing style, imports and conventions of the project.
4. PLAN BRIEFLY. On your first turn, state a 2-5 step plan in plain text, then begin executing it.
5. VERIFY YOUR WORK. Run the project's tests, build or linter when they exist. If a command fails, read the error, fix the cause, and run it again.
6. DO NOT REPEAT FAILED STEPS. If an action failed, change your approach rather than retrying it identically.
7. CHECKPOINT BEFORE RISKY WORK. Call create_checkpoint before a batch of related edits.
8. STOP WHEN DONE. Call \`finish\` with an honest summary. Set verified: true only if you actually ran tests or a build and they passed.

Be concise. Do not narrate every tool call at length, and be honest about what did not work.`;

export const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'list_files',
            description: 'List files in the workspace so you can understand its structure before changing anything.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to root.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file. Always read a file before editing it.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path relative to the workspace root.' },
                    start: { type: 'integer', description: 'Optional 1-based first line.' },
                    end: { type: 'integer', description: 'Optional 1-based last line.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_code',
            description: 'Search the workspace for a string or regular expression. Use it to locate symbols rather than guessing.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    isRegex: { type: 'boolean' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description:
                'Create a NEW file, or fully rewrite an existing one. REPLACES the entire file. Prefer edit_file. Refused if the file exists and overwrite is omitted.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                    overwrite: { type: 'boolean', description: 'Must be true to intentionally replace an existing file.' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description:
                'Replace an exact snippet in an existing file. The safe way to modify code. old_string must appear exactly once unless replace_all is true.',
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
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description:
                'Delete a file from the workspace. Destructive — always requires user approval. Prefer edit_file when you only need to remove some code.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File to delete, relative to the workspace root.' },
                    reason: { type: 'string', description: 'One line on why the file should be removed.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description:
                'Run a test, build, linter or type-check in the workspace. Use it to verify your changes. Non-allowlisted commands need user approval.',
            parameters: {
                type: 'object',
                properties: { command: { type: 'string', description: 'e.g. `npm test`' } },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_checkpoint',
            description: 'Snapshot the workspace so the user can revert. Call this BEFORE a batch of related edits.',
            parameters: {
                type: 'object',
                properties: { label: { type: 'string' } },
                required: ['label'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'finish',
            description:
                'Signal the task is complete, with an honest summary. Set verified: true only if tests/build actually passed.',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                    verified: { type: 'boolean' },
                },
                required: ['summary'],
            },
        },
    },
];

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
];

const BLOCKED_COMMANDS = [
    /\brm\s+-rf\s+[\\/]/,
    /\bformat\s+[a-z]:/i,
    /\bmkfs\b/,
    /:\(\)\s*\{.*\};\s*:/,
    />\s*\/dev\/sd/,
];

export function isSafeCommand(command: string): boolean {
    return SAFE_COMMAND_PATTERNS.some((re) => re.test(command.trim()));
}

export function isBlockedCommand(command: string): boolean {
    return BLOCKED_COMMANDS.some((re) => re.test(command));
}

function signatureOf(name: string, args: any): string {
    const a = args ?? {};
    switch (name) {
        case 'read_file':
            return `read_file:${a.path}`;
        case 'edit_file':
            return `edit_file:${a.path}::${String(a.old_string ?? '').slice(0, 80)}`;
        case 'write_file':
            return `write_file:${a.path}`;
        case 'delete_file':
            return `delete_file:${a.path}`;
        case 'run_command':
            return `run_command:${String(a.command ?? '').trim()}`;
        case 'search_code':
            return `search_code:${a.query}`;
        case 'list_files':
            return `list_files:${a.path ?? '.'}`;
        case 'create_checkpoint':
            return `create_checkpoint:${a.label}`;
        default:
            return `${name}:${JSON.stringify(a).slice(0, 120)}`;
    }
}

export interface ApprovalRequest {
    id: string;
    name: string;
    args: any;
    diff: DiffResult | null;
    path?: string;
}

export interface AgentCallbacks {
    onPhase: (phase: string) => void;
    onStatus: (text: string) => void;
    onAssistantText: (text: string) => void;
    onAssistantDelta: (delta: string) => void;
    onToolCall: (call: { id: string; name: string; args: any }) => void;
    onToolResult: (result: { id: string; name: string; ok: boolean; output: string; diff?: DiffResult | null }) => void;
    onCheckpoint: (cp: { id: string; label: string; timestamp: number; fileCount: number }) => void;
    onCommand: (command: string, output: string, exitCode: number) => void;
    onReminder: (text: string) => void;
    requestApproval: (req: ApprovalRequest) => Promise<{ approved: boolean; remember: boolean }>;
}

export interface RunResult {
    status: 'done' | 'aborted' | 'failed';
    summary: string;
    steps: any[];
    checkpoints: { id: string; label: string; timestamp: number; fileCount: number }[];
}

export async function runAgent(opts: {
    task: string;
    workspace: VsCodeWorkspace;
    provider: { providerId: string; baseUrl?: string; apiKey?: string; model: string };
    signal: AbortSignal;
    callbacks: AgentCallbacks;
    priorMessages?: any[];
    /** How much Javelin may do without prompting. Default: ask before each change. */
    autonomy?: Autonomy;
}): Promise<RunResult> {
    const { task, workspace, provider, signal, callbacks, autonomy = AUTONOMY.ASK } = opts;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri;

    const memory = {
        steps: [] as any[],
        attempts: new Map<string, { count: number; failed: boolean }>(),
        checkpoints: [] as { id: string; label: string; timestamp: number; fileCount: number }[],
        alwaysAllow: new Set<string>(),
        touched: new Set<string>(),
    };

    const messages: any[] = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        ...(opts.priorMessages ?? []).slice(-12),
        {
            role: 'user',
            content: `Task: ${task}\n\nStart by inspecting the workspace, then state a short plan and execute it.`,
        },
    ];

    callbacks.onPhase('inspect');
    callbacks.onStatus('Inspecting the workspace…');

    for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) {
            callbacks.onPhase('done');
            return { status: 'aborted', summary: 'Stopped by user.', steps: memory.steps, checkpoints: memory.checkpoints };
        }

        let result;
        try {
            result = await streamCompletion({
                providerId: provider.providerId,
                baseUrl: provider.baseUrl,
                apiKey: provider.apiKey,
                model: provider.model,
                messages: buildRequestMessages(messages, memory),
                tools: TOOL_DEFS,
                signal,
                onToken: (delta) => callbacks.onAssistantDelta(delta),
            });
        } catch (error: any) {
            if (error?.name === 'AbortError' || signal.aborted) {
                callbacks.onPhase('done');
                return { status: 'aborted', summary: 'Stopped by user.', steps: memory.steps, checkpoints: memory.checkpoints };
            }
            return { status: 'failed', summary: error.message, steps: memory.steps, checkpoints: memory.checkpoints };
        }

        const { content, toolCalls } = result;

        messages.push({
            role: 'assistant',
            content: content || null,
            ...(toolCalls.length
                ? {
                    tool_calls: toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                    })),
                }
                : {}),
        });

        if (content?.trim()) {
            callbacks.onAssistantText(content.trim());
            if (step === 0) {
                callbacks.onPhase('plan');
            }
        }

        if (!toolCalls.length) {
            const finished = /^(done|finished|complete)/i.test(content ?? '');
            // Only accept a bare "done" once real work has happened. A model that says
            // "Done." before touching anything has not done the task.
            if ((finished && memory.steps.length > 0) || step === MAX_STEPS - 1) {
                callbacks.onPhase('done');
                return {
                    status: 'done',
                    summary: content?.trim() || 'Completed.',
                    steps: memory.steps,
                    checkpoints: memory.checkpoints,
                };
            }
            messages.push({
                role: 'user',
                content:
                    'You described an action but did not perform it. Do not narrate what you would do — ' +
                    'call the tool NOW to actually do it (write_file with the full contents, or ' +
                    'edit_file with the exact old_string/new_string). If the task is genuinely ' +
                    'complete, call `finish`.',
            });
            continue;
        }

        for (const call of toolCalls) {
            if (signal.aborted) {
                callbacks.onPhase('done');
                return { status: 'aborted', summary: 'Stopped by user.', steps: memory.steps, checkpoints: memory.checkpoints };
            }

            const signature = signatureOf(call.name, call.args);
            const prior = memory.attempts.get(signature);

            if (prior?.failed) {
                const note =
                    `You already tried \`${signature}\` and it failed. Do not repeat it. ` +
                    `Change your approach — re-read the file, use more context, or try a different method.`;
                callbacks.onReminder(note);
                messages.push({ role: 'tool', tool_call_id: call.id, content: note });
                continue;
            }
            memory.attempts.set(signature, { count: (prior?.count ?? 0) + 1, failed: false });

            if (call.name === 'finish') {
                const summary = call.args?.summary ?? 'Completed.';
                callbacks.onPhase('done');
                return { status: 'done', summary, steps: memory.steps, checkpoints: memory.checkpoints };
            }

            const approvalKey = approvalKeyFor(call);
            if (requiresApproval(call, autonomy) && !memory.alwaysAllow.has(approvalKey)) {
                const preview = await workspace.preview(call.name, call.args).catch(() => ({ diff: null }));
                const decision = await callbacks.requestApproval({
                    id: call.id,
                    name: call.name,
                    args: call.args,
                    diff: preview.diff,
                    path: call.args?.path,
                });
                if (decision.remember) {
                    memory.alwaysAllow.add(approvalKey);
                }
                if (!decision.approved) {
                    const note = `The user DENIED this action: ${call.name}. Do not retry it. Propose an alternative or stop and ask.`;
                    memory.attempts.set(signature, { count: 1, failed: true });
                    callbacks.onToolResult({ id: call.id, name: call.name, ok: false, output: note });
                    messages.push({ role: 'tool', tool_call_id: call.id, content: note });
                    continue;
                }
            }

            callbacks.onToolCall({ id: call.id, name: call.name, args: call.args });

            const outcome = await executeTool(call, {
                workspace,
                memory,
                callbacks,
                cwd,
                signal,
            });

            if (!outcome.ok) {
                memory.attempts.set(signature, { count: (prior?.count ?? 0) + 1, failed: true });
                callbacks.onPhase('recover');
            }
            if (call.name === 'run_command') {
                callbacks.onPhase('verify');
            }

            const record = {
                step: step + 1,
                name: call.name,
                args: call.args,
                ok: outcome.ok,
                output: outcome.output,
                diff: outcome.diff,
                timestamp: Date.now(),
            };
            memory.steps.push(record);
            callbacks.onToolResult({
                id: call.id,
                name: call.name,
                ok: outcome.ok,
                output: outcome.output,
                diff: outcome.diff,
            });
            messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(outcome.output, 6000) });
        }
    }

    const summary = `Stopped after ${MAX_STEPS} steps without an explicit finish.`;
    return { status: 'failed', summary, steps: memory.steps, checkpoints: memory.checkpoints };
}

/**
 * Tools that mutate workspace or run a command need a human gate — unless the
 * run is autonomous. `full` trusts Javelin to run anything it is not hard-blocked
 * from (the blocked list is still enforced in executeTool); `auto-edit` trusts edits
 * and deletes but still confirms unusual commands.
 */
function requiresApproval(call: ToolCall, autonomy: Autonomy = AUTONOMY.ASK): boolean {
    const mutates = call.name === 'write_file' || call.name === 'edit_file' || call.name === 'delete_file';
    const runsCommand = call.name === 'run_command';
    if (!mutates && !runsCommand) {
        return false;
    }
    if (autonomy === AUTONOMY.FULL) {
        return false;
    }
    if (autonomy === AUTONOMY.AUTO_EDIT) {
        return runsCommand && !isSafeCommand(call.args?.command ?? '');
    }
    return true;
}

function approvalKeyFor(call: ToolCall): string {
    if (call.name === 'run_command') {
        return `run_command:${String(call.args?.command ?? '').trim()}`;
    }
    return call.name;
}

async function executeTool(
    call: ToolCall,
    ctx: {
        workspace: VsCodeWorkspace;
        memory: any;
        callbacks: AgentCallbacks;
        cwd?: vscode.Uri;
        signal: AbortSignal;
    },
): Promise<{ ok: boolean; output: string; diff?: DiffResult | null }> {
    const args = call.args ?? {};
    try {
        switch (call.name) {
            case 'list_files': {
                return { ok: true, output: await ctx.workspace.list(args.path ?? '') };
            }
            case 'read_file': {
                const content = await ctx.workspace.read(args.path, args.start, args.end);
                return { ok: true, output: truncate(content, 16000) };
            }
            case 'search_code': {
                return { ok: true, output: await ctx.workspace.search(args.query, Boolean(args.isRegex)) };
            }
            case 'write_file': {
                const outcome = await ctx.workspace.write(args.path, args.content, Boolean(args.overwrite));
                ctx.memory.touched.add(outcome.path);
                const verb = outcome.before ? 'Rewrote' : 'Created';
                return {
                    ok: true,
                    diff: outcome.diff,
                    output: `${verb} ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
                };
            }
            case 'edit_file': {
                const outcome = await ctx.workspace.edit(
                    args.path,
                    args.old_string,
                    args.new_string,
                    Boolean(args.replace_all),
                );
                ctx.memory.touched.add(outcome.path);
                return {
                    ok: true,
                    diff: outcome.diff,
                    output: `Edited ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
                };
            }
            case 'delete_file': {
                const outcome = await ctx.workspace.delete(args.path);
                ctx.memory.touched.add(outcome.path);
                return {
                    ok: true,
                    diff: outcome.diff,
                    output: `Deleted ${outcome.path} (-${outcome.diff.removed} lines).`,
                };
            }
            case 'create_checkpoint': {
                const label = args.label ?? 'checkpoint';
                const cp = await ctx.workspace.snapshot(label, [...ctx.memory.touched]);
                ctx.memory.checkpoints.push(cp);
                ctx.callbacks.onCheckpoint(cp);
                return { ok: true, output: `Checkpoint "${cp.label}" created (${cp.fileCount} file(s)).` };
            }
            case 'run_command': {
                const command = args.command ?? '';
                if (isBlockedCommand(command)) {
                    return { ok: false, output: 'Blocked: this command is on the never-run list for safety.' };
                }
                if (!ctx.cwd) {
                    return { ok: false, output: 'No workspace folder is open, so commands cannot run.' };
                }
                const res = await runShellCommand(command, ctx.cwd, ctx.signal);
                ctx.callbacks.onCommand(command, res.output, res.exitCode);
                const output = [
                    `$ ${command}`,
                    `exit code: ${res.exitCode}`,
                    res.output ? truncate(res.output, 4000) : '(no output)',
                ].join('\n');
                return { ok: res.exitCode === 0, output };
            }
            default:
                return { ok: false, output: `Unknown tool: ${call.name}` };
        }
    } catch (error: any) {
        return { ok: false, output: `ERROR: ${error.message}` };
    }
}

/**
 * Run a command in a VS Code task-style terminal and capture both the output and
 * the exit code. A fresh terminal per command keeps output attributable.
 */
export async function runShellCommand(
    command: string,
    cwd: vscode.Uri,
    signal: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number>();
    let buffer = '';

    writeEmitter.event((data) => {
        buffer += data;
    });

    // The ExtensionTerminalOptions overload does not accept `cwd`, so change
    // directory explicitly before running the command.
    const cwdPath = cwd.fsPath;
    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => {
            writeEmitter.fire(`${command}\r\n`);
            // Run through the shell so `&&`, env vars and quoting behave as expected.
            writeEmitter.fire(`Set-Location -LiteralPath '${cwdPath}'; ${command}; exit $LASTEXITCODE\r\n`);
        },
        close: () => { },
    };

    // Pseudoterminal options (pty) are only accepted by the ExtensionTerminalOptions overload.
    const terminal = vscode.window.createTerminal({
        name: `Javelin: ${command.slice(0, 24)}`,
        pty,
        isTransient: true,
    });

    const exitCode = await new Promise<number>((resolve) => {
        let settled = false;
        let timeout: NodeJS.Timeout;
        const cancel = (): void => {
            terminal.dispose();
            finish(130);
        };
        const finish = (code: number): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', cancel);
            resolve(code);
        };
        timeout = setTimeout(() => finish(124), 120_000);
        signal.addEventListener('abort', cancel);
        closeEmitter.event((code) => finish(code ?? 0));
    });

    terminal.dispose();
    return { exitCode, output: stripAnsi(buffer) };
}

function stripAnsi(text: string): string {
    // Terminals emit colour codes; strip them so the model sees clean output.
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function buildRequestMessages(messages: any[], memory: any): any[] {
    const failures = [...memory.attempts.entries()]
        .filter(([, v]: any) => v.failed)
        .map(([sig]) => `- ${sig}`);
    if (!failures.length) {
        return messages;
    }
    const reminder = {
        role: 'system',
        content:
            'Actions you have ALREADY TRIED AND FAILED — never repeat these exact calls:\n' +
            failures.join('\n') +
            '\nTake a different approach for each.',
    };
    const [system, ...rest] = messages;
    return [system, ...rest.slice(0, -2), reminder, ...rest.slice(-2)];
}

function truncate(text: string, max: number): string {
    if (!text || text.length <= max) {
        return text ?? '';
    }
    return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}
