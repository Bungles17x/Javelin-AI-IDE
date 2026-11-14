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

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import * as vscode from 'vscode';
import { streamCompletion, ToolCall } from './providers';
import { VsCodeWorkspace, DiffResult } from './workspace';
import { AUTONOMY, Autonomy, canonicalizeToolCall } from './core/tools';
import { sanitizeAssistantOutput } from './core/assistantOutput';
import { resolveContinuationTask, taskRequiresWorkspaceChange } from './core/taskIntent';
import { ERROR_CODES, classifyModelError } from './core/errorCodes';

export const MAX_STEPS = 40;
const MAX_NO_ACTION_TURNS = 3;
/** Two normalised-identical responses in a row is a loop, not progress. */
const MAX_IDENTICAL_RESPONSES = 3;
/** Bounded retries for a transient model/transport failure. */
const MAX_MODEL_RETRIES = 2;
const FAILURE_REMINDER_PREFIX = 'Actions you have ALREADY TRIED AND FAILED';
/** Tools whose success must be proven on disk, not just reported. */
const MUTATING_TOOLS = ['write_file', 'append_file', 'edit_file', 'delete_file', 'create_folder', 'rename_file', 'copy_file'];
/** Steps allowed without a successful workspace change before the run is stopped. */
const MAX_STALLED_STEPS = 8;
/** Wall-clock budget for one run; the step cap still applies. */
const RUN_BUDGET_MS = 15 * 60_000;

