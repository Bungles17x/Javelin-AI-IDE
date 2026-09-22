//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import * as vscode from 'vscode';
import { streamCompletion, getProvider, DEFAULT_PROVIDER } from './providers';

const SECRET_KEY = 'javelin.groqApiKey';
const MAX_HISTORY_MESSAGES = 20;

/** Resolve the configured provider from settings, defaulting to keyless local. */
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

/**
 * Resolve the API key, preferring the encrypted SecretStorage over the plain
 * settings value (which we keep for backwards compatibility).
 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<string> {
    const fromSecrets = await context.secrets.get(SECRET_KEY);
    if (fromSecrets) {
        return fromSecrets;
    }
    const fromSettings = vscode.workspace.getConfiguration('javelin').get<string>('groqApiKey', '');
    return fromSettings.trim();
}

export async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed) {
        await context.secrets.store(SECRET_KEY, trimmed);
    } else {
        await context.secrets.delete(SECRET_KEY);
    }
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

async function requireApiKey(context: vscode.ExtensionContext): Promise<string> {
    const apiKey = await getApiKey(context);
    if (!apiKey) {
        const action = await vscode.window.showErrorMessage('Javelin AI: no Groq API key set.', 'Set API Key');
        if (action === 'Set API Key') {
            await vscode.commands.executeCommand('javelin.setApiKey');
        }
        throw new Error('Groq API key not configured. Get a free key at https://console.groq.com/keys');
    }
    return apiKey;
}

/**
 * Stream a completion from Groq. `onToken` is called for each text delta; the
 * full response text is returned at the end.
 */
export async function generateCodeStreaming(
    context: vscode.ExtensionContext,
    prompt: string,
    conversationHistory: ChatMessage[] = [],
    onToken: (delta: string) => void,
    token?: vscode.CancellationToken,
    extraContext?: string,
): Promise<string> {
    const { provider, baseUrl, model } = currentProvider();
    const apiKey = provider.requiresKey ? await requireApiKey(context) : undefined;

    const abort = new AbortController();
    token?.onCancellationRequested(() => abort.abort());

    try {
        const result = await streamCompletion({
            providerId: provider.id,
            baseUrl,
            apiKey,
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
