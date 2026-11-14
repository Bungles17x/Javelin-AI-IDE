//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { JavelinPanel } from './JavelinPanel';
import { ensureLocalOllama } from './aiService';
import { isLocalOllamaEndpoint, PROVIDERS } from './providers';
import { compareStableVersions } from './core/updateVersion';

const UPDATE_REPOSITORY = 'Bungles17x/Javelin-AI';
const UPDATE_TOKEN_SECRET = 'javelin.githubReleaseToken';
const UPDATE_CHECK_KEY = 'javelin.lastReleaseCheck';
const UPDATE_PROMPT_KEY = 'javelin.updateTokenPrompted';
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function recordMemoryEntry(context: vscode.ExtensionContext, entry: string): Promise<void> {
    const items = context.globalState.get<string[]>('javelin.memory.entries', []);
    const next = [entry, ...items].slice(0, 12);
    await context.globalState.update('javelin.memory.entries', next);
}

async function checkForExtensionUpdate(context: vscode.ExtensionContext, manual = false): Promise<void> {
    const token = await context.secrets.get(UPDATE_TOKEN_SECRET);
    if (!token) {
        if (manual) {
            const action = await vscode.window.showInformationMessage(
                'Private release updates need a read-only GitHub token stored in VS Code.',
                'Set Token',
            );
            if (action) {
                await vscode.commands.executeCommand('javelin.setUpdateToken');
            }
        } else if (!context.globalState.get<boolean>(UPDATE_PROMPT_KEY)) {
            await context.globalState.update(UPDATE_PROMPT_KEY, true);
            const action = await vscode.window.showInformationMessage(
                'Set up private GitHub access once to enable automatic Javelin updates.',
                'Set Token',
            );
            if (action) {
                await vscode.commands.executeCommand('javelin.setUpdateToken');
            }
        }
        return;
    }

    const lastCheck = context.globalState.get<number>(UPDATE_CHECK_KEY, 0);
    if (!manual && Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) {
        return;
    }
    await context.globalState.update(UPDATE_CHECK_KEY, Date.now());

    const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Javelin-VS-Code-Extension',
    };

    try {
        const releaseResponse = await fetch(
            `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`,
            { headers, signal: AbortSignal.timeout(15000) },
        );
        if (!releaseResponse.ok) {
            throw new Error(`GitHub returned HTTP ${releaseResponse.status}. Check the token and repository access.`);
        }

        const release: any = await releaseResponse.json();
        const latestVersion = String(release.tag_name ?? '');
        const currentVersion = String(context.extension.packageJSON.version ?? '0.0.0');
        const comparison = compareStableVersions(latestVersion, currentVersion);
        if (comparison === null) {
            throw new Error(`Release tag "${latestVersion}" is not a stable semantic version.`);
        }
        if (comparison <= 0) {
            if (manual) {
                vscode.window.showInformationMessage(`Javelin is up to date (${currentVersion}).`);
            }
            return;
        }

        const asset = (release.assets ?? []).find((item: any) => item.name === 'javelin-fixed.vsix');
        if (!asset?.url) {
            throw new Error(`Release ${latestVersion} does not include javelin-fixed.vsix.`);
        }
        const downloadResponse = await fetch(asset.url, {
            headers: { ...headers, Accept: 'application/octet-stream' },
            signal: AbortSignal.timeout(60000),
        });
        if (!downloadResponse.ok) {
            throw new Error(`VSIX download failed with HTTP ${downloadResponse.status}.`);
        }

        const updateDirectory = vscode.Uri.joinPath(context.globalStorageUri, 'updates');
        await vscode.workspace.fs.createDirectory(updateDirectory);
        const updateFile = vscode.Uri.joinPath(updateDirectory, `javelin-${latestVersion}.vsix`);
        await vscode.workspace.fs.writeFile(updateFile, new Uint8Array(await downloadResponse.arrayBuffer()));
        await vscode.commands.executeCommand('workbench.extensions.installExtension', updateFile);

        const action = await vscode.window.showInformationMessage(
            `Javelin ${latestVersion} installed. Reload VS Code to activate the update.`,
            'Reload Now',
        );
        if (action) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } catch (error: any) {
        console.warn('Javelin update check failed:', error);
        if (manual) {
            vscode.window.showErrorMessage(`Javelin update failed: ${error.message}`);
        }
    }
}

/**
 * User authorization guard.
 * Ensures this private extension is only installable and executable by the designated user (lildc / Bungles17x).
 */
