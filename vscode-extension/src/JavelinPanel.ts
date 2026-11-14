//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import * as vscode from 'vscode';
import { generateCodeStreaming, getErrorMessage, ensureLocalOllama, ChatMessage } from './aiService';
import { getNonce } from './getNonce';
import { runAgent, AgentCallbacks, ApprovalRequest, isSafeCommand, runShellCommand } from './agent';
import { VsCodeWorkspace } from './workspace';
import { getProvider, DEFAULT_PROVIDER, probeProviderModel } from './providers';
import { EngineRegistry, providerEngine, CAPABILITY } from './core/engines';
import { JavelinMemory, MemorySnapshot } from './core/memory';
import { runJavelin } from './core/runtime';
import { createStandardToolset, isSafeCommand as isCoreSafeCommand, AUTONOMY, Autonomy } from './core/tools';
import type { JavelinEvents } from './core/runtime';

interface ChatEntry {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
}

interface CheckpointInfo {
    id: string;
    label: string;
    timestamp: number;
    fileCount: number;
}

/**
 * A marker for one user message: where it sits in the conversation, and the
 * workspace checkpoint captured just before it was handled. "Revert to my last
 * message" needs both — the text to truncate and the files to restore.
 */
interface MessageMark {
    entryIndex: number;
    label: string;
    timestamp: number;
    /** Absent when no workspace was open, or no checkpoint could be taken. */
    checkpointId?: string;
}

/**
 * Check whether the Javelin model is actually being served.
 *
 * Selecting a model that is not installed is an easy
 * mistake, and the raw failure is an opaque 404 mid-generation. This turns it into
 * an actionable message.
 */
async function probeJavelinModel(
    baseUrl: string,
    model: string,
): Promise<{ ok: boolean; detail: string }> {
    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
            signal: AbortSignal.timeout(2500),
        });
        if (!res.ok) {
            return { ok: false, detail: `the server returned HTTP ${res.status}` };
        }
        const data: any = await res.json();
        const names: string[] = (data?.data ?? []).map((m: any) => String(m.id));
        if (!names.length) {
            return { ok: false, detail: 'no models are loaded on the server' };
        }
        const found = names.some((n) => n === model || n.startsWith(`${model}:`));
        return found
            ? { ok: true, detail: `serving ${model}` }
            : { ok: false, detail: `"${model}" is not loaded (available: ${names.join(', ')})` };
    } catch (error: any) {
        return {
            ok: false,
            detail: `could not reach ${baseUrl} (${error.message}). Is Ollama running?`,
        };
    }
}