function normalizeAssistantText(text: string): string {
    return String(text ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export const AGENT_SYSTEM_PROMPT = `You are Javelin AI, an autonomous coding agent working inside a real VS Code workspace. You do not just answer questions — you inspect the codebase, plan, make edits, run tests, and fix your own mistakes.

Operating rules:
1. INVESTIGATE BEFORE EDITING. Call list_files / read_file / search_code to understand the relevant code first. Never invent file paths — verify they exist.
2. READ BEFORE YOU WRITE. Always read a file before editing it. Use edit_file with an exact snippet for changes; if that snippet repeats, use the 1-based occurrence number and context provided by the error. Only use write_file for genuinely new files or a deliberate full replacement.
3. NEVER OVERWRITE BLINDLY. Do not replace a whole file to change a few lines. Match the existing style, imports and conventions of the project. For a file too large to write in one call, write the first chunk with write_file and extend it with append_file — chunked appends are expected for long files, and are safer than truncating one.
3b. LARGE FILES ARE NORMAL. A file may be thousands of lines. Build it in sections: write_file for the top of the file, then one append_file per following section (150-250 lines, under 24,000 characters per call). Never shrink the requested file to fit one call, never re-emit text you already wrote, and never call a file complete while your last section stopped mid-line — read the tail with read_file to confirm it ends cleanly.
4. PLAN BRIEFLY. On your first turn, state a 2-5 step plan in plain text, then begin executing it.
5. VERIFY YOUR WORK. Run the project's tests, build or linter when they exist. If a command fails, read the error, fix the cause, and run it again.
6. DO NOT REPEAT FAILED STEPS. If an action failed, change your approach rather than retrying it identically.
7. CHECKPOINT BEFORE RISKY WORK. Call create_checkpoint before a batch of related edits.
8. DO NOT CONFUSE INSPECTION WITH COMPLETION. For a task asking you to create, fix, or change something, a file listing or checkpoint is not enough — make a successful file or folder change before finishing. Seeing only a package-lock file is not proof the requested feature cannot be created.
9. STOP WHEN DONE. Call \`finish\` with an honest summary. Set verified: true only if you actually ran tests or a build and they passed.

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
            name: 'append_file',
            description:
                'Append text to the end of a file, creating it if it does not exist. Use this to build a large file in a few small tool calls instead of one enormous write_file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string', description: 'Text to append. Include its own trailing newline if needed.' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_folder',
            description: 'Create a directory (and any missing parents) inside the workspace.',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Directory path relative to the workspace root.' } },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description:
                'Replace an exact snippet in an existing file. If it occurs more than once, use the 1-based occurrence number from the error context, or provide more surrounding text. Use replace_all only when every match should change.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    old_string: { type: 'string' },
                    new_string: { type: 'string' },
                    replace_all: { type: 'boolean' },
                    occurrence: { type: 'integer', description: '1-based matching occurrence to replace when old_string is repeated. Do not combine with replace_all.' },
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
            name: 'rename_file',
            description: 'Rename or move a file inside the workspace. Refused if the destination already exists.',
            parameters: {
                type: 'object',
                properties: {
                    old_path: { type: 'string' },
                    new_path: { type: 'string' },
                },
                required: ['old_path', 'new_path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'copy_file',
            description: 'Copy a file inside the workspace. Refused if the destination already exists.',
            parameters: {
                type: 'object',
                properties: {
                    source_path: { type: 'string' },
                    dest_path: { type: 'string' },
                },
                required: ['source_path', 'dest_path'],
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
                'Signal the task is complete, with an honest summary. For create/fix/change tasks, a successful file or folder change is required before finishing. Set verified: true only if tests/build actually passed.',
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
            // A different slice of the same file is a different request.
            return `read_file:${a.path}:${a.start ?? ''}-${a.end ?? ''}`;
        case 'edit_file':
            return `edit_file:${a.path}:${signatureDigest(JSON.stringify([
                a.old_string,
                a.new_string,
                Boolean(a.replace_all),
                a.occurrence ?? null,
            ]))}`;
        case 'write_file':
            // Same path with different content is new work; identical content is a no-op.
            return `write_file:${a.path}:${signatureDigest(String(a.content ?? ''))}:${a.overwrite ? 'overwrite' : 'create'}`;
        case 'append_file':
            return `append_file:${a.path}:${signatureDigest(String(a.content ?? ''))}`;
        case 'delete_file':
            return `delete_file:${a.path}`;
        case 'create_folder':
            return `create_folder:${a.path}`;
        case 'rename_file':
            return `rename_file:${a.old_path}->${a.new_path}`;
        case 'copy_file':
            return `copy_file:${a.source_path}->${a.dest_path}`;
        case 'run_command':
            return `run_command:${String(a.command ?? '').trim()}`;
        case 'search_code':
            return `search_code:${a.query}:${a.isRegex ? 'regex' : 'literal'}`;
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
    onAssistantText: (text: string, repeated?: boolean) => void;
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
    /** Stable failure code; null for a clean finish. */
    code: string | null;
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
    const effectiveTask = resolveContinuationTask(task, opts.priorMessages ?? []);

    const memory = {
        steps: [] as any[],
        attempts: new Map<string, { count: number; failed: boolean; denied?: boolean; progressVersion?: number }>(),
        checkpoints: [] as { id: string; label: string; timestamp: number; fileCount: number }[],
        alwaysAllow: new Set<string>(),
        touched: new Set<string>(),
        // How many times the workspace has actually changed; a failed step may be
        // retried once the workspace differs, but not against an unchanged one.
        progressVersion: 0,
        usedToolCallIds: new Set<string>(),
        toolCallSeq: 0,
    };
    let noActionTurns = 0;
    let identicalNoActionResponses = 0;
    let lastAssistantText = '';
    let finalStepRequested = false;

    const messages: any[] = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        ...(opts.priorMessages ?? [])
            .slice(-12)
            .map((message) => ({
                role: message.role,
                content: message.role === 'assistant'
                    ? sanitizeAssistantOutput(String(message.content ?? ''))
                    : String(message.content ?? ''),
            }))
            .filter((message) => message.content),
        {
            role: 'user',
            content: taskRequiresWorkspaceChange(effectiveTask)
                ? `Task: ${effectiveTask}\n\nStart by inspecting the workspace, then state a short plan and execute it.`
                : `Task: ${effectiveTask}\n\nIf this needs project-specific facts, inspect the relevant files first. Otherwise, answer directly. Do not invent workspace changes; finish with your answer.`,
        },
    ];

    callbacks.onPhase('inspect');
    callbacks.onStatus('Inspecting the workspace…');

    let lastMutationStep = 0;
    const startedAt = Date.now();

    for (let step = 0; step < MAX_STEPS; step++) {
        if (Date.now() - startedAt > RUN_BUDGET_MS) {
            const budgetSummary = `Stopped after ${Math.round(RUN_BUDGET_MS / 60000)} minutes; the run exceeded its time budget.`;
            callbacks.onReminder(budgetSummary);
            callbacks.onPhase('done');
            return { status: 'failed', summary: budgetSummary, code: ERROR_CODES.TIME_BUDGET, steps: memory.steps, checkpoints: memory.checkpoints };
        }
        if (signal.aborted) {
            callbacks.onPhase('done');
            return { status: 'aborted', summary: 'Stopped by user.', code: ERROR_CODES.ABORTED, steps: memory.steps, checkpoints: memory.checkpoints };
        }

        // Ask the model to wrap up before the hard step budget runs out, once.
        if (!finalStepRequested && step === MAX_STEPS - 1) {
            finalStepRequested = true;
            messages.push({
                role: 'user',
                content:
                    'This is your final step. Either call one more tool that completes the requested work, or call `finish` with an honest summary of what changed and what you verified.',
            });
        }

        const generation = await generateWithRetry({
            signal,
            callbacks,
            request: {
                providerId: provider.providerId,
                baseUrl: provider.baseUrl,
                apiKey: provider.apiKey,
                model: provider.model,
                messages: ensureToolResultPairing(buildRequestMessages(messages, memory)),
                tools: TOOL_DEFS,
                signal,
            },
        });
        if (generation.aborted) {
            callbacks.onPhase('done');
            return { status: 'aborted', summary: 'Stopped by user.', code: ERROR_CODES.ABORTED, steps: memory.steps, checkpoints: memory.checkpoints };
        }
        if (!generation.result) {
            const message = generation.error?.message ?? 'The model request failed.';
            return { status: 'failed', summary: message, code: classifyModelError(message), steps: memory.steps, checkpoints: memory.checkpoints };
        }
        const result = generation.result;

        const toolCalls = (result.toolCalls ?? []).map((call: ToolCall) => normalizeToolCallForRun(call, memory, cwd?.fsPath));
        const content = sanitizeAssistantOutput(result.content);

        let repeatedText = false;
        if (content?.trim()) {
            const normalizedText = normalizeAssistantText(content);
            repeatedText = Boolean(normalizedText && normalizedText === lastAssistantText);
            callbacks.onAssistantText(content.trim(), repeatedText);
            lastAssistantText = normalizedText;
            if (step === 0) {
                callbacks.onPhase('plan');
            }
        } else {
            lastAssistantText = '';
        }

        // Record the assistant turn, including tool calls. A repeated narration with
        // no tool calls is not appended again: echoing it back teaches small models
        // to keep repeating, and it is already in the transcript.
        if (toolCalls.length || (content.trim() && !repeatedText)) {
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
        }

        if (!toolCalls.length) {
            if (!taskRequiresWorkspaceChange(effectiveTask) && content.trim()) {
                callbacks.onPhase('done');
                return {
                    status: 'done',
                    summary: content.trim(),
                    code: null,
                    steps: memory.steps,
                    checkpoints: memory.checkpoints,
                };
            }
            noActionTurns += 1;
            identicalNoActionResponses = repeatedText ? identicalNoActionResponses + 1 : 0;
            // Remove the echoed reply so the model cannot simply copy it again.
            if (repeatedText) {
                dropLastAssistantText(messages);
            }
            // The requested change already landed; the model is describing it rather
            // than calling `finish`. End with its summary instead of failing the run.
            const missing = await missingRequestedPaths(effectiveTask, workspace);
            const completedSoFar = taskRequiresWorkspaceChange(effectiveTask)
                && memory.steps.some((record) => MUTATING_TOOLS.includes(record.name) && record.ok)
                && missing.length === 0;
            if (missing.length) {
                callbacks.onReminder(`Still missing: ${missing.join(', ')}. Create ${missing.length === 1 ? 'it' : 'them'} before describing the task as complete.`);
            }
            if (completedSoFar && (repeatedText || noActionTurns >= 2)) {
                const summary = content.trim() || 'Completed the requested changes.';
                callbacks.onReminder('The model described the result instead of calling `finish`; ending the run with its summary.');
                callbacks.onPhase('done');
                return { status: 'done', summary, code: null, steps: memory.steps, checkpoints: memory.checkpoints };
            }
            const repeatedOutOfBudget = repeatedText && identicalNoActionResponses + 1 >= MAX_IDENTICAL_RESPONSES;
            if (repeatedOutOfBudget || noActionTurns >= MAX_NO_ACTION_TURNS) {
                if (missing.length) {
                    const missingSummary = `Stopped without creating ${missing.join(', ')}. The model described the result instead of finishing the requested work.`;
                    callbacks.onReminder(missingSummary);
                    callbacks.onPhase('done');
                    return { status: 'failed', summary: missingSummary, code: ERROR_CODES.MISSING_FILES, steps: memory.steps, checkpoints: memory.checkpoints };
                }
                const toolHint = memory.steps.length === 0
                    ? ' The model made no tool calls at all, which usually means it does not support tool calling — choose a tool-capable model, or restate the task with concrete file names.'
                    : '';
                const summary = (repeatedText
                    ? `Stopped after ${identicalNoActionResponses + 1} identical responses without a tool action; the model kept repeating itself.`
                    : `Stopped after ${MAX_NO_ACTION_TURNS} responses without a tool action.`) + toolHint;
                callbacks.onReminder(summary);
                callbacks.onPhase('done');
                return {
                    status: 'failed',
                    summary,
                    code: repeatedText ? ERROR_CODES.IDENTICAL_RESPONSES : ERROR_CODES.NO_ACTION,
                    steps: memory.steps,
                    checkpoints: memory.checkpoints,
                };
            }
            messages.push({
                role: 'user',
                content: repeatedText
                    ? 'You repeated the same message instead of acting, so it was removed. Do not restate it. Your next reply must be exactly one tool call and no prose — call the relevant tool now to make progress.'
                    : 'You described an action but did not perform it. Do not narrate what you would do — call the tool NOW to actually do it (write_file with the full contents, or edit_file with the exact old_string/new_string). If the task is genuinely complete, call `finish`.',
            });
            continue;
        }
        noActionTurns = 0;
        identicalNoActionResponses = 0;

        for (const call of toolCalls) {
            if (signal.aborted) {
                callbacks.onPhase('done');
                return { status: 'aborted', summary: 'Stopped by user.', code: ERROR_CODES.ABORTED, steps: memory.steps, checkpoints: memory.checkpoints };
            }

            const signature = signatureOf(call.name, call.args);
            const prior = memory.attempts.get(signature);
            // Block a call already attempted against this exact workspace state. A
            // user-denied action stays blocked; a failed one may be retried once the
            // workspace has changed (re-running tests after a fix is the verify loop).
            const sameWorkspaceSinceAttempt = prior && prior.progressVersion === memory.progressVersion;

            if (prior?.denied || sameWorkspaceSinceAttempt) {
                const note =
                    `BLOCKED: \`${signature}\` was already attempted with this unchanged workspace. ` +
                    `Use the result already in context or choose a materially different action.`;
                callbacks.onReminder(note);
                callbacks.onToolResult({ id: call.id, name: call.name, ok: false, output: note });
                messages.push({ role: 'tool', tool_call_id: call.id, content: note });
                continue;
            }
            memory.attempts.set(signature, {
                count: (prior?.count ?? 0) + 1,
                failed: false,
                progressVersion: memory.progressVersion,
            });

            if (call.name === 'finish') {
                const hasSuccessfulMutation = memory.steps.some((record) => MUTATING_TOOLS.includes(record.name) && record.ok);
                const missing = await missingRequestedPaths(effectiveTask, workspace);
                if (taskRequiresWorkspaceChange(effectiveTask) && (!hasSuccessfulMutation || missing.length)) {
                    const note =
                        'Finish refused: this task asks for a workspace change, but no file or folder change has succeeded. ' +
                        (missing.length
                            ? `The task also names ${missing.join(', ')}, which ${missing.length === 1 ? 'does not exist' : 'do not exist'} yet. `
                            : '') +
                        'A file listing or checkpoint alone is not completion. Inspect the relevant files, make the requested change, and verify it before finishing.';
                    callbacks.onToolCall({ id: call.id, name: call.name, args: call.args });
                    callbacks.onReminder(note);
                    callbacks.onToolResult({ id: call.id, name: call.name, ok: false, output: note });
                    callbacks.onPhase('act');
                    messages.push({ role: 'tool', tool_call_id: call.id, content: note });
                    messages.push({
                        role: 'user',
                        content: 'Continue the requested implementation. Do not create another checkpoint or call finish until a file or folder change succeeds.',
                    });
                    continue;
                }
                const summary = call.args?.summary ?? 'Completed.';
                callbacks.onPhase('done');
                return { status: 'done', summary, code: null, steps: memory.steps, checkpoints: memory.checkpoints };
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
                    memory.attempts.set(signature, { count: 1, failed: true, denied: true, progressVersion: memory.progressVersion });
                    callbacks.onToolResult({ id: call.id, name: call.name, ok: false, output: note });
                    messages.push({ role: 'tool', tool_call_id: call.id, content: note });
                    continue;
                }
            }

            callbacks.onToolCall({ id: call.id, name: call.name, args: call.args });

            let outcome = await executeTool(call, {
                workspace,
                memory,
                callbacks,
                cwd,
                signal,
            });

            // A tool reporting success is not proof the file changed on disk.
            if (outcome.ok && MUTATING_TOOLS.includes(call.name)) {
                const verification = await verifyMutation(call, workspace);
                if (!verification.ok) {
                    outcome = {
                        ...outcome,
                        ok: false,
                        output: `${outcome.output}\n\nVERIFICATION FAILED: ${verification.reason}`,
                    };
                }
            }

            if (!outcome.ok) {
                memory.attempts.set(signature, {
                    count: (prior?.count ?? 0) + 1,
                    failed: true,
                    progressVersion: memory.progressVersion,
                });
                callbacks.onPhase('recover');
            } else if (MUTATING_TOOLS.includes(call.name)) {
                lastMutationStep = step;
                memory.progressVersion += 1;
                memory.attempts.set(signature, {
                    count: (prior?.count ?? 0) + 1,
                    failed: false,
                    progressVersion: memory.progressVersion,
                });
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

        if (taskRequiresWorkspaceChange(effectiveTask) && step - lastMutationStep >= MAX_STALLED_STEPS) {
            const summary = `Stopped after ${MAX_STALLED_STEPS} steps without changing the workspace. The requested change was not made.`;
            callbacks.onReminder(summary);
            callbacks.onPhase('done');
            return { status: 'failed', summary, code: ERROR_CODES.STALLED, steps: memory.steps, checkpoints: memory.checkpoints };
        }
    }

    const summary = `Stopped after ${MAX_STEPS} steps without an explicit finish.`;
    return { status: 'failed', summary, code: ERROR_CODES.STEP_LIMIT, steps: memory.steps, checkpoints: memory.checkpoints };
}