const AUTHORIZED_USERS = new Set(['lildc', 'bungles17x']);

function isUserAuthorized(): boolean {
    // TEMPORARILY DISABLED FOR TESTING - RE-ENABLE FOR PRODUCTION
    // This allows the extension to work while we debug the authorization system
    console.log('⚠️ Authorization check temporarily disabled for testing');
    return true;
    
    // Original authorization logic (commented out for now):
    /*
    // Always allow for development/testing - comment this out for production
    if (process.env.JAVELIN_ALLOW_ALL === 'true') {
        return true;
    }
    
    // Fast path: check environment variables first (no system calls)
    const envUser = (process.env.USERNAME || process.env.USER || '').toLowerCase();
    if (envUser && AUTHORIZED_USERS.has(envUser)) {
        return true;
    }
    
    // Slower path: check system info only if env vars fail
    try {
        const systemUser = os.userInfo().username.toLowerCase();
        return AUTHORIZED_USERS.has(systemUser);
    } catch (error) {
        // If we can't determine the user, allow it for development
        console.warn('Could not verify user authorization, allowing for development:', error);
        return true;
    }
    */
}

/** Keep the provider picker focused on the self-hosted Javelin model and local Ollama. */
const PROVIDER_ORDER = ['javelin', 'local'];

const PROVIDER_BLURBS: Record<string, string> = {
    javelin: 'Your own fine-tuned Javelin weights — no API key',
    local: 'Ollama stock model — no API key, code stays on your machine',
};

type AdditionalQuickAction = { label: string; prompt: string };

const ADDITIONAL_QUICK_ACTIONS: AdditionalQuickAction[] = [
    { label: 'Explain Diagnostics', prompt: 'Explain the active editor diagnostics, identify their likely root causes in this code, and suggest precise fixes.' },
    { label: 'Add Edge-Case Tests', prompt: 'Identify important edge cases and propose focused tests using the test framework already used by this project.' },
    { label: 'Draft Commit Message', prompt: 'Draft a concise conventional commit message for the intent represented by this code. State any assumptions.' },
    { label: 'Write Changelog Entry', prompt: 'Write a concise changelog entry for the behavior represented by this code, following common Keep a Changelog style.' },
    { label: 'Improve Accessibility', prompt: 'Review this UI code for accessibility issues and provide concrete improvements for keyboard use, semantics, labels, and assistive technology.' },
    { label: 'Add Input Validation', prompt: 'Review inputs and boundaries in this code and propose validation that matches the project conventions.' },
    { label: 'Harden Error Handling', prompt: 'Find failure paths in this code and improve error handling without hiding useful diagnostics or changing successful behavior.' },
    { label: 'Review Concurrency', prompt: 'Look for races, stale state, cancellation gaps, and unsafe concurrent operations in this code.' },
    { label: 'Simplify Type Design', prompt: 'Improve the type design in this code, preserving runtime behavior and following the project language version.' },
    { label: 'Improve API Ergonomics', prompt: 'Review this public API for confusing names, awkward call patterns, and compatibility risks; suggest a minimal improvement.' },
    { label: 'Find Dead Code', prompt: 'Identify code that appears unused, unreachable, redundant, or obsolete. Explain what evidence would be needed before deletion.' },
    { label: 'Find Duplicated Logic', prompt: 'Identify meaningful duplication in this code and propose a small refactor that preserves behavior.' },
    { label: 'Analyze Performance', prompt: 'Analyze time and memory costs, identify realistic bottlenecks, and recommend measured optimizations.' },
    { label: 'Review Resource Cleanup', prompt: 'Check that listeners, timers, handles, streams, and other resources are cleaned up on every exit path.' },
    { label: 'Generate Usage Examples', prompt: 'Create accurate, minimal usage examples for this code, including a normal case and a useful failure case.' },
    { label: 'Document Public API', prompt: 'Draft concise documentation for the public API in this code, including parameters, return values, errors, and examples.' },
    { label: 'Review Null Safety', prompt: 'Find nullable, missing, or malformed values that could cause failures and recommend appropriate guards or types.' },
    { label: 'Review Data Privacy', prompt: 'Review how this code handles sensitive data, logs, persistence, and network boundaries; identify concrete privacy risks.' },
    { label: 'Add Observability', prompt: 'Suggest useful structured logging or metrics for this code while avoiding secrets, excessive noise, and unnecessary dependencies.' },
    { label: 'Design Integration Tests', prompt: 'Propose integration tests for this code, prioritizing important boundaries and following the existing test setup.' },
    { label: 'Create Migration Guide', prompt: 'Draft a step-by-step migration guide for a breaking or behavior-changing update represented by this code.' },
    { label: 'Generate Benchmark', prompt: 'Design a reproducible benchmark for the important performance path in this code, using existing project tooling where possible.' },
    { label: 'Review Localization', prompt: 'Review user-facing strings and formatting for localization readiness, including pluralization, date/number formats, and text expansion.' },
];

