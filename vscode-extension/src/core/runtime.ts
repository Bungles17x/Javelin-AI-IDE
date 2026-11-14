/**
 * Javelin Core for VS Code — runtime and facade.
 *
 * The runtime is Javelin's own control loop: it owns the phase machine, tool
 * dispatch with approval gating, failure tracking that blocks dead actions,
 * memory observation, and the verification policy.
 *
 * It is engine-agnostic and workspace-agnostic — the VS Code build simply hands
 * it the real filesystem and a real shell.
 */

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import { EngineRegistry, EngineDescriptor } from './engines';
import { JavelinMemory, MemorySnapshot, actionSignature } from './memory';
import { createStandardToolset, canonicalizeToolCall, RISK, AUTONOMY, Autonomy, ToolRegistry } from './tools';
import {
    PHASE, PHASE_LABEL, buildPhaseMessages, nextPhase, verificationPolicy,
    classifyCommandResult, extractPlan, extractPlanSteps, extractHypothesis, summariseRun,
} from './brain';
import { sanitizeAssistantOutput } from './assistantOutput';
import { resolveContinuationTask, taskRequiresWorkspaceChange } from './taskIntent';
import { VsCodeWorkspace } from '../workspace';

export const DEFAULT_MAX_STEPS = 30;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface JavelinEvents {
    onPhase?: (phase: string, label: string) => void;
    onPlan?: (plan: string, steps?: string[]) => void;
    onHypothesis?: (hypothesis: string) => void;
    onThinkingDelta?: (delta: string) => void;
    onThinking?: (text: string, repeated?: boolean) => void;
    onToolCall?: (call: { id: string; name: string; args: any }) => void;
    onToolResult?: (result: { id: string; name: string; ok: boolean; output: string; diff?: any }) => void;
    onCheckpoint?: (cp: any) => void;
    onReminder?: (note: string) => void;
    onCommand?: (command: string, output: string, exitCode: number) => void;
    requestApproval?: (req: any) => Promise<{ approved: boolean; remember?: boolean }>;
}

export interface JavelinRunResult {
    status: 'done' | 'aborted' | 'failed';
    summary: string;
    rawSummary: string;
    verified: boolean;
    steps: any[];
    checkpoints: any[];
    filesTouched: string[];
    hypotheses: string[];
    /** Id of the automatic pre-run checkpoint, so the caller can offer a one-click revert. */
    baseline: string | null;
}