export class JavelinPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'javelin.assistant';

    private _view?: vscode.WebviewView;
    private _conversationHistory: ChatEntry[] = [];
    private _disposables: vscode.Disposable[] = [];
    /**
     * One entry per user message: its index in the conversation and the workspace
     * checkpoint captured just before it was handled. Reverting to a message needs
     * both — the conversation to truncate and the files to restore.
     */
    private _messageMarks: MessageMark[] = [];
    private _pendingContext = '';
    private _activeRequest?: vscode.CancellationTokenSource;
    private _taskRunning = false;

    // Javelin Core: its own reasoning runtime, memory and engine registry.
    private _javelinAbort?: AbortController;
    private _javelinMemory?: JavelinMemory;

    // Agent state
    private _agentAbort?: AbortController;
    private _checkpoints: CheckpointInfo[] = [];
    private _workspace?: VsCodeWorkspace;
    /**
     * The automatic checkpoint taken before the most recent run. This is the target
     * of "Revert All" — it always exists, so there is always a way back even if the
     * agent corrupted files or never checkpointed itself.
     */
    private _runBaseline?: string;
    private _pendingApproval?: {
        request: ApprovalRequest;
        resolve: (decision: { approved: boolean; remember: boolean }) => void;
    };

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
    ) { }

    /** Build a workspace adapter rooted at the first open folder. */
    private getWorkspace(): VsCodeWorkspace | undefined {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return undefined;
        }
        if (!this._workspace) {
            this._workspace = new VsCodeWorkspace(folder.uri);
        }
        // Re-apply live-edit settings each run so a settings change takes effect
        // immediately, without rebuilding the adapter and losing checkpoints.
        const config = vscode.workspace.getConfiguration('javelin');
        this._workspace.setLiveEdit({
            enabled: config.get<boolean>('agentLiveEditInEditor', true),
            animate: config.get<boolean>('agentAnimateEdits', true),
            stepDelayMs: config.get<number>('agentEditSpeedMs', 24),
        });
        return this._workspace;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _resolveContext: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview();

        // Setup must not be able to leave the panel dead. If anything here throws and
        // the message listener is never registered, EVERY button silently stops
        // working — the webview posts messages that nobody receives. Fail visibly
        // instead, and always register the listener last.
        try {
            this.loadConversation();
        } catch (error) {
            vscode.window.showErrorMessage(
                `Javelin AI: could not load saved state — ${getErrorMessage(error)}`,
            );
            this._conversationHistory = [];
            this._checkpoints = [];
            this._messageMarks = [];
        }

        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                try {
                    await this.dispatchMessage(message);
                } catch (error) {
                    // One failing action must not wedge the whole panel.
                    vscode.window.showErrorMessage(`Javelin AI: ${getErrorMessage(error)}`);
                }
            },
            null,
            this._disposables,
        );
    }

    /** Route one message from the webview to its handler. */
    private async dispatchMessage(message: any): Promise<void> {
        switch (message.command) {
                    case 'ready':
                        this.postHistory();
                        this.postCheckpoints();
                        this.postConfig();
                        break;
                    case 'sendMessage':
                        await this.handleMessage(message.content, message.mode ?? 'chat');
                        break;
                    case 'agentModalRun':
                        // Persist the chosen autonomy before running so both the modal
                        // and the Settings UI agree, and the loop reads one source.
                        if (message.autonomy) {
                            await this.setAutonomy(message.autonomy);
                        }
                        await this.handleMessage(
                            message.content,
                            'agent',
                            Boolean(message.autoApproveSafe),
                            true,
                        );
                        break;
                    case 'setAutonomy':
                        await this.setAutonomy(message.autonomy);
                        break;
                    case 'cancel':
                        this.stopEverything();
                        break;
                    case 'clearConversation':
                        this.clearConversation();
                        break;
                    case 'insertCode':
                        await this.insertCode(message.code);
                        break;
                    case 'copyCode':
                        await vscode.env.clipboard.writeText(message.code);
                        break;
                    case 'openSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'javelin');
                        break;
                    case 'openQuickActions':
                        await vscode.commands.executeCommand('javelin.quickAction');
                        break;
                    case 'approvalDecision':
                        this.resolveApproval(Boolean(message.approved), Boolean(message.remember));
                        break;
                    case 'restoreCheckpoint':
                        await this.restoreCheckpoint(message.id);
                        break;
                    case 'revertAll':
                        await this.revertAll();
                        break;
                    case 'revertToLastMessage':
                        await this.revertToLastMessage();
                        break;
                    case 'acceptAll':
                        this.acceptAll();
                        break;
                }
    }

    /** Called by the extension when the user runs the "ask about selection" command. */
    public async askAboutSelection(selection: string, question?: string) {
        if (!this._view) {
            await vscode.commands.executeCommand('javelin.assistant.focus');
        }
        this._pendingContext = selection;
        if (question) {
            await this.handleMessage(question, 'chat');
        } else {
            this._view?.webview.postMessage({
                command: 'prefill',
                text: 'Explain this code and point out any bugs or improvements:\n',
            });
            this._view?.webview.postMessage({ command: 'showContext', context: selection });
        }
    }

    /** Public entry point for the "Run Javelin Task" command. */
    public async runJavelinTaskCommand(prompt?: string) {
        if (!this._view) {
            await vscode.commands.executeCommand('javelin.assistant.focus');
        }
        this._view?.webview.postMessage({ command: 'setMode', mode: 'javelin' });

        const task = prompt ?? (await vscode.window.showInputBox({
            title: 'Javelin AI: task',
            prompt: 'Javelin will understand, plan, act, verify and repair its own mistakes.',
            ignoreFocusOut: true,
            placeHolder: 'e.g. Find and fix the bug in the parser, then prove it is fixed',
        }));
        if (!task) {
            return;
        }
        await this.handleMessage(task, 'javelin');
    }

    /**
     * Open the dedicated coding-agent modal. If a task is supplied it is prefilled
     * so the user can review it before pressing Run.
     */
    public async openCodingAgent(task?: string) {
        if (!this._view) {
            await vscode.commands.executeCommand('javelin.assistant.focus');
        }
        this._view?.webview.postMessage({ command: 'openAgentModal', task: task ?? '' });
    }

    /** Public entry point for the "Run Agent Task" command. */
    public async runAgentTask(prompt?: string) {
        if (!this._view) {
            await vscode.commands.executeCommand('javelin.assistant.focus');
        }
        this._view?.webview.postMessage({ command: 'setMode', mode: 'agent', openModal: true });

        const task = prompt ?? (await vscode.window.showInputBox({
            title: 'Javelin AI: agent task',
            prompt: 'Describe what the agent should do. It will inspect the workspace, plan, edit and verify.',
            ignoreFocusOut: true,
            placeHolder: 'e.g. Add validation to the signup form and make the tests pass',
        }));
        if (!task) {
            return;
        }
        await this.handleMessage(task, 'agent');
    }

    /** Javelin's memory, persisted in globalState so learnings survive restarts. */
    private getMemory(): JavelinMemory {
        if (!this._javelinMemory) {
            const saved = this._context.globalState.get<MemorySnapshot | undefined>('javelin.memory');
            this._javelinMemory = JavelinMemory.restore(saved);
        }
        return this._javelinMemory;
    }

    /** Run a task on Javelin Core — its own reasoning lifecycle. */
    private async runJavelinTask(task: string) {
        if (!this._view) {
            return;
        }
        const abort = this._javelinAbort ?? new AbortController();
        this._javelinAbort = abort;
        if (abort.signal.aborted) {
            return;
        }

        const workspace = this.getWorkspace();
        if (!workspace) {
            this._view.webview.postMessage({
                command: 'error',
                error: 'Open a folder first — Javelin needs a workspace to inspect and edit.',
            });
            return;
        }

        const config = vscode.workspace.getConfiguration('javelin');
        const providerId = config.get<string>('provider', DEFAULT_PROVIDER);
        const provider = getProvider(providerId);
        if (provider.id !== 'javelin' && provider.id !== 'local') {
            this._view.webview.postMessage({
                command: 'error',
                error: 'Only self-hosted Javelin and local Ollama providers are enabled.',
            });
            return;
        }

        // Rebuild engines each run so a settings change takes effect immediately.
        const engines = new EngineRegistry();
        const baseUrl = config.get<string>('baseUrl', '') || provider.baseUrl;
        const model = config.get<string>('model', provider.defaultModel) || provider.defaultModel;

        await ensureLocalOllama(baseUrl);
        if (abort.signal.aborted) {
            return;
        }
        const check = await probeProviderModel({ providerId: provider.id, baseUrl, model });
        if (abort.signal.aborted) {
            return;
        }
        if (!check.ok) {
            this._view.webview.postMessage({ command: 'error', error: check.detail });
            return;
        }

        // A selected-but-unserved Javelin model would otherwise fail with a bare
        // fetch error. Say what is actually wrong and how to fix it.
        if (provider.isJavelinModel) {
            const check = await probeJavelinModel(baseUrl, model);
            if (abort.signal.aborted) {
                return;
            }
            if (!check.ok) {
                this._view.webview.postMessage({
                    command: 'error',
                    error:
                        `Javelin model is not available: ${check.detail}. ` +
                        `Install it with \`ollama pull ${model}\`, or choose an installed local model ` +
                        `with "Javelin AI: Select Model Provider".`,
                });
                return;
            }
        }
        engines.register(
            providerEngine(
                { id: provider.id, label: provider.label, baseUrl, defaultModel: provider.defaultModel },
                {
                    id: 'javelin-primary',
                    label: `${provider.label} engine`,
                    model,
                    capabilities: [CAPABILITY.TOOLS, CAPABILITY.OFFLINE],
                },
            ),
        );
        engines.assign('primary', 'javelin-primary');

        const memory = this.getMemory();

        const tools = createStandardToolset();
        const autoApproveSafe = config.get<boolean>('agentAutoApproveSafeCommands', true);
        const autonomy = config.get<Autonomy>('autonomy', AUTONOMY.ASK);

        const events: JavelinEvents = {
            onPhase: (phase, label) => this._view?.webview.postMessage({ command: 'javelinPhase', phase, label }),
            onPlan: (plan, steps) => this._view?.webview.postMessage({ command: 'javelinPlan', plan, steps }),
            onHypothesis: (hypothesis) => this._view?.webview.postMessage({ command: 'javelinHypothesis', hypothesis }),
            onThinkingDelta: () => {},
            onThinking: (_text, repeated) => this._view?.webview.postMessage({
                command: 'agentStatus',
                text: repeated ? 'The model repeated itself; recovering…' : 'Preparing the next action…',
            }),
            onToolCall: (call) => this._view?.webview.postMessage({ command: 'toolCall', call }),
            onToolResult: (result) =>
                this._view?.webview.postMessage({
                    command: 'toolResult',
                    id: result.id,
                    name: result.name,
                    ok: result.ok,
                    output: result.output,
                    diff: result.diff ?? null,
                }),
            onCheckpoint: (cp) => {
                this._checkpoints.push(cp);
                void this._context.globalState.update('checkpoints', this._checkpoints);
                this._view?.webview.postMessage({ command: 'checkpoint', checkpoint: cp });
            },
            onReminder: (note) => {
                const entry: ChatEntry = { role: 'system', content: note, timestamp: Date.now() };
                this._conversationHistory.push(entry);
                this._view?.webview.postMessage({ command: 'messageAdded', message: entry });
            },
            onCommand: (command, output, exitCode) =>
                this._view?.webview.postMessage({
                    command: 'commandResult', shellCommand: command, output, exitCode,
                }),
            requestApproval: (req) => {
                const autoApprove =
                    req.name === 'run_command' &&
                    isCoreSafeCommand(req.args?.command ?? '') &&
                    autoApproveSafe;
                if (autoApprove) {
                    return Promise.resolve({ approved: true, remember: false });
                }
                this._view?.webview.postMessage({ command: 'approvalRequest', request: req });
                return new Promise((resolve) => {
                    this._pendingApproval = { request: req, resolve };
                });
            },
        };

        try {
            const result = await runJavelin({
                task,
                priorMessages: this._conversationHistory.slice(0, -1).map(({ role, content }) => ({ role, content })),
                workspace,
                engines,
                signal: abort.signal,
                memory,
                events,
                tools,
                runCommand: async (command, signal) => {
                    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri;
                    if (!cwd) {
                        return { exitCode: 1, stdout: '', stderr: 'No workspace folder open.' };
                    }
                    const res = await runShellCommand(command, cwd, signal ?? abort.signal);
                    return { exitCode: res.exitCode, stdout: res.output, stderr: '' };
                },
                maxSteps: config.get<number>('agentMaxSteps', 30),
                autonomy,
            });

            // Remember the automatic pre-run checkpoint so "Revert All" has a target.
            this._runBaseline = result.baseline ?? undefined;

            // Persist what Javelin learned.
            await this._context.globalState.update('javelin.memory', memory.snapshot());

            this._view.webview.postMessage({
                command: 'agentEnd',
                status: result.status,
                summary: result.summary,
                code: (result as any).code ?? null,
                stepCount: result.steps.length,
                verified: result.verified,
                hypotheses: result.hypotheses,
                filesTouched: result.filesTouched ?? [],
                baseline: result.baseline ?? null,
            });
        } catch (error) {
            this._view.webview.postMessage({ command: 'error', error: getErrorMessage(error) });
        } finally {
            this._javelinAbort = undefined;
            this._pendingApproval = undefined;
            await this.saveConversation();
        }
    }

    /** Public wrapper for the restore-checkpoint command. */
    public async restoreCheckpointById(id: string) {
        if (!this._view) {
            await vscode.commands.executeCommand('javelin.assistant.focus');
        }
        await this.restoreCheckpoint(id);
    }

    /** Public wrapper: undo everything the last run changed. */
    public async revertAllChanges() {
        await this.revertAll();
    }

    /** Public wrapper: keep the last run's changes. */
    public acceptAllChanges() {
        this.acceptAll();
    }

    /** Public method to get conversation history for export. */
    public getConversationHistory(): ChatEntry[] {
        return [...this._conversationHistory];
    }

    /** Public wrapper: undo the last message you sent, and its file changes. */
    public async revertToLastMessageCommand() {
        if (!this._view) {
            await vscode.commands.executeCommand('javelin.assistant.focus');
        }
        await this.revertToLastMessage();
    }

    /** Stop whatever is running: Javelin, the agent, or a chat stream. */
    public stopEverything() {
        this._javelinAbort?.abort();
        this._agentAbort?.abort();
        this._activeRequest?.cancel();
        // Unblock any pending approval so the loop can unwind cleanly.
        this.resolveApproval(false, false);
    }

    /**
     * Undo the last message you sent: truncate the conversation back to it and put
     * the files back as they were before it ran.
     *
     * This is the "that was the wrong request" button. It restores both sides of the
     * state — what was said and what was changed — because undoing one without the
     * other leaves the conversation describing files that no longer match.
     *
     * The message itself is kept, so you can edit your wording and resend rather than
     * retyping the whole request.
     */
    private async revertToLastMessage() {
        const mark = this._messageMarks[this._messageMarks.length - 1];
        if (!mark) {
            vscode.window.showInformationMessage('Javelin AI: no message to revert to yet.');
            return;
        }

        const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && !d.isUntitled);
        if (dirty.length) {
            const go = await vscode.window.showWarningMessage(
                `Reverting will discard unsaved changes in ${dirty.length} open file(s). Continue?`,
                { modal: true },
                'Revert message',
            );
            if (go !== 'Revert message') {
                return;
            }
        }

        let revertedFiles: string[] = [];
        if (mark.checkpointId) {
            const workspace = this.getWorkspace();
            if (workspace) {
                try {
                    revertedFiles = await workspace.restore(mark.checkpointId);
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Javelin AI: restored the conversation but could not revert files — ${getErrorMessage(error)}`,
                    );
                }
            }
        }

        // Truncate everything after the target message, keeping the message itself.
        this._conversationHistory = this._conversationHistory.slice(0, mark.entryIndex + 1);
        this._messageMarks = this._messageMarks.filter((m) => m.entryIndex <= mark.entryIndex);
        this._runBaseline = undefined;
        await this.saveConversation();
        await this._context.globalState.update('messageMarks', this._messageMarks);

        this._view?.webview.postMessage({
            command: 'conversationReverted',
            messages: this._conversationHistory,
            files: revertedFiles,
        });

        const filesNote = revertedFiles.length
            ? ` and reverted ${revertedFiles.length} file(s)`
            : '';
        vscode.window.showInformationMessage(
            `Javelin AI: reverted to your last message${filesNote}. Edit it and send again.`,
        );
    }

    private loadConversation() {
        this._conversationHistory = this._context.globalState.get<ChatEntry[]>('conversationHistory', []);
        this._checkpoints = this._context.globalState.get<CheckpointInfo[]>('checkpoints', []);
        // Defensive: a persisted value from an older or corrupt state must not be able
        // to break the panel. If it is not an array, fall back to empty — an empty
        // list of undo marks is harmless; a non-array would throw on the next push.
        const marks = this._context.globalState.get<MessageMark[]>('messageMarks', []);
        this._messageMarks = Array.isArray(marks) ? marks : [];
    }

    private async saveConversation() {
        await this._context.globalState.update('conversationHistory', this._conversationHistory);
    }

    private postHistory() {
        this._view?.webview.postMessage({
            command: 'history',
            messages: this._conversationHistory,
        });
    }

    private postCheckpoints() {
        this._view?.webview.postMessage({ command: 'checkpoints', checkpoints: this._checkpoints });
    }

    private postConfig() {
        const config = vscode.workspace.getConfiguration('javelin');
        const id = config.get<string>('provider', DEFAULT_PROVIDER);
        const provider = getProvider(id);
        this._view?.webview.postMessage({
            command: 'config',
            providerId: provider.id,
            model: config.get<string>('model', provider.defaultModel),
            autonomy: config.get<Autonomy>('autonomy', AUTONOMY.ASK),
        });
    }

    /** Persist the autonomy level chosen in the agent modal. */
    private async setAutonomy(autonomy: string) {
        if (autonomy !== AUTONOMY.ASK && autonomy !== AUTONOMY.AUTO_EDIT && autonomy !== AUTONOMY.FULL) {
            return;
        }
        const config = vscode.workspace.getConfiguration('javelin');
        if (config.get<string>('autonomy', AUTONOMY.ASK) !== autonomy) {
            await config.update('autonomy', autonomy, vscode.ConfigurationTarget.Global);
        }
    }

    private clearConversation() {
        if (this._taskRunning) {
            return;
        }
        this._conversationHistory = [];
        // The marks point into the conversation, so they are meaningless once it is
        // cleared — leaving them would let "revert to last message" target a message
        // that no longer exists.
        this._messageMarks = [];
        void this._context.globalState.update('messageMarks', []);
        void this.saveConversation();
        this._view?.webview.postMessage({ command: 'conversationCleared' });
    }

    private async insertCode(code: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            await vscode.env.clipboard.writeText(code);
            vscode.window.showInformationMessage('No active editor — code copied to clipboard instead.');
            return;
        }
        await editor.edit((builder) => {
            builder.insert(editor.selection.active, code);
        });
        editor.revealRange(new vscode.Range(editor.selection.active, editor.selection.active));
    }

    private resolveApproval(approved: boolean, remember: boolean) {
        if (this._pendingApproval) {
            this._pendingApproval.resolve({ approved, remember });
            this._pendingApproval = undefined;
        }
    }

    private async restoreCheckpoint(id: string) {
        const workspace = this.getWorkspace();
        if (!workspace) {
            return;
        }
        try {
            const changed = await workspace.restore(id);
            this._view?.webview.postMessage({ command: 'checkpointRestored', id, files: changed });
            vscode.window.showInformationMessage(`Javelin AI: reverted ${changed.length} file(s).`);
        } catch (error) {
            vscode.window.showErrorMessage(`Javelin AI: ${getErrorMessage(error)}`);
        }
    }

    /**
     * Undo everything the last run did, back to the automatic pre-run checkpoint.
     *
     * This is the "I do not trust this result" button: it does not need the agent to
     * have cooperated, and works even if the run failed halfway through or corrupted
     * files. When the user has unsaved edits in an open file they are asked first, so
     * reverting cannot silently discard work done outside the agent.
     */
    private async revertAll() {
        const workspace = this.getWorkspace();
        const baseline = this._runBaseline;
        if (!workspace || !baseline) {
            vscode.window.showWarningMessage('Javelin AI: nothing to revert to yet — run the agent first.');
            return;
        }

        const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && !d.isUntitled);
        if (dirty.length) {
            const choice = await vscode.window.showWarningMessage(
                `Reverting will discard unsaved changes in ${dirty.length} open file(s). Continue?`,
                { modal: true },
                'Revert and discard',
            );
            if (choice !== 'Revert and discard') {
                return;
            }
        }

        try {
            const changed = await workspace.restore(baseline);
            this._view?.webview.postMessage({ command: 'checkpointRestored', id: baseline, files: changed });
            if (!changed.length) {
                vscode.window.showInformationMessage('Javelin AI: nothing had changed — workspace already matches.');
                return;
            }
            const pick = await vscode.window.showInformationMessage(
                `Javelin AI: reverted ${changed.length} file(s) to before this run.`,
                'Show files',
            );
            if (pick === 'Show files') {
                const uri = vscode.Uri.joinPath(
                    vscode.workspace.workspaceFolders![0].uri,
                    changed[0],
                );
                await vscode.window.showTextDocument(uri);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Javelin AI: could not revert — ${getErrorMessage(error)}`);
        }
    }

    /**
     * Keep the last run's changes: drop the baseline so it cannot be reverted by
     * accident, and say so plainly rather than showing a button that silently does
     * nothing afterwards.
     */
    private acceptAll() {
        if (!this._runBaseline) {
            vscode.window.showInformationMessage('Javelin AI: nothing to accept yet.');
            return;
        }
        this._runBaseline = undefined;
        this._view?.webview.postMessage({ command: 'changesAccepted' });
        vscode.window.showInformationMessage(
            'Javelin AI: changes kept. Use a checkpoint or your own version control to undo later.',
        );
    }

    private async handleMessage(
        content: string,
        mode: 'chat' | 'agent' | 'javelin',
        autoApproveSafe?: boolean,
        fromModal = false,
    ) {
        if (!this._view || !content.trim()) {
            return;
        }

        if (this._taskRunning) {
            this._view.webview.postMessage({
                command: 'error',
                error: 'A task is already running. Stop it before starting another.',
            });
            return;
        }
        this._taskRunning = true;
        if (mode === 'agent' || mode === 'javelin') {
            if (mode === 'javelin') {
                this._javelinAbort = new AbortController();
            } else {
                this._agentAbort = new AbortController();
            }
            this._view.webview.postMessage({ command: 'agentStart', mode });
        }

        try {
            const userEntry: ChatEntry = { role: 'user', content, timestamp: Date.now() };
            this._conversationHistory.push(userEntry);

            const mark = {
                entryIndex: this._conversationHistory.length - 1,
                label: content.length > 60 ? `${content.slice(0, 60)}…` : content,
                timestamp: Date.now(),
                checkpointId: undefined as string | undefined,
            };
            try {
                const workspace = this.getWorkspace();
                if (workspace) {
                    const cp = await workspace.snapshot(`Before: ${mark.label}`);
                    mark.checkpointId = cp.id;
                    this._checkpoints.push(cp);
                    void this._context.globalState.update('checkpoints', this._checkpoints);
                }
            } catch {
                // Still allow reverting the chat text when a workspace cannot be snapshotted.
            }
            this._messageMarks.push(mark);
            void this._context.globalState.update('messageMarks', this._messageMarks);

            if (!fromModal) {
                this._view.webview.postMessage({ command: 'messageAdded', message: userEntry });
            }

            if (mode === 'javelin') {
                await this.runJavelinTask(content);
            } else if (mode === 'agent') {
                await this.runAgentTaskLoop(content, autoApproveSafe);
            } else {
                await this.runChat(content);
            }
        } finally {
            if (mode === 'agent' || mode === 'javelin') {
                this._view?.webview.postMessage({ command: 'agentDone' });
            }
            this._javelinAbort = undefined;
            this._agentAbort = undefined;
            this._taskRunning = false;
        }
    }

    /** Existing streaming chat path. */
    private async runChat(content: string) {
        if (!this._view) {
            return;
        }
        this._view.webview.postMessage({ command: 'loadingStart' });

        const history: ChatMessage[] = this._conversationHistory
            .slice(0, -1)
            .map((m) => ({ role: m.role === 'system' ? 'user' : m.role, content: m.content }));

        const extraContext = this._pendingContext || undefined;
        this._pendingContext = '';

        const cancellation = new vscode.CancellationTokenSource();
        this._activeRequest = cancellation;

        try {
            const response = await generateCodeStreaming(
                this._context,
                content,
                history,
                (delta) => this._view?.webview.postMessage({ command: 'streamChunk', delta }),
                cancellation.token,
                extraContext,
            );

            const assistantEntry: ChatEntry = { role: 'assistant', content: response, timestamp: Date.now() };
            this._conversationHistory.push(assistantEntry);
            await this.saveConversation();

            this._view.webview.postMessage({ command: 'streamEnd', content: response });
        } catch (error) {
            this._view.webview.postMessage({ command: 'error', error: getErrorMessage(error) });
        } finally {
            cancellation.dispose();
            this._activeRequest = undefined;
            this._view?.webview.postMessage({ command: 'loadingEnd' });
        }
    }

    /** The autonomous agent loop, wired to the webview. */
    private async runAgentTaskLoop(task: string, autoApproveSafeOverride?: boolean) {
        if (!this._view) {
            return;
        }
        const abort = this._agentAbort ?? new AbortController();
        this._agentAbort = abort;
        if (abort.signal.aborted) {
            return;
        }

        const workspace = this.getWorkspace();
        if (!workspace) {
            this._view.webview.postMessage({
                command: 'error',
                error: 'Open a folder first — the agent needs a workspace to inspect and edit.',
            });
            return;
        }

        const config = vscode.workspace.getConfiguration('javelin');
        const providerId = config.get<string>('provider', DEFAULT_PROVIDER);
        const provider = getProvider(providerId);
        if (provider.id !== 'javelin' && provider.id !== 'local') {
            this._view.webview.postMessage({
                command: 'error',
                error: 'Only self-hosted Javelin and local Ollama providers are enabled.',
            });
            return;
        }
        const baseUrl = config.get<string>('baseUrl', '') || provider.baseUrl;
        const model = config.get<string>('model', provider.defaultModel) || provider.defaultModel;
        const autonomy = config.get<Autonomy>('autonomy', AUTONOMY.ASK);

        await ensureLocalOllama(baseUrl);
        if (abort.signal.aborted) {
            return;
        }
        const check = await probeProviderModel({ providerId: provider.id, baseUrl, model });
        if (abort.signal.aborted) {
            return;
        }
        if (!check.ok) {
            this._view.webview.postMessage({ command: 'error', error: check.detail });
            return;
        }

        const callbacks: AgentCallbacks = {
            onPhase: (phase) => this._view?.webview.postMessage({ command: 'agentPhase', phase }),
            onStatus: (text) => this._view?.webview.postMessage({ command: 'agentStatus', text }),
            onAssistantText: (_text, repeated) => this._view?.webview.postMessage({
                command: 'agentStatus',
                text: repeated ? 'The model repeated itself; requesting a new action…' : 'Preparing the next action…',
            }),
            onAssistantDelta: () => {},
            onToolCall: (call) => this._view?.webview.postMessage({ command: 'toolCall', call }),
            onToolResult: (result) =>
                this._view?.webview.postMessage({
                    command: 'toolResult',
                    id: result.id,
                    name: result.name,
                    ok: result.ok,
                    output: result.output,
                    diff: result.diff ?? null,
                }),
            onCheckpoint: (cp) => {
                this._checkpoints.push(cp);
                void this._context.globalState.update('checkpoints', this._checkpoints);
                this._view?.webview.postMessage({ command: 'checkpoint', checkpoint: cp });
            },
            onCommand: (command, output, exitCode) =>
                this._view?.webview.postMessage({
                    command: 'commandResult',
                    shellCommand: command,
                    output,
                    exitCode,
                }),
            onReminder: (text) => {
                const entry: ChatEntry = { role: 'system', content: text, timestamp: Date.now() };
                this._conversationHistory.push(entry);
                this._view?.webview.postMessage({ command: 'messageAdded', message: entry });
            },
            requestApproval: (req) => {
                // Allow-listed verification commands can skip the prompt when the
                // user has opted in. File edits always ask.
                const autoApprove =
                    req.name === 'run_command' &&
                    isSafeCommand(req.args?.command ?? '') &&
                    (autoApproveSafeOverride ??
                        config.get<boolean>('agentAutoApproveSafeCommands', true));
                if (autoApprove) {
                    return Promise.resolve({ approved: true, remember: false });
                }
                this._view?.webview.postMessage({ command: 'approvalRequest', request: req });
                return new Promise((resolve) => {
                    this._pendingApproval = { request: req, resolve };
                });
            },
        };

        try {
            const result = await runAgent({
                task,
                workspace,
                provider: { providerId, baseUrl, model },
                signal: abort.signal,
                callbacks,
                autonomy,
                priorMessages: this._conversationHistory
                    .slice(-13, -1)
                    .map((m) => ({ role: m.role === 'system' ? 'user' : m.role, content: m.content })),
            });

            this._view.webview.postMessage({
                command: 'agentEnd',
                status: result.status,
                summary: result.summary,
                code: (result as any).code ?? null,
                stepCount: result.steps.length,
            });
        } catch (error) {
            this._view.webview.postMessage({ command: 'error', error: getErrorMessage(error) });
        } finally {
            this._agentAbort = undefined;
            this._pendingApproval = undefined;
            await this.saveConversation();
        }
    }

    public dispose() {
        this._activeRequest?.dispose();
        this._javelinAbort?.abort();
        this._agentAbort?.abort();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }

    private _getHtmlForWebview() {
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Javelin AI</title>
    <style nonce="${nonce}">
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background: var(--vscode-sideBar-background);
            color: var(--vscode-sideBar-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header h1 { font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
        .header-actions { display: flex; gap: 4px; }
        .icon-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--vscode-icon-foreground);
            padding: 3px 7px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
        }
        .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
        .modes { display: flex; gap: 4px; padding: 6px 10px 0; }
        .mode-btn {
            background: transparent;
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
            padding: 3px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
        }
        .mode-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }
        .chat {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .empty { color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center; padding: 24px 8px; line-height: 1.6; }
        .row { display: flex; flex-direction: column; gap: 4px; }
        .row.user { align-items: flex-end; }
        .row.system { align-items: center; }
        .bubble {
            padding: 8px 11px;
            border-radius: 6px;
            line-height: 1.55;
            word-wrap: break-word;
            overflow-wrap: anywhere;
            max-width: 100%;
        }
        .row.user .bubble {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            white-space: pre-wrap;
        }
        .row.assistant .bubble {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
        }
        .row.system .bubble {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 11px;
            text-align: center;
            max-width: 92%;
        }
        .bubble p { margin: 0 0 8px; }
        .bubble p:last-child { margin-bottom: 0; }
        .bubble ul, .bubble ol { margin: 4px 0 8px 18px; }
        .bubble h1, .bubble h2, .bubble h3 { margin: 10px 0 6px; font-size: 1em; }
        .bubble a { color: var(--vscode-textLink-foreground); }
        .bubble code.inline {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.92em;
        }
        .code-wrap {
            margin: 8px 0;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            overflow: hidden;
            background: var(--vscode-textCodeBlock-background);
        }
        .code-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 3px 8px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .code-head button {
            background: transparent;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            font-size: 10px;
            padding: 2px 4px;
        }
        .code-head button:hover { text-decoration: underline; }
        pre {
            margin: 0;
            padding: 8px;
            overflow-x: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.45;
        }
        .phase {
            display: flex; align-items: center; gap: 7px;
            padding: 6px 9px; font-size: 11px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            color: var(--vscode-descriptionForeground);
        }
        .phase .dot {
            width: 7px; height: 7px; border-radius: 50%;
            background: var(--vscode-charts-blue, #3794ff);
            animation: pulse 1.1s ease-in-out infinite;
        }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .steps { border: 1px solid var(--vscode-panel-border); border-radius: 5px; overflow: hidden; }
        .steps-head {
            padding: 4px 8px; font-size: 11px; cursor: pointer;
            background: var(--vscode-editor-background);
            display: flex; justify-content: space-between;
        }
        .steps-body { padding: 6px 8px; display: none; flex-direction: column; gap: 6px; }
        .steps.open .steps-body { display: flex; }
        .step { font-size: 11px; display: flex; gap: 6px; align-items: flex-start; }
        .step .badge { flex-shrink: 0; }
        .step .name { font-family: var(--vscode-editor-font-family); }
        .step .arg { color: var(--vscode-descriptionForeground); word-break: break-all; }
        .step .err {
            margin-top: 3px; padding: 4px 6px; border-radius: 3px;
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
            white-space: pre-wrap; font-size: 10px; max-height: 120px; overflow: auto;
        }
        .ok { color: var(--vscode-charts-green, #89d185); }
        .fail { color: var(--vscode-charts-red, #f14c4c); }
        .diff { border: 1px solid var(--vscode-panel-border); border-radius: 5px; margin-top: 4px; overflow: hidden; }
        .diff-head {
            padding: 3px 8px; font-size: 10px; cursor: pointer;
            background: var(--vscode-textCodeBlock-background);
            display: flex; justify-content: space-between; align-items: center;
        }
        .diff-body { display: none; max-height: 240px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
        .diff.open .diff-body { display: block; }
        .dl { display: flex; white-space: pre; padding: 0 6px; line-height: 1.4; }
        .dl.add { background: rgba(137, 209, 133, 0.14); }
        .dl.del { background: rgba(241, 76, 76, 0.14); }
        .dl .ln { width: 30px; flex-shrink: 0; text-align: right; color: var(--vscode-descriptionForeground); opacity: 0.6; }
        .dl .mk { width: 12px; flex-shrink: 0; text-align: center; }
        .dl .tx { flex: 1; padding-right: 6px; }
        .plan-card {
            border: 1px solid var(--vscode-panel-border);
            border-left: 3px solid var(--vscode-charts-blue, #3794ff);
            border-radius: 4px; padding: 6px 9px; font-size: 11px;
        }
        .plan-title { font-weight: 600; margin-bottom: 3px; }
        .plan-body { white-space: pre-wrap; color: var(--vscode-descriptionForeground); }
        .hypothesis {
            border: 1px solid var(--vscode-charts-yellow, #cca700);
            border-radius: 4px; padding: 5px 9px; font-size: 11px;
            background: rgba(204, 167, 0, 0.10);
        }
        .checkpoints { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; }
        .cp {
            background: transparent; border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-textLink-foreground); border-radius: 4px;
            padding: 2px 7px; cursor: pointer; font-size: 10px;
        }
        .cp:hover { background: var(--vscode-toolbar-hoverBackground); }
        /*
         * Shared state classes. The webview CSP allows only nonce'd styles, so a direct
         * style assignment on an element is silently dropped by the browser. Anything
         * the script switches at runtime must be a class here.
         */
        .hidden { display: none !important; }
        .dim { opacity: 0.8; }
        .phase-visible { display: flex !important; }
        .verified-badge { color: var(--vscode-charts-green, #89d185); }
        .notice-bar {
            border: none; border-radius: 4px; padding: 5px 9px; font-size: 11px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        /*
         * Classes replacing former inline style attributes. A CSP nonce authorises
         * nonce'd elements only — it does not cover inline style attributes, which are
         * always refused under style-src. So these must be real rules.
         */
        .agent-head-right { display: flex; align-items: center; gap: 8px; }
        .field-label {
            font-size: 11px; color: var(--vscode-descriptionForeground);
            display: flex; align-items: center; gap: 5px;
        }
        .modal-actions { display: flex; gap: 6px; }
        .command-preview {
            border: 1px solid var(--vscode-panel-border); border-radius: 4px;
            padding: 8px; overflow-x: auto;
        }
        .approval-note { white-space: pre-wrap; font-size: 11px; }
        .task-card {
            border: 1px solid var(--vscode-panel-border); border-radius: 5px;
            padding: 8px 10px; margin-top: 4px; font-size: 12px;
        }
        .task-title {
            font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
            opacity: 0.7; margin-bottom: 5px;
        }
        .task-row { display: flex; gap: 6px; align-items: flex-start; padding: 2px 0; opacity: 0.65; }
        .task-row.active { opacity: 1; font-weight: 600; }
        .task-row.done { opacity: 0.5; text-decoration: line-through; }
        .task-box { flex: 0 0 auto; width: 12px; color: var(--vscode-textLink-foreground); }
        .task-row.done .task-box { color: var(--vscode-charts-green, #89d185); }
        .task-label { flex: 1 1 auto; }
        .run-controls {
            display: flex; flex-wrap: wrap; align-items: center; gap: 7px;
            border: 1px solid var(--vscode-panel-border); border-radius: 5px;
            padding: 7px 9px; font-size: 11px; margin-top: 4px;
        }
        .run-controls button {
            border-radius: 4px; padding: 3px 9px; cursor: pointer; font-size: 11px;
            border: 1px solid var(--vscode-panel-border); background: transparent;
            color: var(--vscode-foreground);
        }
        .run-controls button.keep {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground); border-color: transparent;
        }
        .run-controls button.undo { color: var(--vscode-charts-red, #f48771); }
        .run-controls button:hover { opacity: 0.88; }
        .modal-backdrop {
            display: none; position: fixed; inset: 0; z-index: 50;
            background: rgba(0,0,0,0.5); align-items: center; justify-content: center; padding: 12px;
        }
        .modal-backdrop.on { display: flex; }
        .modal {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px; width: 100%; max-width: 520px;
            max-height: 82vh; display: flex; flex-direction: column;
            box-shadow: 0 8px 28px rgba(0,0,0,0.4);
        }
        .modal-head { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; font-weight: 600; }
        .modal-sub { padding: 4px 12px 0; font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); word-break: break-all; }
        .modal-body { flex: 1; overflow: auto; padding: 10px 12px; }
        .modal-foot { padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .modal-foot label { font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 5px; }
        .btn { border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer; font-size: 11px; }
        /* ---- Coding agent modal ---- */
        .agent-backdrop {
            display: none; position: fixed; inset: 0; z-index: 60;
            background: rgba(0,0,0,0.55); align-items: center; justify-content: center; padding: 10px;
        }
        .agent-backdrop.on { display: flex; }
        .agent-modal {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px; width: 100%; max-width: 720px; height: 100%; max-height: 92vh;
            display: flex; flex-direction: column;
            box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        }
        .agent-head {
            padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border);
            display: flex; justify-content: space-between; align-items: center; gap: 8px;
        }
        .agent-head h2 { font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 7px; }
        .agent-status { font-size: 11px; color: var(--vscode-descriptionForeground); }
        .agent-body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
        .agent-controls { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 6px; }
        .agent-controls textarea { min-height: 56px; }
        .agent-row { display: flex; gap: 6px; align-items: center; }
        .agent-row .grow { flex: 1; }
        .agent-stream {
            flex: 1; overflow-y: auto; padding: 10px 12px;
            display: flex; flex-direction: column; gap: 8px; min-height: 0;
        }
        .agent-step {
            display: flex; gap: 8px; align-items: flex-start;
            border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 7px 9px; font-size: 11px;
        }
        .agent-step .badge { flex-shrink: 0; font-size: 12px; line-height: 1.3; }
        .agent-step .body { flex: 1; min-width: 0; }
        .agent-step .name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
        .agent-step .arg { color: var(--vscode-descriptionForeground); word-break: break-all; }
        .agent-step .detail { margin-top: 4px; }
        .agent-out {
            margin-top: 4px; padding: 5px 7px; border-radius: 3px; font-size: 10px;
            background: var(--vscode-textCodeBlock-background); white-space: pre-wrap;
            max-height: 160px; overflow: auto; font-family: var(--vscode-editor-font-family);
        }
        .agent-out.err {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
        }
        .agent-msg {
            padding: 7px 10px; border-radius: 5px; font-size: 11px; line-height: 1.5;
            background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border);
            word-wrap: break-word; overflow-wrap: anywhere;
        }
        .agent-msg.user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); white-space: pre-wrap; }
        .agent-foot {
            padding: 9px 12px; border-top: 1px solid var(--vscode-panel-border);
            display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, inherit); border: 1px solid var(--vscode-panel-border); }
        .btn-danger { background: var(--vscode-inputValidation-errorBackground, #a1260d); color: var(--vscode-inputValidation-errorForeground, #fff); }
        .btn-danger:hover { opacity: 0.9; }
        .input-area { padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
        .context-chip {
            display: none;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            margin-bottom: 6px;
            padding: 4px 8px;
            border-radius: 4px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 11px;
        }
        .context-chip.on { display: flex; }
        .context-chip button { background: transparent; border: none; color: inherit; cursor: pointer; }
        .input-row { display: flex; gap: 6px; align-items: flex-end; }
        textarea {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 6px 8px;
            font-family: inherit;
            font-size: 12px;
            resize: vertical;
            outline: none;
            min-height: 46px;
            max-height: 200px;
        }
        textarea:focus { border-color: var(--vscode-focusBorder); }
        textarea:disabled { opacity: 0.6; }
        .send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 7px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
        }
        .send-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
        .send-btn.stop {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
        }
        .error {
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            color: var(--vscode-inputValidation-errorForeground);
            padding: 8px;
            border-radius: 4px;
            margin: 0 0 8px;
            font-size: 11px;
            line-height: 1.5;
        }
        .loading { display: flex; align-items: center; gap: 7px; padding: 4px 2px; font-size: 11px; color: var(--vscode-descriptionForeground); }
        .spinner {
            width: 11px; height: 11px;
            border: 2px solid var(--vscode-descriptionForeground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.9s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .cursor { display: inline-block; width: 7px; height: 13px; background: currentColor; opacity: 0.6; vertical-align: text-bottom; animation: blink 1s steps(2) infinite; }
        @keyframes blink { 50% { opacity: 0; } }
    </style>
</head>
<body>
    <div class="header">
        <h1>🚀 Javelin AI</h1>
        <div class="header-actions">
            <button class="icon-btn" id="agentModalBtn" title="Open the coding agent">🤖 Agent</button>
            <button class="icon-btn" id="quickActionsBtn" title="Open code actions">Actions</button>
            <button class="icon-btn" id="settingsBtn" title="Open settings">Settings</button>
            <button class="icon-btn" id="clearBtn" title="Clear conversation">Clear</button>
        </div>
    </div>

    <div class="modes">
        <button class="mode-btn active" id="modeChat">Chat</button>
        <button class="mode-btn" id="modeAgent">Agent</button>
        <button class="mode-btn" id="modeJavelin">Javelin</button>
    </div>

    <div class="chat" id="chat"></div>

    <div class="input-area">
        <div class="context-chip" id="contextChip">
            <span id="contextLabel">Selection attached</span>
            <button id="clearContext" title="Remove attached selection">✕</button>
        </div>
        <div class="input-row">
            <textarea id="input" rows="2" placeholder="Ask anything… (Enter to send, Shift+Enter for a newline)"></textarea>
            <button class="send-btn" id="sendBtn">Send</button>
        </div>
    </div>

    <div class="agent-backdrop" id="agentModalBackdrop">
        <div class="agent-modal">
            <div class="agent-head">
                <h2>🤖 Javelin Coding Agent</h2>
                <div class="agent-head-right">
                    <span class="agent-status" id="agentModalStatus">Idle</span>
                    <button class="icon-btn" id="agentModalClose" title="Close">✕</button>
                </div>
            </div>
            <div class="agent-body">
                <div class="agent-controls">
                    <textarea id="agentTaskInput" rows="2" placeholder="Describe the coding task — the agent will inspect, plan, edit and verify…"></textarea>
                    <div class="agent-row">
                        <label class="grow field-label">
                            Autonomy:
                            <select id="agentModalAutonomy" title="How much Javelin may do without stopping to ask">
                                <option value="ask">Ask every time</option>
                                <option value="auto-edit">Auto-edit (do it all)</option>
                                <option value="full">Full auto</option>
                            </select>
                        </label>
                        <label class="field-label">
                            <input type="checkbox" id="agentModalAutoApprove" checked> Auto-approve safe commands
                        </label>
                        <button class="btn btn-secondary" id="agentModalClear">Clear</button>
                        <button class="btn btn-primary" id="agentModalRun">Run task</button>
                    </div>
                </div>
                <div class="agent-stream" id="agentStream">
                    <div class="empty">No task running. Describe what you want the agent to do, then press <b>Run task</b>.<br>Choose <b>Autonomy</b> above to let Javelin do the whole task without stopping.</div>
                </div>
            </div>
            <div class="agent-foot">
                <span id="agentModalSummary">Idle</span>
                <button class="btn btn-secondary hidden" id="agentModalStop">Stop</button>
            </div>
        </div>
    </div>

    <div class="modal-backdrop" id="approvalBackdrop">
        <div class="modal">
            <div class="modal-head" id="approvalTitle">Approve action?</div>
            <div class="modal-sub" id="approvalSub"></div>
            <div class="modal-body" id="approvalBody"></div>
            <div class="modal-foot">
                <label><input type="checkbox" id="approvalRemember"> Always allow this for the run</label>
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="approvalDeny">Deny</button>
                    <button class="btn btn-primary" id="approvalApprove">Approve</button>
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const chat = document.getElementById('chat');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('sendBtn');
        const clearBtn = document.getElementById('clearBtn');
        const quickActionsBtn = document.getElementById('quickActionsBtn');
        const settingsBtn = document.getElementById('settingsBtn');
        const modeChat = document.getElementById('modeChat');
        const modeAgent = document.getElementById('modeAgent');
        const modeJavelin = document.getElementById('modeJavelin');
        const contextChip = document.getElementById('contextChip');
        const contextLabel = document.getElementById('contextLabel');
        const clearContextBtn = document.getElementById('clearContext');
        const approvalBackdrop = document.getElementById('approvalBackdrop');
        const approvalTitle = document.getElementById('approvalTitle');
        const approvalSub = document.getElementById('approvalSub');
        const approvalBody = document.getElementById('approvalBody');
        const approvalRemember = document.getElementById('approvalRemember');
        const approvalApprove = document.getElementById('approvalApprove');
        const approvalDeny = document.getElementById('approvalDeny');

        // Coding agent modal
        const agentModalBtn = document.getElementById('agentModalBtn');
        const agentModalBackdrop = document.getElementById('agentModalBackdrop');
        const agentModalClose = document.getElementById('agentModalClose');
        const agentModalRun = document.getElementById('agentModalRun');
        const agentModalStop = document.getElementById('agentModalStop');
        const agentModalClear = document.getElementById('agentModalClear');
        const agentModalStatus = document.getElementById('agentModalStatus');
        const agentModalSummary = document.getElementById('agentModalSummary');
        const agentModalAutoApprove = document.getElementById('agentModalAutoApprove');
        const agentModalAutonomy = document.getElementById('agentModalAutonomy');
        const agentTaskInput = document.getElementById('agentTaskInput');
        const agentStream = document.getElementById('agentStream');
        let agentModalBusy = false;
        const agentSteps = {};

        let streaming = false;
        let mode = 'chat';
        let loadingEl = null;
        let streamEl = null;
        let streamText = '';
        let phaseEl = null;
        let stepsEl = null;
        let stepsBody = null;
        let pendingApprovalId = null;

        const PHASE_LABEL = {
            // Agent-mode phases
            inspect: 'Inspecting the workspace',
            act: 'Editing files',
            recover: 'Recovering from a failure',
            done: 'Done',
            // Javelin Core cognitive phases
            understand: 'Understanding the task and project',
            plan: 'Planning',
            verify: 'Verifying',
            repair: 'Diagnosing a failure',
            conclude: 'Wrapping up'
        };

        let planEl = null;
        // The parsed plan steps, kept so the checklist can be ticked off in order.
        let taskSteps = [];
        function renderPlanPanel() {
            // The phase strip already shows progress; the plan card is separate.
        }

        function renderPlan(plan) {
            if (planEl) { planEl.remove(); }
            planEl = document.createElement('div');
            planEl.className = 'plan-card';
            planEl.innerHTML = '<div class="plan-title">Javelin&#39;s plan</div><div class="plan-body"></div>';
            planEl.querySelector('.plan-body').textContent = plan;
            chat.appendChild(planEl);
            chat.scrollTop = chat.scrollHeight;
        }

        function renderHypothesis(hypothesis) {
            const el = document.createElement('div');
            el.className = 'hypothesis';
            el.textContent = 'Diagnosis: ' + hypothesis;
            chat.appendChild(el);
            chat.scrollTop = chat.scrollHeight;
        }

        /**
         * The plan as a checklist of tasks.
         *
         * This is the "what will it do" view: each step is a row that starts pending
         * and is ticked off as the run works through it, so progress is visible rather
         * than inferred. Steps are matched to progress by position, since a plan step
         * and a tool call do not share identifiers.
         */
        function renderTaskList(steps) {
            const existing = document.getElementById('taskList');
            if (existing) { existing.remove(); }
            if (!steps || !steps.length) { return; }

            taskSteps = steps.map(function (text) { return { text: text, done: false }; });

            const card = document.createElement('div');
            card.className = 'task-card';
            card.id = 'taskList';
            const title = document.createElement('div');
            title.className = 'task-title';
            title.textContent = 'Tasks';
            card.appendChild(title);

            taskSteps.forEach(function (step, i) {
                const row = document.createElement('div');
                row.className = 'task-row';
                row.dataset.taskIndex = String(i);
                const box = document.createElement('span');
                box.className = 'task-box';
                box.textContent = '\u25cb';
                const label = document.createElement('span');
                label.className = 'task-label';
                label.textContent = (i + 1) + '. ' + step.text;
                row.appendChild(box);
                row.appendChild(label);
                card.appendChild(row);
            });

            chat.appendChild(card);
            chat.scrollTop = chat.scrollHeight;
        }

        /**
         * Tick off plan steps as real work happens.
         *
         * A previously-failed tool call must not advance the checklist — otherwise a
         * retry reads as progress when nothing actually succeeded.
         */
        function advanceTaskList(name) {
            if (!taskSteps.length || name === 'finish') { return; }
            const next = taskSteps.findIndex(function (s) { return !s.done; });
            if (next === -1) { return; }
            taskSteps[next].done = true;
            setTaskRowState(next, 'done');
            // The step after the one just finished becomes the active one.
            if (taskSteps[next + 1] && !taskSteps[next + 1].done) {
                setTaskRowState(next + 1, 'active');
            }
        }

        function setTaskRowState(index, state) {
            const card = document.getElementById('taskList');
            if (!card) { return; }
            const row = card.querySelector('[data-task-index="' + index + '"]');
            if (!row) { return; }
            row.classList.remove('active', 'done');
            row.classList.add(state);
            row.querySelector('.task-box').textContent = state === 'done' ? '\u2713' : (state === 'active' ? '\u25b8' : '\u25cb');
        }

        /** Mark every remaining task done — the run finished, so nothing is pending. */
        function completeTaskList() {
            taskSteps.forEach(function (s, i) {
                if (!s.done) {
                    s.done = true;
                    setTaskRowState(i, 'done');
                }
            });
        }

        function emptyText() {
            if (mode === 'javelin') {
                return 'Javelin runs its own reasoning loop against your real workspace:<br><b>understand → plan → act → verify → repair</b>.<br>It remembers what failed and will not repeat a dead action.';
            }
            return mode === 'agent'
                ? 'Describe a task and Javelin will inspect the workspace, plan, edit files and verify.<br>Every file change asks for approval first.'
                : 'Ask Javelin to write, explain, refactor or debug code.<br>Select code in the editor and run <b>Javelin AI: Ask About Selection</b> to attach it.';
        }

        function escapeHtml(text) {
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function renderMarkdown(source) {
            const parts = String(source).split(/\`\`\`/);
            let html = '';
            for (let i = 0; i < parts.length; i++) {
                if (i % 2 === 1) {
                    const nl = parts[i].indexOf('\\n');
                    const lang = nl === -1 ? '' : parts[i].slice(0, nl).trim();
                    const code = nl === -1 ? parts[i] : parts[i].slice(nl + 1);
                    const clean = code.replace(/\\n$/, '');
                    const id = 'c' + (window.__codeSeq = (window.__codeSeq || 0) + 1);
                    window.__codeBlocks = window.__codeBlocks || {};
                    window.__codeBlocks[id] = clean;
                    html += '<div class="code-wrap">'
                          + '<div class="code-head"><span>' + escapeHtml(lang || 'code') + '</span>'
                          + '<span><button data-insert="' + id + '">Insert</button>'
                          + '<button data-copy="' + id + '">Copy</button></span></div>'
                          + '<pre><code>' + escapeHtml(clean) + '</code></pre></div>';
                } else {
                    html += renderInline(parts[i]);
                }
            }
            return html;
        }

        function renderInline(text) {
            let out = escapeHtml(text);
            out = out.replace(/\`([^\`\\n]+)\`/g, '<code class="inline">$1</code>');
            out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
            // Markdown link -> anchor.
            //
            // This sits inside a template literal, so backslashes are doubled for the
            // emitted HTML and the regex is easy to get subtly wrong. Two forms were
            // tried here and both produced an UNBALANCED regex, which is a syntax
            // error, which meant the whole webview script never parsed and NO button
            // in the panel ever got its click handler:
            //   - a literal ')' inside a character class
            //   - an escaped ']' inside a character class (it closes the class early)
            // So the label class avoids both: it matches any run of characters that is
            // neither '[' nor ']' by using a negated set over a single alternative.
            out = out.replace(/\\[(.+?)\\]\\((.+?)\\)/g, function (m, label, href) {
                if (label.indexOf('[') !== -1 || label.indexOf(']') !== -1) {
                    return m;
                }
                return /^(https?:|mailto:)/.test(href)
                    ? '<a href="' + href + '">' + label + '</a>'
                    : m;
            });
            return out
                .split(/\\n{2,}/)
                .map(function (block) {
                    const isList = /^\\s*[-*]\\s/.test(block);
                    if (isList) {
                        const items = block.split('\\n').map(function (l) {
                            return '<li>' + l.replace(/^\\s*[-*]\\s/, '') + '</li>';
                        }).join('');
                        return '<ul>' + items + '</ul>';
                    }
                    return '<p>' + block.replace(/\\n/g, '<br>') + '</p>';
                })
                .join('');
        }

        function addMessage(role, content) {
            const row = document.createElement('div');
            row.className = 'row ' + role;
            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            if (role === 'user' || role === 'system') {
                bubble.textContent = content;
            } else {
                bubble.innerHTML = renderMarkdown(content);
            }
            row.appendChild(bubble);
            chat.appendChild(row);
            chat.scrollTop = chat.scrollHeight;
            return bubble;
        }

        function showLoading() {
            if (loadingEl) { return; }
            loadingEl = document.createElement('div');
            loadingEl.className = 'loading';
            loadingEl.innerHTML = '<div class="spinner"></div><span>Thinking…</span>';
            chat.appendChild(loadingEl);
            chat.scrollTop = chat.scrollHeight;
        }

        function hideLoading() {
            if (loadingEl) { loadingEl.remove(); loadingEl = null; }
        }

        function resetChat() {
            chat.innerHTML = '<div class="empty">' + emptyText() + '</div>';
            loadingEl = null;
            streamEl = null;
            phaseEl = null;
            stepsEl = null;
            stepsBody = null;
        }

        function setBusy(busy) {
            streaming = busy;
            sendBtn.textContent = busy ? 'Stop' : (mode === 'agent' ? 'Run' : 'Send');
            sendBtn.className = 'send-btn' + (busy ? ' stop' : '');
            sendBtn.disabled = false;
            clearBtn.disabled = busy;
            modeChat.disabled = busy;
            modeAgent.disabled = busy;
            modeJavelin.disabled = busy;
            input.disabled = false;
            if (!busy) { input.focus(); }
        }

        function setMode(next) {
            mode = next;
            modeChat.classList.toggle('active', mode === 'chat');
            modeAgent.classList.toggle('active', mode === 'agent');
            modeJavelin.classList.toggle('active', mode === 'javelin');
            input.placeholder = mode === 'javelin'
                ? 'Describe the task — Javelin will plan, act, verify and repair…'
                : mode === 'agent'
                    ? 'Describe the task — the agent will inspect, plan, edit and verify…'
                    : 'Ask anything… (Enter to send, Shift+Enter for a newline)';
            sendBtn.textContent = streaming ? 'Stop' : (mode === 'javelin' ? 'Think' : mode === 'agent' ? 'Run' : 'Send');
            if (chat.querySelector('.empty')) {
                resetChat();
            }
        }

        function send() {
            const content = input.value.trim();
            if (!content || streaming) { return; }
            input.value = '';
            vscode.postMessage({ command: 'sendMessage', content: content, mode: mode });
        }

        sendBtn.addEventListener('click', function () {
            if (streaming) {
                vscode.postMessage({ command: 'cancel' });
            } else {
                send();
            }
        });

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });

        modeChat.addEventListener('click', function () { setMode('chat'); });
        modeAgent.addEventListener('click', function () { setMode('agent'); });
        modeJavelin.addEventListener('click', function () { setMode('javelin'); });

        clearBtn.addEventListener('click', function () {
            vscode.postMessage({ command: 'clearConversation' });
        });

        quickActionsBtn.addEventListener('click', function () {
            vscode.postMessage({ command: 'openQuickActions' });
        });

        settingsBtn.addEventListener('click', function () {
            vscode.postMessage({ command: 'openSettings' });
        });

        clearContextBtn.addEventListener('click', function () {
            contextChip.classList.remove('on');
        });

        function ensurePhase() {
            if (phaseEl) { return phaseEl; }
            phaseEl = document.createElement('div');
            phaseEl.className = 'phase';
            phaseEl.innerHTML = '<span class="dot"></span><span id="phaseText">Working…</span>';
            chat.appendChild(phaseEl);
            chat.scrollTop = chat.scrollHeight;
            return phaseEl;
        }

        function setPhase(phase, status) {
            const el = ensurePhase();
            const label = PHASE_LABEL[phase] || 'Working';
            el.querySelector('#phaseText').textContent = status ? (label + ' — ' + status) : label;
            // Class rather than an inline style: the webview CSP allows only nonce'd
            // styles, and a direct style assignment is blocked outright.
            el.classList.add('phase-visible');
            chat.scrollTop = chat.scrollHeight;
        }

        function clearPhase() {
            if (phaseEl) { phaseEl.remove(); phaseEl = null; }
        }

        function flushStream() {
            if (streamEl) {
                var cursor = streamEl.querySelector('.cursor');
                if (cursor) { cursor.remove(); }
                streamEl = null;
                streamText = '';
            }
        }

        function ensureSteps() {
            if (stepsEl) { return stepsEl; }
            stepsEl = document.createElement('div');
            stepsEl.className = 'steps open';
            const head = document.createElement('div');
            head.className = 'steps-head';
            head.innerHTML = '<span>Agent activity</span><span id="stepCount">0 steps</span>';
            head.addEventListener('click', function () { stepsEl.classList.toggle('open'); });
            stepsBody = document.createElement('div');
            stepsBody.className = 'steps-body';
            stepsEl.appendChild(head);
            stepsEl.appendChild(stepsBody);
            chat.appendChild(stepsEl);
            return stepsEl;
        }

        function updateStepCount() {
            const n = stepsBody ? stepsBody.children.length : 0;
            const el = stepsEl && stepsEl.querySelector('#stepCount');
            if (el) { el.textContent = n + (n === 1 ? ' step' : ' steps'); }
        }

        function addStep(call) {
            ensureSteps();
            const row = document.createElement('div');
            row.className = 'step';
            row.setAttribute('data-step-id', call.id);
            const arg = call.args && (call.args.path || call.args.command || call.args.query || call.args.label) || '';
            row.innerHTML = '<span class="badge">⋯</span>'
                + '<span><span class="name">' + escapeHtml(call.name) + '</span> '
                + '<span class="arg">' + escapeHtml(arg) + '</span></span>';
            stepsBody.appendChild(row);
            updateStepCount();
            chat.scrollTop = chat.scrollHeight;
        }

        function renderDiff(diff) {
            if (!diff) { return ''; }
            let html = '<div class="diff">'
                + '<div class="diff-head"><span>+' + diff.added + ' / -' + diff.removed + '</span><span>hide</span></div>'
                + '<div class="diff-body">';
            const lines = diff.lines.slice(0, 400);
            for (const line of lines) {
                const cls = line.type === 'add' ? 'add' : (line.type === 'remove' ? 'del' : '');
                const mk = line.type === 'add' ? '+' : (line.type === 'remove' ? '-' : ' ');
                html += '<div class="dl ' + cls + '">'
                    + '<span class="ln">' + (line.aLine || '') + '</span>'
                    + '<span class="mk">' + mk + '</span>'
                    + '<span class="tx">' + escapeHtml(line.text) + '</span></div>';
            }
            if (diff.lines.length > 400) {
                html += '<div class="dl"><span class="tx">… ' + (diff.lines.length - 400) + ' more lines</span></div>';
            }
            return html + '</div></div>';
        }

        function wireDiffToggle(node) {
            const head = node.querySelector('.diff-head');
            if (!head) { return; }
            head.addEventListener('click', function () {
                node.classList.toggle('open');
                const lbl = head.querySelector('span:last-child');
                if (lbl) { lbl.textContent = node.classList.contains('open') ? 'hide' : 'show'; }
            });
        }

        function completeStep(id, ok, output, diff) {
            if (!stepsEl || !stepsBody) { return; }
            const row = stepsBody.querySelector('[data-step-id="' + id + '"]');
            if (!row) { return; }
            const badge = row.querySelector('.badge');
            badge.textContent = ok ? '✓' : '✕';
            badge.className = 'badge ' + (ok ? 'ok' : 'fail');
            const holder = row.querySelector('span:nth-child(2)');
            if (!ok && output) {
                const err = document.createElement('div');
                err.className = 'err';
                err.textContent = output;
                holder.appendChild(err);
            }
            if (diff) {
                const wrap = document.createElement('div');
                wrap.innerHTML = renderDiff(diff);
                const node = wrap.firstElementChild;
                wireDiffToggle(node);
                node.classList.add('open');
                holder.appendChild(node);
            }
            chat.scrollTop = chat.scrollHeight;
        }

        function showCheckpoints(list) {
            const existing = document.getElementById('checkpointBar');
            if (existing) { existing.remove(); }
            if (!list || !list.length) { return; }
            const bar = document.createElement('div');
            bar.className = 'checkpoints';
            bar.id = 'checkpointBar';
            bar.innerHTML = '<span>Checkpoints:</span>';
            for (const cp of list) {
                const b = document.createElement('button');
                b.className = 'cp';
                b.textContent = cp.label;
                b.title = 'Restore workspace to this point';
                b.addEventListener('click', function () {
                    vscode.postMessage({ command: 'restoreCheckpoint', id: cp.id });
                });
                bar.appendChild(b);
            }
            chat.insertBefore(bar, chat.firstChild);
        }

        /**
         * The keep-or-undo decision shown after a run that changed files.
         *
         * "Revert" is always offered because the runtime takes its own checkpoint
         * before the run — it does not depend on the agent having been sensible.
         */
        function showRunControls(fileCount, status) {
            removeRunControls();
            const bar = document.createElement('div');
            bar.className = 'run-controls';
            bar.id = 'runControls';

            const label = document.createElement('span');
            label.textContent = 'This run changed ' + fileCount + ' file(s).';
            bar.appendChild(label);

            const keep = document.createElement('button');
            keep.className = 'keep';
            keep.textContent = '✓ Accept all';
            keep.title = 'Keep these changes';
            keep.addEventListener('click', function () {
                vscode.postMessage({ command: 'acceptAll' });
            });
            bar.appendChild(keep);

            const undo = document.createElement('button');
            undo.className = 'undo';
            undo.textContent = '\u21a9 Revert all';
            undo.title = 'Undo every change this run made, back to how the workspace was before it started';
            undo.addEventListener('click', function () {
                vscode.postMessage({ command: 'revertAll' });
            });
            bar.appendChild(undo);

            // Undo the request as well as its effects — removes your message and
            // everything after it, and puts the files back as they were before it.
            const undoMessage = document.createElement('button');
            undoMessage.className = 'undo';
            undoMessage.textContent = '\u21a9 Revert my last message';
            undoMessage.title = 'Discard your last message and everything after it, and restore the files to before it ran';
            undoMessage.addEventListener('click', function () {
                vscode.postMessage({ command: 'revertToLastMessage' });
            });
            bar.appendChild(undoMessage);

            // A failed run is exactly when you want the undo, so say it plainly.
            if (status && status !== 'done') {
                const warn = document.createElement('span');
                warn.className = 'dim';
                warn.textContent = status === 'aborted'
                    ? ' (run was stopped part-way — reverting is recommended)'
                    : ' (run failed — reverting is recommended)';
                bar.appendChild(warn);
            }

            chat.appendChild(bar);
        }

        function removeRunControls() {
            const existing = document.getElementById('runControls');
            if (existing) { existing.remove(); }
        }

        function showApproval(request) {
            pendingApprovalId = request.id;
            approvalRemember.checked = false;
            const isDelete = request.name === 'delete_file';
            approvalTitle.textContent = request.name === 'run_command'
                ? 'Run this command?'
                : (isDelete ? 'Delete this file?' : 'Apply this change?');
            approvalSub.textContent = request.name === 'run_command' ? request.args.command : (request.path || '');
            // A deletion is destructive and permanent (outside a checkpoint), so the
            // button says what it does rather than the generic "Approve".
            approvalApprove.textContent = isDelete ? 'Delete file' : 'Approve';
            approvalApprove.classList.toggle('btn-danger', isDelete);
            if (request.name === 'run_command') {
                approvalBody.innerHTML = '<pre class="command-preview">$ '
                    + escapeHtml(request.args.command) + '</pre>';
            } else if (request.diff) {
                approvalBody.innerHTML = renderDiff(request.diff);
                const node = approvalBody.querySelector('.diff');
                if (node) { node.classList.add('open'); }
            } else {
                approvalBody.innerHTML = '<pre class="approval-note">'
                    + escapeHtml(String(request.args.content || request.args.new_string || '')) + '</pre>';
            }
            approvalBackdrop.classList.add('on');
        }

        function decideApproval(approved) {
            if (!pendingApprovalId) { return; }
            vscode.postMessage({
                command: 'approvalDecision',
                id: pendingApprovalId,
                approved: approved,
                remember: approvalRemember.checked
            });
            pendingApprovalId = null;
            approvalBackdrop.classList.remove('on');
        }

        approvalApprove.addEventListener('click', function () { decideApproval(true); });
        approvalDeny.addEventListener('click', function () { decideApproval(false); });

        chat.addEventListener('click', function (e) {
            const insert = e.target.getAttribute && e.target.getAttribute('data-insert');
            const copy = e.target.getAttribute && e.target.getAttribute('data-copy');
            if (insert) {
                vscode.postMessage({ command: 'insertCode', code: window.__codeBlocks[insert] || '' });
                e.target.textContent = 'Inserted';
                setTimeout(function () { e.target.textContent = 'Insert'; }, 1200);
            } else if (copy) {
                vscode.postMessage({ command: 'copyCode', code: window.__codeBlocks[copy] || '' });
                e.target.textContent = 'Copied';
                setTimeout(function () { e.target.textContent = 'Copy'; }, 1200);
            }
        });

        window.addEventListener('message', function (event) {
            const message = event.data;
            switch (message.command) {
                case 'history':
                    resetChat();
                    if (message.messages && message.messages.length) {
                        chat.innerHTML = '';
                        message.messages.forEach(function (m) { addMessage(m.role, m.content); });
                    }
                    break;
                case 'messageAdded':
                    hideLoading();
                    flushStream();
                    addMessage(message.message.role, message.message.content);
                    if (message.message.role === 'user') { setBusy(true); }
                    break;
                case 'loadingStart':
                    showLoading();
                    break;
                case 'streamChunk':
                    hideLoading();
                    if (!streamEl) {
                        streamText = '';
                        streamEl = addMessage('assistant', '');
                    }
                    streamText += message.delta;
                    streamEl.innerHTML = renderMarkdown(streamText) + '<span class="cursor"></span>';
                    chat.scrollTop = chat.scrollHeight;
                    break;
                case 'streamEnd':
                    if (streamEl) {
                        streamEl.innerHTML = renderMarkdown(message.content);
                    } else {
                        addMessage('assistant', message.content);
                    }
                    flushStream();
                    break;
                case 'error':
                    hideLoading();
                    clearPhase();
                    var err = document.createElement('div');
                    err.className = 'error';
                    err.textContent = message.error;
                    chat.appendChild(err);
                    chat.scrollTop = chat.scrollHeight;
                    if (agentModalBusy) {
                        agentLog(escapeHtml(message.error), 'agent-msg');
                        setAgentBusy(false);
                        agentModalSummary.textContent = 'Failed';
                    }
                    break;
                case 'loadingEnd':
                    hideLoading();
                    setBusy(false);
                    break;
                case 'conversationCleared':
                    resetChat();
                    break;
                case 'prefill':
                    input.value = message.text || '';
                    input.focus();
                    break;
                case 'showContext':
                    contextLabel.textContent = 'Selection attached (' + (message.context || '').length + ' chars)';
                    contextChip.classList.add('on');
                    break;

                case 'setMode':
                    setMode(message.mode);
                    if (message.mode === 'agent' && message.openModal) { openAgentModal(); }
                    break;
                case 'openAgentModal':
                    openAgentModal();
                    if (message.task) { agentTaskInput.value = message.task; }
                    break;
                case 'agentStart':
                    setBusy(true);
                    // A new run supersedes the previous plan's checklist.
                    taskSteps = [];
                    if (mode === 'javelin') {
                        setPhase('understand', 'starting');
                    } else {
                        setPhase('inspect', 'starting');
                    }
                    break;
                case 'javelinPhase':
                    setPhase(message.phase, null);
                    renderPlanPanel(message.phase, message.label);
                    break;
                case 'javelinPlan':
                    renderPlan(message.plan);
                    renderTaskList(message.steps || []);
                    break;
                case 'javelinHypothesis':
                    renderHypothesis(message.hypothesis);
                    break;
                case 'agentPhase':
                    setPhase(message.phase, null);
                    break;
                case 'agentStatus':
                    setPhase(null, message.text);
                    break;
                case 'agentDelta':
                    hideLoading();
                    if (!streamEl) { streamText = ''; streamEl = addMessage('assistant', ''); }
                    streamText += message.delta;
                    streamEl.innerHTML = renderMarkdown(streamText) + '<span class="cursor"></span>';
                    chat.scrollTop = chat.scrollHeight;
                    break;
                case 'agentText':
                    hideLoading();
                    if (message.repeated) {
                        if (streamEl) {
                            streamEl.parentElement.remove();
                            streamEl = null;
                            streamText = '';
                        }
                        break;
                    }
                    if (streamEl) {
                        streamEl.innerHTML = renderMarkdown(message.text);
                        streamEl = null;
                        streamText = '';
                    } else {
                        addMessage('assistant', message.text);
                    }
                    if (agentModalBusy) { agentLog(renderMarkdown(message.text)); }
                    break;
                case 'toolCall':
                    flushStream();
                    hideLoading();
                    addStep(message.call);
                    if (agentModalBusy) { agentAddStep(message.call); }
                    break;
                case 'toolResult':
                    completeStep(message.id, message.ok, message.output, message.diff);
                    // Only successful work advances the checklist — a retry is not progress.
                    if (message.ok) { advanceTaskList(message.name); }
                    if (agentModalBusy) { agentCompleteStep(message.id, message.ok, message.output, message.diff); }
                    break;
                case 'checkpoints':
                    showCheckpoints(message.checkpoints);
                    break;
                case 'checkpointRestored':
                    var note = document.createElement('div');
                    note.className = 'notice-bar';
                    note.textContent = 'Reverted ' + (message.files || []).length + ' file(s).';
                    chat.insertBefore(note, chat.firstChild);
                    break;
                case 'approvalRequest':
                    showApproval(message.request);
                    break;
                case 'agentEnd':
                    clearPhase();
                    completeTaskList();
                    if (agentModalBusy) {
                        agentModalSummary.textContent = message.summary + ' — ' + message.stepCount + ' step(s)'
                            + (message.code ? ' · ' + message.code : '');
                    }
                    var summary = document.createElement('div');
                    summary.className = 'phase phase-visible';
                    var verifiedBadge = message.verified
                        ? ' <b class="verified-badge">✓ verified</b>'
                        : '';
                    var diagNote = (message.hypotheses && message.hypotheses.length)
                        ? ' · ' + message.hypotheses.length + ' diagnosis(es)'
                        : '';
                    var codeBadge = message.code
                        ? ' <code title="Error code (see docs/ERROR-CODES.md)">' + escapeHtml(message.code) + '</code>'
                        : '';
                    summary.innerHTML = '<span>' + (message.status === 'done' ? '✅' : (message.status === 'aborted' ? '⏹️' : '❌'))
                        + '</span><span>' + escapeHtml(message.summary) + ' — ' + message.stepCount
                        + ' step(s)' + diagNote + '</span>' + verifiedBadge + codeBadge;
                    chat.appendChild(summary);
                    // Offer the decision whenever the run changed something. Revert is
                    // always available because the baseline is taken automatically.
                    var touched = message.filesTouched || [];
                    if (message.baseline && touched.length) {
                        showRunControls(touched.length, message.status);
                    }
                    chat.scrollTop = chat.scrollHeight;
                    break;
                case 'changesAccepted':
                    removeRunControls();
                    break;
                case 'conversationReverted':
                    removeRunControls();
                    // Rebuild the transcript from the truncated history the host sent,
                    // so the chat matches what was actually kept.
                    resetChat();
                    chat.innerHTML = '';
                    (message.messages || []).forEach(function (m) { addMessage(m.role, m.content); });
                    taskSteps = [];
                    var revertNote = document.createElement('div');
                    revertNote.className = 'phase';
                    revertNote.textContent = '\u21a9 Reverted to your last message'
                        + ((message.files || []).length ? ' \u2014 ' + message.files.length + ' file(s) restored.' : '.')
                        + ' Edit it and send again.';
                    chat.appendChild(revertNote);
                    chat.scrollTop = chat.scrollHeight;
                    break;
                case 'agentDone':
                    clearPhase();
                    setBusy(false);
                    setAgentBusy(false);
                    break;
                case 'config':
                    // Reflect the saved autonomy level in the modal's dropdown.
                    if (message.autonomy) {
                        agentModalAutonomy.value = message.autonomy;
                    }
                    break;
            }
        });

        /* ---------- Coding agent modal ---------- */

        function agentEmptyState() {
            const ask = !agentModalAutonomy || agentModalAutonomy.value === 'ask';
            const note = ask
                ? 'Every file change asks for approval before it is applied.'
                : 'Javelin will work the whole task end to end and change files without stopping. Catastrophic commands stay blocked.';
            return 'No task running. Describe what you want the agent to do, then press <b>Run task</b>.<br>' + note;
        }

        function openAgentModal() {
            agentModalBackdrop.classList.add('on');
            agentTaskInput.focus();
        }

        function closeAgentModal() {
            agentModalBackdrop.classList.remove('on');
        }

        function setAgentBusy(busy) {
            agentModalBusy = busy;
            agentModalRun.disabled = busy;
            agentTaskInput.disabled = busy;
            agentModalRun.textContent = busy ? 'Running…' : 'Run task';
            // Toggle a class — the webview CSP refuses inline style assignments.
            agentModalStop.classList.toggle('hidden', !busy);
            agentModalStatus.textContent = busy ? 'Working…' : 'Idle';
        }

        function agentLog(html, cls) {
            const empty = agentStream.querySelector('.empty');
            if (empty) { empty.remove(); }
            const el = document.createElement('div');
            el.className = cls || 'agent-msg';
            el.innerHTML = html;
            agentStream.appendChild(el);
            agentStream.scrollTop = agentStream.scrollHeight;
            return el;
        }

        const AGENT_LIVE_LABEL = {
            write_file: 'writing into the editor…',
            edit_file: 'editing in the editor…',
            run_command: 'running…'
        };

        function agentAddStep(call) {
            const empty = agentStream.querySelector('.empty');
            if (empty) { empty.remove(); }
            const row = document.createElement('div');
            row.className = 'agent-step';
            row.setAttribute('data-agent-step', call.id);
            const arg = call.args && (call.args.path || call.args.command || call.args.query || call.args.label) || '';
            const live = AGENT_LIVE_LABEL[call.name] ? '<span class="arg live-hint"> — ' + AGENT_LIVE_LABEL[call.name] + '</span>' : '';
            row.innerHTML = '<span class="badge">⋯</span>'
                + '<div class="body"><span class="name">' + escapeHtml(call.name) + '</span> '
                + '<span class="arg">' + escapeHtml(arg) + '</span>' + live + '</div>';
            agentStream.appendChild(row);
            agentSteps[call.id] = row;
            agentStream.scrollTop = agentStream.scrollHeight;
        }

        function agentCompleteStep(id, ok, output, diff) {
            const row = agentSteps[id];
            if (!row) { return; }
            const badge = row.querySelector('.badge');
            badge.textContent = ok ? '✓' : '✕';
            badge.className = 'badge ' + (ok ? 'ok' : 'fail');
            const body = row.querySelector('.body');
            // Drop the transient "writing…" hint now that the step is finished.
            const liveHint = body.querySelector('.live-hint');
            if (liveHint) { liveHint.remove(); }
            if (diff) {
                const counts = document.createElement('div');
                counts.className = 'arg';
                counts.innerHTML = '<b class="ok">+' + diff.added + '</b> <b class="fail">-' + diff.removed + '</b> line(s)';
                const nameSpan = body.querySelector('.name');
                if (nameSpan && nameSpan.nextSibling) {
                    body.insertBefore(counts, nameSpan.nextSibling);
                } else {
                    body.appendChild(counts);
                }
            }
            if (output) {
                const out = document.createElement('div');
                out.className = 'agent-out' + (ok ? '' : ' err');
                out.textContent = output.length > 1500 ? output.slice(0, 1500) + '\n… truncated' : output;
                body.appendChild(out);
            }
            if (diff) {
                const wrap = document.createElement('div');
                wrap.className = 'detail';
                wrap.innerHTML = renderDiff(diff);
                const node = wrap.querySelector('.diff');
                if (node) { wireDiffToggle(node); node.classList.add('open'); }
                body.appendChild(wrap);
            }
            agentStream.scrollTop = agentStream.scrollHeight;
        }

        function runAgentFromModal() {
            const content = agentTaskInput.value.trim();
            if (!content || agentModalBusy) { return; }
            agentStream.innerHTML = '';
            for (const k in agentSteps) { delete agentSteps[k]; }
            agentLog(escapeHtml(content), 'agent-msg user');
            setAgentBusy(true);
            agentModalSummary.textContent = 'Running…';
            vscode.postMessage({
                command: 'agentModalRun',
                content: content,
                autoApproveSafe: agentModalAutoApprove.checked,
                autonomy: agentModalAutonomy.value
            });
        }

        agentModalBtn.addEventListener('click', openAgentModal);
        agentModalClose.addEventListener('click', closeAgentModal);
        agentModalRun.addEventListener('click', runAgentFromModal);
        // Remember the chosen autonomy level so it survives reopening the panel.
        agentModalAutonomy.addEventListener('change', function () {
            vscode.postMessage({ command: 'setAutonomy', autonomy: agentModalAutonomy.value });
        });
        agentModalClear.addEventListener('click', function () {
            agentStream.innerHTML = '<div class="empty">' + agentEmptyState() + '</div>';
            for (const k in agentSteps) { delete agentSteps[k]; }
            agentModalSummary.textContent = 'Idle';
        });
        agentModalStop.addEventListener('click', function () {
            vscode.postMessage({ command: 'cancel' });
        });
        agentTaskInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                runAgentFromModal();
            }
        });
        agentModalBackdrop.addEventListener('click', function (e) {
            if (e.target === agentModalBackdrop && !agentModalBusy) { closeAgentModal(); }
        });

        resetChat();
        input.focus();
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