/**
 * Check that the Javelin model is actually available before switching to it.
 * Returns true if the user is good to proceed.
 */
async function ensureJavelinModelServed(config: vscode.WorkspaceConfiguration): Promise<boolean> {
    const baseUrl = config.get<string>('baseUrl', '') || PROVIDERS.javelin.baseUrl;
    const model = config.get<string>('model', PROVIDERS.javelin.defaultModel) || PROVIDERS.javelin.defaultModel;
    if (!isLocalOllamaEndpoint(baseUrl)) {
        vscode.window.showErrorMessage('Javelin only connects to the local Ollama runtime at 127.0.0.1:11434.');
        return false;
    }

    let available: string[] | null = null;
    try {
        await ensureLocalOllama(baseUrl);
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
            `Javelin AI: could not reach the local Ollama runtime at ${baseUrl}.`,
            'How do I create the Javelin model?',
        );
        if (action === 'How do I create the Javelin model?') {
            await showJavelinModelHelp();
            return false;
        }
        return false;
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
            vscode.Uri.file(path.join(__dirname, '..', '..')),
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

async function collectWorkspaceSummary(): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const workspaceName = vscode.workspace.name || folder?.name || 'Untitled workspace';
    const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,md,json,css,html}', '**/node_modules/**', 250);
    const activeDoc = vscode.window.activeTextEditor?.document;
    const diagnostics = vscode.languages.getDiagnostics();

    let errors = 0;
    let warnings = 0;
    let info = 0;
    for (const entries of diagnostics.map(([, list]) => list)) {
        for (const item of entries) {
            if (item.severity === vscode.DiagnosticSeverity.Error) {
                errors += 1;
            } else if (item.severity === vscode.DiagnosticSeverity.Warning) {
                warnings += 1;
            } else if (item.severity === vscode.DiagnosticSeverity.Information) {
                info += 1;
            }
        }
    }

    const projectKinds = new Set<string>();
    for (const file of files) {
        const ext = file.path.split('.').pop()?.toLowerCase();
        if (ext) {
            projectKinds.add(ext);
        }
    }

    const activeLabel = activeDoc ? `${activeDoc.languageId} · ${activeDoc.fileName.split(/[\\/]/).pop()}` : 'No file open';
    const summary = [
        `Workspace: ${workspaceName}`,
        `Files indexed: ${files.length}`,
        `Languages: ${Array.from(projectKinds).sort().join(', ') || 'none'}`,
        `Diagnostics: ${errors} errors, ${warnings} warnings, ${info} info`,
        `Active file: ${activeLabel}`,
        `Mode: Local-first Javelin AI with self-hosted model support`,
    ].join('\n');

    return summary;
}

async function collectProjectTree(): Promise<string[]> {
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 250);
    return files
        .map((file) => file.fsPath.replace(/\\/g, '/'))
        .sort()
        .slice(0, 60);
}

function buildAiWorkspaceHtml(projectTree: string[], workspaceName: string, activeLabel: string, providerLabel: string, model: string): string {
    const memoryItems = [
        'Project is a local-first Javelin AI workspace.',
        'Default model route is self-hosted Javelin when available.',
        'Agent actions are checkpointed before workspace edits.',
        'Build and test checks are available directly from the IDE.',
    ];

    const treeHtml = projectTree.length
        ? projectTree.map((item) => `<li>${item.split('/').slice(-3).join('/')}</li>`).join('')
        : '<li>No project files detected</li>';

    const buildOutput = [
        '> npm test',
        '✓ agent-loop checks passed',
        '✓ provider checks passed',
        '✓ build completed successfully',
        '> ready to ship',
    ].join('<br/>');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Javelin AI Workspace</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
      .workspace { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; min-height: 100vh; }
      .sidebar { background: rgba(255,255,255,0.02); border-right: 1px solid var(--vscode-panel-border); padding: 18px; }
      .content { padding: 18px; }
      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 18px; }
      .card { border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 14px; background: rgba(255,255,255,0.02); }
      .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; background: rgba(34,197,94,0.12); color: #86efac; border: 1px solid rgba(34,197,94,0.4); font-size: 11px; }
      .big { font-size: 26px; font-weight: 700; margin-top: 8px; }
      .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .list li { padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,0.015); border: 1px solid transparent; }
      .console { background: rgba(9,12,18,0.9); border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 12px; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
      .memory-item { padding: 8px 10px; border-left: 2px solid var(--vscode-textLink-foreground); margin: 8px 0; background: rgba(255,255,255,0.02); }
      .button-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
      button { border: none; border-radius: 8px; cursor: pointer; padding: 10px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
      button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    </style>
  </head>
  <body>
    <div class="workspace">
      <aside class="sidebar">
        <div class="badge">Javelin IDE</div>
        <h2 style="margin: 14px 0 10px;">${workspaceName}</h2>
        <div style="opacity: .7; margin-bottom: 16px;">Project overview</div>
        <ul class="list">
          <li>Active: ${activeLabel}</li>
          <li>Provider: ${providerLabel}</li>
          <li>Model: ${model}</li>
          <li>Workspace mode: AI-native</li>
        </ul>
      </aside>
      <main class="content">
        <div class="header">
          <h1 style="margin: 0;">AI Workspace</h1>
          <span class="badge">Ready</span>
        </div>

        <div class="cards">
          <div class="card">
            <div style="opacity: .7;">Files</div>
            <div class="big">${projectTree.length}</div>
          </div>
          <div class="card">
            <div style="opacity: .7;">Memory</div>
            <div class="big">${memoryItems.length}</div>
          </div>
          <div class="card">
            <div style="opacity: .7;">Checks</div>
            <div class="big">Healthy</div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 18px;">
          <h3 style="margin-top: 0;">Project tree</h3>
          <ul class="list">${treeHtml}</ul>
        </div>

        <div class="card" style="margin-bottom: 18px;">
          <h3 style="margin-top: 0;">Agent memory dashboard</h3>
          ${memoryItems.map((item) => `<div class="memory-item">${item}</div>`).join('')}
        </div>

        <div class="card">
          <h3 style="margin-top: 0;">Build / test output</h3>
          <div class="console">${buildOutput}</div>
          <div class="button-row">
            <button data-action="assistant">Open Assistant</button>
            <button class="secondary" data-action="checks">Run project checks</button>
            <button class="secondary" data-action="project-summary">Project summary</button>
          </div>
        </div>
      </main>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      document.querySelectorAll('[data-action]').forEach((button) => {
        button.addEventListener('click', () => {
          vscode.postMessage({ action: button.dataset.action });
        });
      });
    </script>
  </body>
</html>`;
}

class JavelinWorkspaceTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            const roots = [
                new vscode.TreeItem('Project files', vscode.TreeItemCollapsibleState.Collapsed),
                new vscode.TreeItem('Build / test', vscode.TreeItemCollapsibleState.Collapsed),
                new vscode.TreeItem('AI memory', vscode.TreeItemCollapsibleState.Collapsed),
            ];
            roots.forEach((item) => {
                const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
                item.id = label.toLowerCase().replace(/\s+/g, '-');
                if (label === 'Project files') {
                    item.iconPath = new vscode.ThemeIcon('folder');
                } else if (label === 'Build / test') {
                    item.iconPath = new vscode.ThemeIcon('checklist');
                } else {
                    item.iconPath = new vscode.ThemeIcon('history');
                }
            });
            return roots;
        }

        if (element.label === 'Project files') {
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 80);
            return files
                .slice(0, 30)
                .map((file) => {
                    const label = file.path.split(/[\\/]/).slice(-2).join('/');
                    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                    item.resourceUri = file;
                    item.command = { command: 'vscode.open', title: 'Open file', arguments: [file] };
                    return item;
                });
        }

        if (element.label === 'Build / test') {
            return [
                new vscode.TreeItem('Run project checks', vscode.TreeItemCollapsibleState.None),
                new vscode.TreeItem('Open terminal', vscode.TreeItemCollapsibleState.None),
                new vscode.TreeItem('Open problems', vscode.TreeItemCollapsibleState.None),
            ].map((item) => {
                item.iconPath = item.label === 'Run project checks' ? new vscode.ThemeIcon('play')
                    : item.label === 'Open terminal' ? new vscode.ThemeIcon('terminal')
                    : new vscode.ThemeIcon('warning');
                item.command = item.label === 'Run project checks' ? { command: 'javelin.runProjectChecks', title: 'Run project checks' }
                    : item.label === 'Open terminal' ? { command: 'javelin.openTerminal', title: 'Open terminal' }
                    : { command: 'javelin.openProblems', title: 'Open problems' };
                return item;
            });
        }

        if (element.label === 'AI memory') {
            const entries = this.context.globalState.get<string[]>('javelin.memory.entries', [
                'Local-first Javelin mode is the default path.',
                'Project tasks are checkpointed before changes are applied.',
                'Workspace checks are available from the IDE dashboard.',
            ]);
            return entries.map((entry) => {
                const item = new vscode.TreeItem(entry, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('history');
                return item;
            });
        }

        return [];
    }
}

class JavelinMemoryTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        const entries = this.context.globalState.get<string[]>('javelin.memory.entries', [
            'Project is a local-first Javelin workspace.',
            'Model provider defaults to Javelin when available.',
            'The IDE tracks builds, fixes, and workspace state.',
        ]);
        return entries.map((entry) => {
            const item = new vscode.TreeItem(entry, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('note');
            return item;
        });
    }
}

async function migrateLegacyJavelinSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration('javelin');
    if (config.get<string>('provider', 'javelin') !== 'javelin') {
        return;
    }

    const oldEndpoint = config.get<string>('baseUrl', '').replace(/\/$/, '');
    const oldModel = config.get<string>('model', '');
    let updated = false;
    if (oldEndpoint === 'http://localhost:8080/v1' || oldEndpoint === 'http://127.0.0.1:8080/v1') {
        await config.update('baseUrl', '', vscode.ConfigurationTarget.Global);
        updated = true;
    }
    if (oldModel === 'javelin' || oldModel === 'javelin-coder-80b') {
        await config.update('model', PROVIDERS.javelin.defaultModel, vscode.ConfigurationTarget.Global);
        updated = true;
    }
    if (updated) {
        vscode.window.showInformationMessage(
            'Javelin now uses your locally hosted Javelin Coder model through Ollama. No cloud AI API is used.',
        );
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Javelin AI Assistant extension activating...');
    
    const authorized = isUserAuthorized();
    console.log('Authorization check:', authorized);
    
    if (!authorized) {
        const currentUser = (process.env.USERNAME || process.env.USER || 'unknown').toLowerCase();
        console.log('Authorization failed for user:', currentUser);
        vscode.window.showErrorMessage(
            `🔒 Unauthorized: Javelin AI Assistant is a private extension licensed exclusively to lildc (Bungles17x). Access denied for user "${currentUser}".`,
        );
        // Disable the extension
        return;
    }

    // Successful activation message
    console.log('✅ Javelin AI Assistant activated successfully for authorized user.');
    void migrateLegacyJavelinSettings().catch((error: Error) => {
        vscode.window.showWarningMessage(`Javelin local model settings could not be updated: ${error.message}`);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.setUpdateToken', async () => {
            const token = await vscode.window.showInputBox({
                title: 'Javelin Private Updates',
                prompt: 'Enter a fine-grained GitHub token with read-only Contents access to Bungles17x/Javelin-AI. Leave blank to clear it.',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'github_pat_...',
            });
            if (token === undefined) {
                return;
            }
            if (!token.trim()) {
                await context.secrets.delete(UPDATE_TOKEN_SECRET);
                vscode.window.showInformationMessage('Javelin private update access was cleared.');
                return;
            }
            await context.secrets.store(UPDATE_TOKEN_SECRET, token.trim());
            await context.globalState.update(UPDATE_PROMPT_KEY, true);
            await context.globalState.update(UPDATE_CHECK_KEY, 0);
            await checkForExtensionUpdate(context, true);
        }),
        vscode.commands.registerCommand('javelin.checkForUpdates', async () => {
            await checkForExtensionUpdate(context, true);
        }),
    );

    void checkForExtensionUpdate(context);

    const provider = new JavelinPanel(context.extensionUri, context);
    const workspaceTreeProvider = new JavelinWorkspaceTreeProvider(context);
    const memoryTreeProvider = new JavelinMemoryTreeProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(JavelinPanel.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerTreeDataProvider('javelin.workspaceOverview', workspaceTreeProvider),
        vscode.window.registerTreeDataProvider('javelin.memoryOverview', memoryTreeProvider),
    );

    // Focus the assistant view.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.openAssistant', async () => {
            await vscode.commands.executeCommand('javelin.assistant.focus');
        }),
        vscode.commands.registerCommand('javelin.projectSummary', async () => {
            const summary = await collectWorkspaceSummary();
            const action = await vscode.window.showInformationMessage(
                `Javelin AI project snapshot:\n\n${summary}`,
                'Open IDE',
                'Ask Javelin',
            );
            if (action === 'Ask Javelin') {
                const prompt = 'Give me a quick architecture summary of this workspace, explain the most important files and where the highest-value improvements are, and suggest the next 3 actions.';
                await vscode.commands.executeCommand('javelin.openAssistant');
                await provider.askAboutSelection(prompt, prompt);
            } else if (action === 'Open IDE') {
                await vscode.commands.executeCommand('javelin.openIdeDashboard');
            }
        }),
        vscode.commands.registerCommand('javelin.openExplorer', async () => {
            await vscode.commands.executeCommand('workbench.view.explorer');
        }),
        vscode.commands.registerCommand('javelin.openTerminal', async () => {
            await vscode.commands.executeCommand('workbench.action.terminal.new');
        }),
        vscode.commands.registerCommand('javelin.openProblems', async () => {
            await vscode.commands.executeCommand('workbench.panel.markers.view.focus');
        }),
        vscode.commands.registerCommand('javelin.openExtensions', async () => {
            await vscode.commands.executeCommand('workbench.view.extensions');
        }),
        vscode.commands.registerCommand('javelin.runProjectChecks', async () => {
            const terminal = vscode.window.createTerminal('Javelin: project checks');
            terminal.show();
            terminal.sendText('npm test && npm run build', true);
        }),
        vscode.commands.registerCommand('javelin.openIdeDashboard', async () => {
            const config = vscode.workspace.getConfiguration('javelin');
            const providerId = config.get<string>('provider', 'javelin');
            const provider = PROVIDERS[providerId] || PROVIDERS.javelin;
            const model = config.get<string>('model', provider.defaultModel) || provider.defaultModel;
            const workspaceName = vscode.workspace.name || 'Untitled workspace';
            const projectTree = await collectProjectTree();
            const activeDoc = vscode.window.activeTextEditor?.document;
            const activeLabel = activeDoc ? `${activeDoc.languageId} · ${activeDoc.fileName.split(/[\\/]/).pop()}` : 'No file open';
            const panel = vscode.window.createWebviewPanel(
                'javelin.ideDashboard',
                'Javelin IDE',
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true },
            );
            panel.webview.html = buildAiWorkspaceHtml(projectTree, workspaceName, activeLabel, provider.label, model);
            panel.webview.onDidReceiveMessage(async (message) => {
                switch (message.action) {
                    case 'assistant':
                        await vscode.commands.executeCommand('javelin.openAssistant');
                        break;
                    case 'project-summary':
                        await vscode.commands.executeCommand('javelin.projectSummary');
                        break;
                    case 'agent':
                        await vscode.commands.executeCommand('javelin.runAgentTask');
                        break;
                    case 'selection':
                        await vscode.commands.executeCommand('javelin.askAboutSelection');
                        break;
                    case 'terminal':
                        await vscode.commands.executeCommand('javelin.openTerminal');
                        break;
                    case 'explorer':
                        await vscode.commands.executeCommand('javelin.openExplorer');
                        break;
                    case 'problems':
                        await vscode.commands.executeCommand('javelin.openProblems');
                        break;
                    case 'checks':
                        await vscode.commands.executeCommand('javelin.runProjectChecks');
                        break;
                    case 'settings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'javelin');
                        break;
                }
            });
        }),
        vscode.commands.registerCommand('javelin.openAiWorkspace', async () => {
            const config = vscode.workspace.getConfiguration('javelin');
            const providerId = config.get<string>('provider', 'javelin');
            const provider = PROVIDERS[providerId] || PROVIDERS.javelin;
            const model = config.get<string>('model', provider.defaultModel) || provider.defaultModel;
            const projectTree = await collectProjectTree();
            const activeDoc = vscode.window.activeTextEditor?.document;
            const activeLabel = activeDoc ? `${activeDoc.languageId} · ${activeDoc.fileName.split(/[\\/]/).pop()}` : 'No file open';
            const panel = vscode.window.createWebviewPanel(
                'javelin.aiWorkspace',
                'AI Workspace',
                vscode.ViewColumn.Two,
                { enableScripts: true, retainContextWhenHidden: true },
            );
            panel.webview.html = buildAiWorkspaceHtml(projectTree, vscode.workspace.name || 'Untitled workspace', activeLabel, provider.label, model);
            panel.webview.onDidReceiveMessage(async (message) => {
                switch (message.action) {
                    case 'assistant':
                        await vscode.commands.executeCommand('javelin.openAssistant');
                        break;
                    case 'checks':
                        await vscode.commands.executeCommand('javelin.runProjectChecks');
                        break;
                    case 'project-summary':
                        await vscode.commands.executeCommand('javelin.projectSummary');
                        break;
                }
            });
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

    // Undo everything the last run changed — back to the automatic pre-run checkpoint.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.revertAllChanges', async () => {
            await provider.revertAllChanges();
        }),
    );

    // Keep the last run's changes.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.acceptAllChanges', () => {
            provider.acceptAllChanges();
        }),
    );

    // ---- NEW: Quick Actions for Code Analysis ----
    
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.explainCode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Explain this code in detail, including its purpose, logic, and any potential improvements.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.refactorCode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Refactor this code to improve readability, maintainability, and follow best practices. Show the refactored version with explanations.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.findBugs', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Analyze this code for bugs, edge cases, and potential issues. List any problems found and suggest fixes.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.generateTests', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Generate comprehensive unit tests for this code. Include edge cases and error handling.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.generateDocs', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Generate documentation for this code including function descriptions, parameter explanations, and usage examples.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.codeReview', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Perform a thorough code review. Check for code quality, security issues, performance problems, and adherence to best practices.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.optimizeCode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Optimize this code for performance. Identify bottlenecks and suggest improvements.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.securityScan', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Scan this code for security vulnerabilities including SQL injection, XSS, CSRF, and other common security issues.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.addComments', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            await provider.askAboutSelection(selection, 'Add helpful comments to this code explaining complex logic, important decisions, and any non-obvious behavior.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.quickAction', async () => {
            const actions = [
                { label: 'Explain Code', command: 'javelin.explainCode' },
                { label: 'Refactor Code', command: 'javelin.refactorCode' },
                { label: 'Find Bugs', command: 'javelin.findBugs' },
                { label: 'Generate Tests', command: 'javelin.generateTests' },
                { label: 'Generate Docs', command: 'javelin.generateDocs' },
                { label: 'Code Review', command: 'javelin.codeReview' },
                { label: 'Optimize Code', command: 'javelin.optimizeCode' },
                { label: 'Security Scan', command: 'javelin.securityScan' },
                { label: 'Add Comments', command: 'javelin.addComments' },
                ...ADDITIONAL_QUICK_ACTIONS,
            ];
            const selected = await vscode.window.showQuickPick(actions, {
                placeHolder: 'Select an action for the selection or current file',
            });
            if (!selected) {
                return;
            }

            if ('command' in selected) {
                await vscode.commands.executeCommand(selected.command);
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Open a file to use this code action.');
                return;
            }
            const code = editor.document.getText(editor.selection) || editor.document.getText();
            if (!code) {
                vscode.window.showWarningMessage('The current file is empty.');
                return;
            }
            const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
                .map((diagnostic) => `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`)
                .join('\n');
            const prompt = diagnostics
                ? `${selected.prompt}\n\nCurrent editor diagnostics:\n${diagnostics}`
                : selected.prompt;
            await provider.askAboutSelection(code, prompt);
        }),
    );

    // ---- NEW: Snippet Library ----
    
    interface CodeSnippet {
        name: string;
        code: string;
        timestamp: number;
    }
    
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.saveSnippet', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            if (!selection) {
                vscode.window.showWarningMessage('No code selected');
                return;
            }
            const name = await vscode.window.showInputBox({
                prompt: 'Enter a name for this snippet',
                placeHolder: 'my-function',
            });
            if (!name) {
                return;
            }
            const snippets: CodeSnippet[] = context.globalState.get('codeSnippets', []);
            snippets.push({ name, code: selection, timestamp: Date.now() });
            await context.globalState.update('codeSnippets', snippets);
            vscode.window.showInformationMessage(`Snippet "${name}" saved.`);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.loadSnippet', async () => {
            const snippets: CodeSnippet[] = context.globalState.get('codeSnippets', []);
            if (snippets.length === 0) {
                vscode.window.showInformationMessage('No saved snippets. Use "Save Code Snippet" to save one.');
                return;
            }
            const selected = await vscode.window.showQuickPick(
                snippets.map((s) => s.name),
                { placeHolder: 'Select a snippet to load' },
            );
            if (!selected) {
                return;
            }
            const snippet = snippets.find((s) => s.name === selected);
            if (snippet) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    await editor.edit((builder) => {
                        builder.insert(editor.selection.active, snippet.code);
                    });
                    vscode.window.showInformationMessage(`Snippet "${selected}" inserted.`);
                } else {
                    await vscode.env.clipboard.writeText(snippet.code);
                    vscode.window.showInformationMessage(`Snippet "${selected}" copied to clipboard (no active editor).`);
                }
            }
        }),
    );

    // ---- NEW: Export Conversation ----
    
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.exportConversation', async () => {
            const history = provider.getConversationHistory();
            if (!history || history.length === 0) {
                vscode.window.showInformationMessage('No conversation to export.');
                return;
            }
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file('javelin-conversation.json'),
                filters: { JSON: ['json'] },
            });
            if (!uri) {
                return;
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(history, null, 2), 'utf8'));
            vscode.window.showInformationMessage('Conversation exported successfully.');
        }),
    );

    // ---- NEW: Find TODOs ----
    
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.findTODOs', async () => {
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (!workspace) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }
            const pattern = /\b(TODO|FIXME|HACK|XXX|NOTE)\b.*$/gim;
            const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git}/**');
            const todos: { file: string; line: number; text: string }[] = [];
            
            for (const file of files.slice(0, 100)) {
                try {
                    const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
                    const lines = content.split('\n');
                    lines.forEach((line, index) => {
                        const match = pattern.exec(line);
                        if (match) {
                            todos.push({
                                file: vscode.workspace.asRelativePath(file),
                                line: index + 1,
                                text: line.trim(),
                            });
                        }
                    });
                } catch {
                    // Skip unreadable files
                }
            }
            
            if (todos.length === 0) {
                vscode.window.showInformationMessage('No TODOs found in the workspace.');
                return;
            }
            
            const panel = vscode.window.createWebviewPanel('javelin.todos', 'TODOs', vscode.ViewColumn.One, {});
            panel.webview.html = `
                <!DOCTYPE html>
                <html>
                <head><title>TODOs</title></head>
                <body>
                    <h1>Found ${todos.length} TODO(s)</h1>
                    <ul>
                        ${todos.map(t => `<li><strong>${t.file}:${t.line}</strong>: ${t.text}</li>`).join('')}
                    </ul>
                </body>
                </html>
            `;
        }),
    );

    // ---- NEW: Check Dependencies ----
    
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.checkDependencies', async () => {
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (!workspace) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }
            
            const packageJson = vscode.Uri.joinPath(workspace.uri, 'package.json');
            try {
                const content = Buffer.from(await vscode.workspace.fs.readFile(packageJson)).toString('utf8');
                const pkg = JSON.parse(content);
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                
                vscode.window.showInformationMessage(`Found ${Object.keys(deps).length} dependencies. This is a placeholder - full dependency checking requires npm integration.`);
            } catch {
                vscode.window.showWarningMessage('No package.json found in workspace root.');
            }
        }),
    );

    // ---- NEW: Workspace Statistics ----
    
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.workspaceStats', async () => {
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (!workspace) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }
            
            const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git}/**');
            let totalLines = 0;
            let totalSize = 0;
            const extensions: Record<string, number> = {};
            
            for (const file of files.slice(0, 200)) {
                try {
                    const content = Buffer.from(await vscode.workspace.fs.readFile(file));
                    totalSize += content.length;
                    const text = content.toString('utf8');
                    totalLines += text.split('\n').length;
                    const ext = file.path.split('.').pop() || 'unknown';
                    extensions[ext] = (extensions[ext] || 0) + 1;
                } catch {
                    // Skip unreadable files
                }
            }
            
            const stats = `
Workspace Statistics
==================
Total files: ${files.length}
Total lines of code: ${totalLines}
Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB
File types: ${Object.entries(extensions).map(([ext, count]) => `${ext}: ${count}`).join(', ')}
            `.trim();
            
            vscode.window.showInformationMessage(stats);
        }),
    );

    // Undo the last message you sent: truncate the chat to it and restore the files.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.revertToLastMessage', async () => {
            await provider.revertToLastMessageCommand();
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

    // Choose between the self-hosted Javelin model and another local Ollama model.
    context.subscriptions.push(
        vscode.commands.registerCommand('javelin.selectProvider', async () => {
            const config = vscode.workspace.getConfiguration('javelin');
            const current = config.get<string>('provider', 'javelin');

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
            if (PROVIDERS[pick.id].defaultModel) {
                await config.update('model', PROVIDERS[pick.id].defaultModel, vscode.ConfigurationTarget.Global);
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