export async function runJavelin(opts: {
    task: string;
    priorMessages?: Array<{ role?: string; content?: string }>;
    workspace: VsCodeWorkspace;
    engines: EngineRegistry;
    signal: AbortSignal;
    memory: JavelinMemory;
    events?: JavelinEvents;
    runCommand?: (cmd: string, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string; output?: string }>;
    tools?: ToolRegistry;
    maxSteps?: number;
    /** How much Javelin may do without prompting. Default: ask before each change. */
    autonomy?: Autonomy;
}): Promise<JavelinRunResult> {
    const {
        task, workspace, engines, signal, memory,
        priorMessages = [],
        events = {}, runCommand, tools = createStandardToolset(),
        maxSteps = DEFAULT_MAX_STEPS,
        autonomy = AUTONOMY.ASK,
    } = opts;
    const effectiveTask = resolveContinuationTask(task, priorMessages);
    const transcript: any[] = priorMessages
        .filter((message) => ['user', 'assistant'].includes(message?.role ?? ''))
        .map((message) => ({
            role: message.role,
            content: message.role === 'assistant'
                ? sanitizeAssistantOutput(message.content ?? '')
                : String(message.content ?? '').trim(),
        }))
        .filter((message) => message.content);

    const state = {
        phase: PHASE.UNDERSTAND as string,
        stepsTaken: 0,
        hasEdited: false,
        planStated: false,
        plan: null as string | null,
        consecutiveFailures: 0,
        verificationFailed: false,
        verificationReason: null as string | null,
        commandCount: 0,
        verified: false,
        lastResponseText: '',
    };

    const run = {
        status: 'failed' as 'done' | 'aborted' | 'failed',
        summary: '',
        steps: [] as any[],
        checkpoints: [] as any[],
        filesTouched: new Set<string>(),
        /** Id of the automatic pre-run checkpoint — the guaranteed revert target. */
        baseline: null as string | null,
    };

    const failures: string[] = [];
    const hypotheses: string[] = [];
    const alwaysAllow = new Set<string>();

    // Index the project once per run so the reasoner is grounded in reality.
    if (typeof (workspace as any).snapshotFiles === 'function') {
        memory.indexProject(await (workspace as any).snapshotFiles());
    }

    const emitPhase = () => events.onPhase?.(state.phase, PHASE_LABEL[state.phase] ?? state.phase);
    emitPhase();

    // AUTOMATIC BASELINE.
    //
    // The agent is *told* to checkpoint before risky work, but an agent that
    // corrupts a file is exactly the agent that skipped that step. So the safety
    // net is taken here, by the runtime, before the first tool call — the agent
    // cannot forget it, decline it, or run before it exists. This is what makes
    // "revert everything" always available, even after a bad run.
    try {
        const baseline = await workspace.snapshot(
            `Start of run — ${effectiveTask.slice(0, 48)}${effectiveTask.length > 48 ? '…' : ''}`,
        );
        run.checkpoints.push(baseline);
        run.baseline = baseline.id;
        events.onCheckpoint?.(baseline);
    } catch (error: any) {
        // A workspace we cannot snapshot is a workspace we cannot safely edit.
        return {
            status: 'failed',
            summary:
                `Could not take a safety checkpoint before starting (${error.message}). ` +
                `Nothing was changed — refusing to edit files we cannot revert.`,
            rawSummary: 'baseline checkpoint failed',
            verified: false,
            steps: [],
            checkpoints: [],
            filesTouched: [],
            hypotheses: [],
            baseline: null,
        };
    }

    try {
        for (let step = 0; step < maxSteps; step++) {
            if (signal.aborted) {
                return finishAborted();
            }

            const engine: EngineDescriptor = await engines.bestAvailable(
                state.phase === PHASE.PLAN ? 'plan' : 'primary',
            );
            emitPhase();

            const memoryBlock = buildMemoryBlock(memory, effectiveTask, state, failures);

            let response;
            try {
                response = await engine.generate({
                    messages: buildPhaseMessages({
                        task: effectiveTask, phase: state.phase, transcript, memoryBlock, failures, plan: state.plan,
                    }),
                    tools: tools.schemas(),
                    signal,
                });
            } catch (error: any) {
                if (error?.name === 'AbortError' || signal.aborted) {
                    return finishAborted();
                }
                run.summary = `Engine failure: ${error.message}`;
                run.status = 'failed';
                return finalise();
            }

            const text = sanitizeAssistantOutput(response.text);
            const toolCalls = (response.toolCalls ?? []).map(canonicalizeToolCall);
            const normalizedText = normalizeResponseText(text);
            const repeatedText = Boolean(normalizedText && normalizedText === state.lastResponseText);
            state.lastResponseText = normalizedText;

            if (text.trim()) {
                events.onThinking?.(text.trim(), repeatedText);
                transcript.push({ role: 'assistant', content: text.trim() });

                if (state.phase === PHASE.PLAN && !state.planStated) {
                    const plan = extractPlan(text);
                    if (plan) {
                        state.plan = plan;
                        state.planStated = true;
                        // Pass the parsed task steps too, so the UI can render a
                        // checklist it ticks off as the run progresses.
                        events.onPlan?.(plan, extractPlanSteps(plan));
                    }
                }
                if (state.phase === PHASE.REPAIR) {
                    const h = extractHypothesis(text);
                    if (h) {
                        hypotheses.push(h);
                        state.plan = `Repair hypothesis: ${h}`;
                        events.onHypothesis?.(h);
                    }
                }
            } else {
                state.lastResponseText = '';
            }

            if (!toolCalls.length) {
                if (state.phase === PHASE.UNDERSTAND) {
                    state.phase = PHASE.PLAN;
                    continue;
                }
                if (state.phase === PHASE.PLAN && !state.planStated) {
                    state.planStated = true;
                    state.phase = PHASE.ACT;
                    continue;
                }
                if (state.phase === PHASE.VERIFY || state.phase === PHASE.ACT) {
                    state.phase = PHASE.CONCLUDE;
                    continue;
                }
                if (state.phase === PHASE.CONCLUDE) {
                    if (taskRequiresWorkspaceChange(effectiveTask) && !state.hasEdited) {
                        const note =
                            'Finish refused: this task asks for a workspace change, but no file or folder change has succeeded. ' +
                            'A file listing or checkpoint alone is not completion. Make the requested change before finishing.';
                        events.onReminder?.(note);
                        transcript.push({ role: 'user', content: note });
                        state.phase = PHASE.ACT;
                        continue;
                    }
                    run.status = 'done';
                    run.summary = text.trim() || 'Completed.';
                    return finalise();
                }
                transcript.push({
                    role: 'user',
                    content: 'Continue. Call a tool to make progress, or call `finish` if the task is done.',
                });
                continue;
            }

            for (const call of toolCalls) {
                if (signal.aborted) {
                    return finishAborted();
                }

                const signature = actionSignature(call.name, call.args);

                // Block an exact repeat of something that already failed.
                if (failures.includes(signature)) {
                    const note =
                        `BLOCKED: you already tried \`${signature}\` and it failed. Repeating it will fail ` +
                        `identically. Take a different approach — re-read the file, add more context, or use a different tool.`;
                    events.onReminder?.(note);
                    transcript.push({ role: 'tool', tool_call_id: call.id, content: note });
                    state.consecutiveFailures++;
                    continue;
                }

                if (call.name === 'finish') {
                    if (taskRequiresWorkspaceChange(effectiveTask) && !state.hasEdited) {
                        const note =
                            'Finish refused: this task asks for a workspace change, but no file or folder change has succeeded. ' +
                            'A file listing or checkpoint alone is not completion. Make the requested change before finishing.';
                        events.onReminder?.(note);
                        transcript.push({ role: 'tool', tool_call_id: call.id, content: note });
                        state.phase = PHASE.ACT;
                        continue;
                    }
                    const verdict = verificationPolicy({
                        hasEdited: state.hasEdited,
                        verificationAvailable: Boolean(runCommand),
                        commandCount: state.commandCount,
                    });
                    if (verdict.required && !state.verified) {
                        const refusal =
                            `You edited files but never verified them (${verdict.reason}). Run the project's ` +
                            `tests or build before finishing, or explain why you cannot.`;
                        events.onReminder?.(refusal);
                        transcript.push({ role: 'tool', tool_call_id: call.id, content: refusal });
                        state.phase = PHASE.VERIFY;
                        state.verificationFailed = true;
                        continue;
                    }
                    run.status = 'done';
                    run.summary = call.args?.summary ?? 'Completed.';
                    state.verified = Boolean(call.args?.verified);
                    state.phase = PHASE.CONCLUDE;
                    return finalise();
                }

                if (tools.isForbidden(call.name, call.args)) {
                    const note = `REFUSED: \`${call.name}\` is classified as destructive and cannot run.`;
                    events.onReminder?.(note);
                    transcript.push({ role: 'tool', tool_call_id: call.id, content: note });
                    continue;
                }

                const approvalKey = approvalKeyFor(call);
                const needsApproval =
                    tools.approvalNeeded(call.name, call.args, autonomy) && !alwaysAllow.has(approvalKey);

                if (needsApproval && events.requestApproval) {
                    const preview = await workspace.preview(call.name, call.args).catch(() => ({ diff: null }));
                    const decision = await events.requestApproval({
                        id: call.id,
                        name: call.name,
                        args: call.args,
                        diff: preview.diff,
                        path: call.args?.path ?? call.args?.command,
                    });
                    if (decision?.remember) {
                        alwaysAllow.add(approvalKey);
                    }
                    if (!decision?.approved) {
                        const note = `The user DENIED ${call.name}. Do not retry it. Propose an alternative or stop.`;
                        failures.push(signature);
                        memory.observe({
                            task: effectiveTask, signature, tool: call.name, args: call.args,
                            outcome: 'failure', detail: 'denied by user',
                        });
                        events.onToolResult?.({ id: call.id, name: call.name, ok: false, output: note });
                        transcript.push({ role: 'tool', tool_call_id: call.id, content: note });
                        continue;
                    }
                }

                events.onToolCall?.({ id: call.id, name: call.name, args: call.args });

                const outcome = await executeTool(call, {
                    tools, workspace, runCommand, signal, events, memory,
                });

                state.stepsTaken++;

                if (tools.get(call.name)?.risk === RISK.WRITE && outcome.ok) {
                    state.hasEdited = true;
                }
                if (call.name === 'run_command') {
                    state.commandCount++;
                    const classification = classifyCommandResult(call.args?.command ?? '', outcome.exitCode ?? 1);
                    if (classification.isVerification) {
                        state.verified = classification.passed;
                        state.verificationFailed = !classification.passed;
                        state.verificationReason = classification.passed ? null : 'verification command exited non-zero';
                    }
                }

                const record = {
                    step: state.stepsTaken,
                    name: call.name,
                    args: call.args,
                    ok: outcome.ok,
                    output: outcome.output,
                    diff: outcome.diff,
                    ts: Date.now(),
                };
                run.steps.push(record);

                if (outcome.ok) {
                    state.consecutiveFailures = 0;
                    memory.observe({
                        task: effectiveTask, signature, tool: call.name, args: call.args,
                        outcome: 'success', detail: outcome.output?.slice(0, 200),
                    });
                    if (call.args?.path && tools.get(call.name)?.risk === RISK.WRITE) {
                        run.filesTouched.add(call.args.path);
                    }
                } else {
                    state.consecutiveFailures++;
                    if (!failures.includes(signature)) {
                        failures.push(signature);
                    }
                    memory.observe({
                        task: effectiveTask, signature, tool: call.name, args: call.args,
                        outcome: 'failure', detail: outcome.output,
                    });
                }

                if (call.name === 'remember' && outcome.ok && call.args?.fact) {
                    memory.semantic.learn(call.args.fact, { scope: 'project' });
                    memory.flush();
                }

                events.onToolResult?.({
                    id: call.id, name: call.name, ok: outcome.ok, output: outcome.output, diff: outcome.diff,
                });
                transcript.push({ role: 'tool', tool_call_id: call.id, content: truncate(outcome.output, 6000) });
            }

            if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                run.status = 'failed';
                run.summary =
                    `Stopped after ${state.consecutiveFailures} consecutive failures. ` +
                    `The last problem was: ${truncate(run.steps[run.steps.length - 1]?.output ?? 'unknown', 300)}`;
                state.phase = PHASE.CONCLUDE;
                return finalise();
            }

            if (state.phase === PHASE.REPAIR) {
                state.phase = PHASE.VERIFY;
                continue;
            }

            state.phase = nextPhase(state);
        }

        run.status = 'failed';
        run.summary = `Reached the ${maxSteps}-step limit without finishing.`;
        return finalise();
    } catch (error: any) {
        if (error?.name === 'AbortError' || signal.aborted) {
            return finishAborted();
        }
        run.status = 'failed';
        run.summary = `Unexpected error: ${error.message}`;
        return finalise();
    }

    // ---------------------------------------------------------------------

    function finalise(): JavelinRunResult {
        const summary = summariseRun({
            status: run.status,
            summary: run.summary,
            steps: run.steps,
            checkpoints: run.checkpoints,
            filesTouched: [...run.filesTouched],
            verified: state.verified,
            verificationReason: state.verificationReason,
        });
        memory.flush();
        return {
            status: run.status,
            summary,
            rawSummary: run.summary,
            verified: state.verified,
            steps: run.steps,
            checkpoints: run.checkpoints,
            filesTouched: [...run.filesTouched],
            hypotheses,
            baseline: run.baseline,
        };
    }

    function finishAborted(): JavelinRunResult {
        run.status = 'aborted';
        run.summary = 'Stopped by user.';
        state.phase = PHASE.CONCLUDE;
        return finalise();
    }
}