/**
 * Tools that mutate workspace or run a command need a human gate — unless the
 * run is autonomous. `full` trusts Javelin to run anything it is not hard-blocked
 * from (the blocked list is still enforced in executeTool); `auto-edit` trusts edits
 * and deletes but still confirms unusual commands.
 */
function requiresApproval(call: ToolCall, autonomy: Autonomy = AUTONOMY.ASK): boolean {
    const mutates = MUTATING_TOOLS.includes(call.name);
    const deletesFile = call.name === 'delete_file';
    const runsCommand = call.name === 'run_command';
    if (!mutates && !runsCommand) {
        return false;
    }
    if (autonomy === AUTONOMY.FULL) {
        return false;
    }
    if (autonomy === AUTONOMY.AUTO_EDIT) {
        // auto-edit trusts edits, not deletions. Removing a whole file stays behind
        // the approval prompt unless the run is explicitly `full`.
        if (deletesFile || call.name === 'rename_file') {
            return true;
        }
        return runsCommand && !isSafeCommand(call.args?.command ?? '');
    }
    return true;
}

function approvalKeyFor(call: ToolCall): string {
    if (call.name === 'run_command') {
        return `run_command:${String(call.args?.command ?? '').trim()}`;
    }
    // Consent for one rename/copy is never silently reused for another file.
    if (call.name === 'rename_file') {
        return `rename_file:${call.args?.old_path ?? ''}->${call.args?.new_path ?? ''}`;
    }
    if (call.name === 'copy_file') {
        return `copy_file:${call.args?.source_path ?? ''}->${call.args?.dest_path ?? ''}`;
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
    call = canonicalizeToolCall(call);
    const args = call.args ?? {};
    if (args.__parseError) {
        return {
            ok: false,
            output:
                'Your tool-call arguments were not valid JSON, so nothing was executed. Re-issue the call with a well-formed arguments object.',
        };
    }
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
                const tooLarge = writeChunkLimit(args.content);
                if (tooLarge) return { ok: false, output: tooLarge };
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
                    args.occurrence,
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
            case 'append_file': {
                const tooLarge = writeChunkLimit(args.content);
                if (tooLarge) return { ok: false, output: tooLarge };
                const outcome = await ctx.workspace.append(args.path, args.content);
                ctx.memory.touched.add(outcome.path);
                return {
                    ok: true,
                    diff: outcome.diff,
                    output: `Appended to ${outcome.path} (+${outcome.diff.added} / -${outcome.diff.removed} lines).`,
                };
            }
            case 'create_folder': {
                const outcome = await ctx.workspace.createFolder(args.path);
                return {
                    ok: true,
                    output: outcome.created
                        ? `Created folder ${outcome.path}.`
                        : `Folder ${outcome.path} already existed.`,
                };
            }
            case 'rename_file': {
                const outcome = await ctx.workspace.rename(args.old_path, args.new_path);
                ctx.memory.touched.add(outcome.path);
                return { ok: true, diff: outcome.diff, output: `Renamed ${args.old_path} to ${outcome.path}.` };
            }
            case 'copy_file': {
                const outcome = await ctx.workspace.copy(args.source_path, args.dest_path);
                ctx.memory.touched.add(outcome.path);
                return {
                    ok: true,
                    diff: outcome.diff,
                    output: `Copied ${args.source_path} to ${outcome.path} (+${outcome.diff.added} lines).`,
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
                return {
                    ok: false,
                    output: `Unsupported tool "${call.name}". Available tools: ${TOOL_DEFS.map((tool) => tool.function.name).join(', ')}. Use write_file with path and content to create a file, or create_folder with path to create a directory.`,
                };
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
        const timeout = setTimeout(() => finish(124), 120_000);
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

/**
 * Inject failure memory into the request so the model sees what it must not repeat.
 *
 * The reminder goes immediately after the system prompt. Inserting it later can
 * split an assistant `tool_calls` message from its `tool` results, and a provider
 * rejects that transcript — costing the model every result it needs to continue.
 */
function buildRequestMessages(messages: any[], memory: any): any[] {
    const kept = messages.filter((message) => !isFailureReminder(message));
    const reminder = failureReminder(memory);
    if (!reminder) {
        return kept;
    }
    const [system, ...rest] = kept;
    return system ? [system, reminder, ...rest] : [reminder, ...kept];
}

function isFailureReminder(message: any): boolean {
    return (
        message?.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.startsWith(FAILURE_REMINDER_PREFIX)
    );
}

function failureReminder(memory: any): any | null {
    const failures = [...memory.attempts.entries()]
        .filter(([, value]: any) => value.failed)
        .map(([signature]) => `- ${signature}`);
    if (!failures.length) {
        return null;
    }
    return {
        role: 'system',
        content:
            `${FAILURE_REMINDER_PREFIX} — never repeat these exact calls:\n` +
            failures.join('\n') +
            '\nTake a different approach for each.',
    };
}

/**
 * Guarantee one tool result per tool call id, in order. A transcript where a tool
 * call has no result is rejected by OpenAI-compatible servers, so any gap is filled
 * rather than losing the run to a protocol error.
 */
function ensureToolResultPairing(messages: any[]): any[] {
    const out: any[] = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        out.push(message);
        if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
            continue;
        }
        const answered = new Set<string>();
        let next = index + 1;
        while (next < messages.length && messages[next]?.role === 'tool') {
            answered.add(messages[next].tool_call_id);
            out.push(messages[next]);
            next++;
        }
        for (const call of message.tool_calls) {
            if (answered.has(call.id)) {
                continue;
            }
            out.push({ role: 'tool', tool_call_id: call.id, content: 'No result was recorded for this call.' });
        }
        index = next - 1;
    }
    return out;
}

/** Bounded retry on transient transport/server failures. */
async function generateWithRetry(opts: {
    request: Parameters<typeof streamCompletion>[0];
    signal: AbortSignal;
    callbacks: AgentCallbacks;
}): Promise<{
    result: Awaited<ReturnType<typeof streamCompletion>> | null;
    error: Error | null;
    aborted: boolean;
}> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
        if (opts.signal.aborted) {
            return { result: null, error: null, aborted: true };
        }
        try {
            return { result: await streamCompletion(opts.request), error: null, aborted: false };
        } catch (error: any) {
            if (error?.name === 'AbortError' || opts.signal.aborted) {
                return { result: null, error: null, aborted: true };
            }
            lastError = error instanceof Error ? error : new Error(String(error?.message ?? error));
            if (attempt >= MAX_MODEL_RETRIES || !isRetryableModelError(lastError)) {
                break;
            }
            opts.callbacks.onStatus(
                `The model request failed (${lastError.message}); retrying (${attempt + 1}/${MAX_MODEL_RETRIES})…`,
            );
            await delay(120 * 2 ** attempt);
        }
    }
    return { result: null, error: lastError ?? new Error('The model request failed.'), aborted: false };
}

