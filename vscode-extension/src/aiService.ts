//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { streamCompletion, getProvider, DEFAULT_PROVIDER, isLocalOllamaEndpoint, probeProviderModel } from './providers';

const MAX_HISTORY_MESSAGES = 20;

export function findOllamaExecutable(): string {
    const candidates = [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'),
    ].filter((candidate): candidate is string => Boolean(candidate));
    return candidates.find((candidate) => existsSync(candidate)) ?? 'ollama';
}

/** Start the local Ollama daemon on demand; never starts or redirects to a cloud provider. */
export async function ensureLocalOllama(baseUrl: string): Promise<void> {
    if (!isLocalOllamaEndpoint(baseUrl)) {
        return;
    }

    const modelsUrl = `${baseUrl.replace(/\/$/, '')}/models`;
    const isReady = async (): Promise<boolean> => {
        try {
            const response = await fetch(modelsUrl, { signal: AbortSignal.timeout(1000) });
            return response.ok;
        } catch {
            return false;
        }
    };
    if (await isReady()) {
        return;
    }

    const child = spawn(findOllamaExecutable(), ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    let launchError: Error | undefined;
    child.once('error', (error) => {
        launchError = error;
    });
    child.unref();

    for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (await isReady()) {
            return;
        }
        if (launchError) {
            throw new Error(`Could not start Ollama: ${launchError.message}. Install Ollama and try again.`);
        }
    }

    throw new Error('Ollama did not start on port 11434. Install Ollama or start it with `ollama serve`, then retry.');
}

/** Resolve the configured provider from settings, defaulting to the self-hosted Javelin model. */
function currentProvider() {
    const config = vscode.workspace.getConfiguration('javelin');
    const id = config.get<string>('provider', DEFAULT_PROVIDER);
    const provider = getProvider(id);
    const baseUrl = config.get<string>('baseUrl', '') || provider.baseUrl;
    const model = config.get<string>('model', provider.defaultModel) || provider.defaultModel;
    return { provider, baseUrl, model };
}

export const SYSTEM_PROMPT = `You are Javelin AI, an expert coding assistant embedded in VS Code.
- Be concise, direct, and technically accurate. Prefer correctness over agreement.
- Answer in GitHub-flavored Markdown, always fencing code with a language tag.
- Follow the conventions of the workspace you are editing: match its style, libraries and patterns.
- Never assume a dependency is available; check that the project already uses it.
- When a request is ambiguous, state your assumption briefly and proceed.
- Do not pad answers with unnecessary prose.`;

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

function buildMessages(prompt: string, conversationHistory: ChatMessage[], extraContext?: string): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    messages.push(...conversationHistory.slice(-MAX_HISTORY_MESSAGES));
    messages.push({
        role: 'user',
        content: extraContext ? `${prompt}\n\n---\nSelected code from the editor:\n\n${extraContext}` : prompt,
    });
    return messages;
}

/**
 * Stream a completion from the self-hosted model. `onToken` receives each delta.
 */
export async function generateCodeStreaming(
    _context: vscode.ExtensionContext,
    prompt: string,
    conversationHistory: ChatMessage[] = [],
    onToken: (delta: string) => void,
    token?: vscode.CancellationToken,
    extraContext?: string,
): Promise<string> {
    const { provider, baseUrl, model } = currentProvider();
    if (provider.id !== 'javelin' && provider.id !== 'local') {
        throw new Error('Only self-hosted Javelin and local Ollama providers are enabled. Select one in Javelin settings.');
    }
    if (!isLocalOllamaEndpoint(baseUrl)) {
        throw new Error('Javelin only connects to the local Ollama runtime at 127.0.0.1:11434. Check the Javelin endpoint setting.');
    }
    await ensureLocalOllama(baseUrl);
    const probe = await probeProviderModel({ providerId: provider.id, baseUrl, model });
    if (!probe.ok) {
        throw new Error(probe.detail);
    }

    const abort = new AbortController();
    token?.onCancellationRequested(() => abort.abort());

    try {
        const result = await streamCompletion({
            providerId: provider.id,
            baseUrl,
            model,
            messages: buildMessages(prompt, conversationHistory, extraContext),
            temperature: 0.4,
            signal: abort.signal,
            onToken,
        });
        return result.content || '_(no response)_';
    } catch (error: any) {
        if (abort.signal.aborted) {
            return '_(stopped)_';
        }
        throw error;
    }
}

export function getErrorMessage(error: any): string {
    if (error && typeof error.message === 'string') {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return 'An unknown error occurred';
}