/**
 * What an "always allow" decision actually covers for a given call.
 *
 * Commands are keyed by the exact command and file deletions by the exact path,
 * so consent given for one is never silently reused for another. Tool-level keys
 * (write_file / create_checkpoint) are deliberately broad because "always allow
 * editing" is a reasonable blanket choice; "always allow deleting anything" is not.
 */
function approvalKeyFor(call: any): string {
    if (call.name === 'run_command') {
        return `run_command:${String(call.args?.command ?? '').trim()}`;
    }
    if (call.name === 'delete_file') {
        return `delete_file:${String(call.args?.path ?? '')}`;
    }
    return call.name;
}

async function executeTool(
    call: any,
    ctx: {
        tools: ToolRegistry;
        workspace: VsCodeWorkspace;
        runCommand?: (cmd: string, signal?: AbortSignal) => Promise<any>;
        signal: AbortSignal;
        events: JavelinEvents;
        memory: JavelinMemory;
    },
): Promise<{ ok: boolean; output: string; diff?: any; exitCode?: number }> {
    call = canonicalizeToolCall(call);
    const tool = ctx.tools.get(call.name);
    if (!tool) {
        const available = ctx.tools.active().map((entry) => entry.name).join(', ');
        return {
            ok: false,
            output: `Unsupported tool "${call.name}". Available tools: ${available}. Use write_file with path and content to create a file, or create_folder with path to create a directory.`,
        };
    }
    try {
        return await tool.execute(call.args ?? {}, {
            workspace: ctx.workspace,
            runCommand: ctx.runCommand,
            emit: () => { },
            signal: ctx.signal,
        });
    } catch (error: any) {
        return { ok: false, output: `ERROR: ${error.message}` };
    }
}

function buildMemoryBlock(memory: JavelinMemory, task: string, state: any, failures: string[]): string | null {
    const bits: string[] = [];
    const base = memory.contextFor(task);
    if (base) {
        bits.push(base);
    }
    if (state.plan) {
        bits.push(`CURRENT PLAN:\n${state.plan}`);
    }
    if (failures.length) {
        bits.push(`DEAD ACTIONS THIS RUN:\n${failures.map((f) => `- ${f}`).join('\n')}`);
    }
    return bits.length ? bits.join('\n\n') : null;
}

function truncate(text: string, max: number): string {
    const s = String(text ?? '');
    return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

function normalizeResponseText(text: string): string {
    return String(text ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Build a memory snapshot reader/writer bound to VS Code globalState. */
export function memoryStore(state: { get<T>(key: string, def: T): T; update(key: string, value: any): Thenable<void> }) {
    return {
        load: () => state.get<MemorySnapshot | undefined>('javelin.memory', undefined),
        save: (snapshot: MemorySnapshot) => { void state.update('javelin.memory', snapshot); },
    };
}