function isRetryableModelError(error: Error): boolean {
    return /could not reach|network|fetch failed|econnreset|etimedout|eai_again|socket hang up|provider error (?:429|5\d\d)/i.test(
        error.message,
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tool arguments that name a workspace path. */
const PATH_ARGUMENTS: Record<string, string[]> = {
    list_files: ['path'],
    read_file: ['path'],
    write_file: ['path'],
    edit_file: ['path'],
    delete_file: ['path'],
};

/**
 * Canonicalise name, path arguments and id before anything else sees the call, so
 * signatures, approvals, transcripts and tool results all refer to the same file
 * and the same call.
 */
function normalizeToolCallForRun(
    call: ToolCall,
    memory: { usedToolCallIds: Set<string>; toolCallSeq: number },
    rootFsPath?: string,
): ToolCall {
    const normalized = canonicalizeToolCall(call);
    const keys = PATH_ARGUMENTS[normalized.name];
    let args = normalized.args ?? {};
    if (keys) {
        let changed = false;
        args = { ...args };
        for (const key of keys) {
            const value = args[key];
            if (typeof value !== 'string') {
                continue;
            }
            const next = toWorkspaceRelative(value, rootFsPath);
            if (next !== value) {
                args[key] = next;
                changed = true;
            }
        }
        if (!changed) {
            args = normalized.args ?? {};
        }
    }

    let id = typeof normalized.id === 'string' && normalized.id.trim() ? normalized.id.trim() : '';
    if (!id || memory.usedToolCallIds.has(id)) {
        memory.toolCallSeq += 1;
        id = `call_${memory.toolCallSeq}`;
        while (memory.usedToolCallIds.has(id)) {
            memory.toolCallSeq += 1;
            id = `call_${memory.toolCallSeq}`;
        }
    }
    memory.usedToolCallIds.add(id);
    return { ...normalized, id, args };
}

/** Normalise a model path, stripping a known workspace-root prefix. */
function toWorkspaceRelative(path: string, rootFsPath?: string): string {
    let value = String(path ?? '').trim();
    const quoted = value.match(/^([`'"])([\s\S]*)\1$/);
    if (quoted) {
        value = quoted[2].trim();
    }
    value = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    const root = rootFsPath?.replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && value.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        value = value.slice(root.length + 1);
    }
    while (value.startsWith('./')) {
        value = value.slice(2);
    }
    return value.replace(/\/\.\//g, '/');
}

/**
 * Confirm a mutation really landed on disk, so a silently dropped or truncated
 * write becomes a retryable failure instead of a false success the model builds on.
 */
async function verifyMutation(
    call: ToolCall,
    workspace: VsCodeWorkspace,
): Promise<{ ok: boolean; reason?: string }> {
    const args = call.args ?? {};
    const readback = async (path: string): Promise<string | null> => {
        try {
            return await workspace.read(path);
        } catch {
            return null;
        }
    };

    try {
        if (call.name === 'write_file') {
            const path = String(args.path ?? '');
            const actual = await readback(path);
            if (actual === null) {
                return { ok: false, reason: `write_file reported success but ${path} does not exist on disk. Write it again.` };
            }
            if (comparableContent(actual) !== comparableContent(args.content)) {
                return {
                    ok: false,
                    reason: `write_file reported success but ${path} does not match the content you sent. Read the file and write it again.`,
                };
            }
            return { ok: true };
        }

        if (call.name === 'edit_file') {
            const path = String(args.path ?? '');
            const actual = await readback(path);
            if (actual === null) {
                return { ok: false, reason: `edit_file reported success but ${path} does not exist on disk.` };
            }
            const replacement = String(args.new_string ?? '').replace(/\r\n/g, '\n');
            if (replacement && !actual.replace(/\r\n/g, '\n').includes(replacement)) {
                return {
                    ok: false,
                    reason: `edit_file reported success but the new text is not present in ${path}. Re-read the file and retry with an exact snippet.`,
                };
            }
            return { ok: true };
        }

        if (call.name === 'delete_file') {
            const path = String(args.path ?? '');
            if ((await readback(path)) !== null) {
                return { ok: false, reason: `delete_file reported success but ${path} still exists on disk.` };
            }
            return { ok: true };
        }

        if (call.name === 'rename_file') {
            const newPath = String(args.new_path ?? '');
            const oldPath = String(args.old_path ?? '');
            if ((await readback(newPath)) === null) {
                return { ok: false, reason: `rename_file reported success but ${newPath} does not exist on disk.` };
            }
            if ((await readback(oldPath)) !== null) {
                return { ok: false, reason: `rename_file reported success but ${oldPath} still exists on disk.` };
            }
            return { ok: true };
        }

        if (call.name === 'copy_file') {
            const destPath = String(args.dest_path ?? '');
            const actual = await readback(destPath);
            if (actual === null) {
                return { ok: false, reason: `copy_file reported success but ${destPath} does not exist on disk.` };
            }
            const source = await readback(String(args.source_path ?? ''));
            if (source !== null && comparableContent(actual) !== comparableContent(source)) {
                return { ok: false, reason: `copy_file reported success but ${destPath} does not match ${args.source_path}.` };
            }
            return { ok: true };
        }

        if (call.name === 'append_file') {
            const path = String(args.path ?? '');
            const actual = await readback(path);
            if (actual === null) {
                return { ok: false, reason: `append_file reported success but ${path} does not exist.` };
            }
            const appended = String(args.content ?? '').replace(/\r\n/g, '\n');
            if (appended && !actual.replace(/\r\n/g, '\n').includes(appended)) {
                return { ok: false, reason: `append_file reported success but the appended text is not present in ${path}.` };
            }
            return { ok: true };
        }

        return { ok: true };
    } catch (error: any) {
        return { ok: false, reason: `${call.name} could not be verified: ${error?.message ?? 'unknown error'}` };
    }
}

/** Compare file contents ignoring line-ending and trailing-whitespace differences. */
function comparableContent(text: unknown): string {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function truncate(text: string, max: number): string {
    if (!text || text.length <= max) {
        return text ?? '';
    }
    return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/** Remove the most recent assistant text message (the echo a small model repeats). */
function dropLastAssistantText(messages: any[]): void {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role === 'system') return;
        if (message.role !== 'assistant') continue;
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) return;
        if (typeof message.content !== 'string' || !message.content.trim()) return;
        messages.splice(index, 1);
        return;
    }
}

const REQUESTED_FILE_PATTERN =
    /(?:^|[\s`'"([{,:])((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|markdown|css|scss|sass|less|html|htm|py|rb|go|rs|java|kt|kts|cs|php|sh|ps1|bat|yml|yaml|toml|ini|cfg|xml|sql|txt|csv))(?=$|[\s`'"),;:!?}])/gi;

/** Files the task explicitly names, so completion can be checked objectively. */
function requestedPaths(task: string): string[] {
    const found = new Set<string>();
    for (const match of String(task ?? '').matchAll(REQUESTED_FILE_PATTERN)) {
        const raw = match[1];
        if (!raw || /^https?:/i.test(raw) || /^[a-z]:[\\/]/i.test(raw) || raw.includes('..')) continue;
        found.add(raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/'));
    }
    return [...found];
}

async function missingRequestedPaths(task: string, workspace: VsCodeWorkspace): Promise<string[]> {
    const missing: string[] = [];
    for (const candidate of requestedPaths(task)) {
        let exists = false;
        try {
            // `read` is the public existence check here; `exists` is private to the
            // workspace and not part of the interface the agent is given.
            await workspace.read(candidate);
            exists = true;
        } catch {
            exists = false;
        }
        if (!exists) missing.push(candidate);
    }
    return missing;
}

const MAX_WRITE_CHARS = 24_000;

/** Refuse a single write that is too large to have been emitted intact. */
function writeChunkLimit(content: unknown): string | null {
    const text = String(content ?? '');
    if (text.length <= MAX_WRITE_CHARS) return null;
    return `That content is ${text.length.toLocaleString()} characters, but one call may contain at most ${MAX_WRITE_CHARS.toLocaleString()}. Split the file: write the beginning with write_file, then append each following section with append_file (roughly 150-250 lines per call). Do not shorten the requested file to fit one call.`;
}

function signatureDigest(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}
