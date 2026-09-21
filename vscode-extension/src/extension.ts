import * as vscode from 'vscode';
import { JavelinPanel } from './JavelinPanel';
import { setApiKey } from './aiService';
import { PROVIDERS, getProvider } from './providers';

/** Display order for the provider picker — Javelin's own model first. */
const PROVIDER_ORDER = ['javelin', 'local', 'groq', 'custom'];

const PROVIDER_BLURBS: Record<string, string> = {
    javelin: 'Your own fine-tuned Javelin weights — no API key',
    local: 'Ollama stock model — no API key, code stays on your machine',
    groq: 'Fast cloud inference — needs an API key',
    custom: 'Point at any /v1 endpoint',
};

/**
 * Check that the Javelin model is actually available before switching to it.
 * Returns true if the user is good to proceed.
 */
async function ensureJavelinModelServed(config: vscode.WorkspaceConfiguration): Promise<boolean> {
    const baseUrl = config.get<string>('baseUrl', '') || PROVIDERS.javelin.baseUrl;
    const model = config.get<string>('model', PROVIDERS.javelin.defaultModel) || PROVIDERS.javelin.defaultModel;

    let available: string[] | null = null;
    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
            signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
            const data: any = await res.json();
            available = (data?.data ?? []).map((m: any) => m.id);
        }
    } catch {
        available = null;
    }

    if (available === null) {
        const action = await vscode.window.showWarningMessage(
            `Javelin AI: could not reach ${baseUrl}. Is Ollama running?`,
            'How do I create the Javelin model?',
            'Use it anyway',
        );
        if (action === 'How do I create the Javelin model?') {
            await showJavelinModelHelp();
            return false;
        }
        return action === 'Use it anyway';
    }

    const hasModel = available.some((n) => n === model || n.startsWith(`${model}:`));
    if (!hasModel) {
        const action = await vscode.window.showWarningMessage(
            `Javelin AI: "${model}" is not served yet (available: ${available.join(', ') || 'none'}).`,
            'How do I create it?',
            'Use it anyway',
        );
        if (action === 'How do I create it?') {
            await showJavelinModelHelp();
            return false;
        }
        return action === 'Use it anyway';
    }

    return true;
}

/** Point the user at the real steps for training and serving their own model. */
async function showJavelinModelHelp(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
        'Creating the Javelin model: capture runs to build a dataset, fine-tune a base ' +
            'model, then serve the merged weights with Ollama.',
        'Open TRAINING.md',
        'Open the dataset builder',
    );
    if (choice === 'Open TRAINING.md') {
        const uri = vscode.Uri.joinPath(
            vscode.Uri.file(require('node:path').join(__dirname, '..', '..')),
            'docs',
            'TRAINING.md',
        );
        // Fall back gracefully if the doc is not alongside the extension.
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        } catch {
            vscode.env.openExternal(
                vscode.Uri.parse('https://github.com/javelin-ai/javelin-ai-assistant/blob/main/docs/TRAINING.md'),
            );
        }
    } else if (choice === 'Open the dataset builder') {
        const terminal = vscode.window.createTerminal('Javelin: training');
        terminal.show();
        terminal.sendText('npm run train:dataset', false);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new JavelinPanel(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(JavelinPanel.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    // Focus the assistant view.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.openAssistant', async () => {
            await vscode.commands.executeCommand('javelin.assistant.focus');
        }),
    );

    // Store the key in encrypted SecretStorage rather than plain settings.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                title: 'Javelin AI: Groq API key',
                prompt: 'Paste your key from https://console.groq.com/keys (stored encrypted by VS Code)',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'gsk_...',
            });
            if (key === undefined) {
                return;
            }
            if (!key.trim()) {
                await setApiKey(context, '');
                vscode.window.showInformationMessage('Javelin AI: API key cleared.');
                return;
            }
            await setApiKey(context, key);
            vscode.window.showInformationMessage('Javelin AI: API key saved.');
        }),
    );

    // Run a task on Javelin Core — its own reasoning lifecycle.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.runJavelinTask', async () => {
            await provider.runJavelinTaskCommand();
        }),
    );

    // Run an autonomous agent task against the workspace.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.runAgentTask', async () => {
            await provider.runAgentTask();
        }),
    );

    // Open the dedicated coding-agent modal.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.openCodingAgent', async () => {
            await provider.openCodingAgent();
        }),
    );

    // Stop the running agent.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.stopAgent', () => {
            provider.stopEverything();
        }),
    );

    // Restore a checkpoint by picking from the saved list.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.restoreCheckpoint', async () => {
            const saved = context.globalState.get<{ id: string; label: string; timestamp: number }[]>(
                'checkpoints',
                [],
            );
            if (!saved.length) {
                vscode.window.showInformationMessage('Javelin AI: no checkpoints yet.');
                return;
            }
            const pick = await vscode.window.showQuickPick(
                saved.map((cp) => ({
                    label: `$(history) ${cp.label}`,
                    description: new Date(cp.timestamp).toLocaleTimeString(),
                    id: cp.id,
                })),
                { title: 'Javelin AI: restore checkpoint' },
            );
            if (pick) {
                await provider.restoreCheckpointById(pick.id);
            }
        }),
    );

    // Pick where the model runs: keyless local, or a cloud provider.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.selectProvider', async () => {
            const config = vscode.workspace.getConfiguration('javelin');
            const current = config.get<string>('provider', 'local');

            // Built from the registry so this list cannot drift from the providers
            // that actually exist.
            const items = PROVIDER_ORDER.map((id) => {
                const provider = PROVIDERS[id];
                return {
                    label: provider.label + (provider.isJavelinModel ? '  $(star-full)' : ''),
                    description: PROVIDER_BLURBS[id],
                    id,
                    isJavelinModel: Boolean(provider.isJavelinModel),
                };
            });

            const pick = await vscode.window.showQuickPick(
                items.map((i) => ({ ...i, picked: i.id === current })),
                { title: 'Javelin AI: where should the model run?' },
            );
            if (!pick) {
                return;
            }

            // Selecting the trained model is worth validating: if the weights were
            // never created, every request would fail with a confusing 404.
            if (pick.isJavelinModel) {
                const ready = await ensureJavelinModelServed(config);
                if (!ready) {
                    return;
                }
            }

            await config.update('provider', pick.id, vscode.ConfigurationTarget.Global);
            if (pick.id === 'javelin') {
                await config.update('model', PROVIDERS.javelin.defaultModel, vscode.ConfigurationTarget.Global);
            }
            vscode.window.showInformationMessage(`Javelin AI: using ${pick.label.trim()}.`);
        }),
    );

    // Send the current selection to the chat, optionally with a question.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.askAboutSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Javelin AI: open a file and select some code first.');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection.trim()) {
                vscode.window.showWarningMessage('Javelin AI: nothing selected.');
                return;
            }
            const question = await vscode.window.showInputBox({
                title: 'Javelin AI: ask about the selection',
                prompt: 'What do you want to know? Leave empty to attach the selection to the chat.',
                ignoreFocusOut: true,
                placeHolder: 'e.g. Find bugs and suggest improvements',
            });
            if (question === undefined) {
                return;
            }
            await provider.askAboutSelection(selection, question.trim() || undefined);
        }),
    );
}

export function deactivate() { }
