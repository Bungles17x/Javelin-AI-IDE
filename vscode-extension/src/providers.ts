/**
 * Provider layer for the VS Code extension.
 *
 * Mirrors src/lib/providers.js in the web app: any OpenAI-compatible endpoint,
 * defaulting to a keyless local runtime (Ollama). Local keeps code on the machine
 * and needs no key; cloud providers are opt-in.
 */

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

export interface ProviderModel {
    id: string;
    label: string;
}

export interface Provider {
    id: 'javelin' | 'local' | 'groq' | 'custom';
    label: string;
    baseUrl: string;
    requiresKey: boolean;
    models: ProviderModel[];
    defaultModel: string;
    help: string;
    /**
     * True when this provider serves Javelin-trained weights rather than a stock
     * model. Used to surface the right guidance (e.g. "train one first") instead of
     * treating it like an ordinary local endpoint.
     */
    isJavelinModel?: boolean;
}

export const PROVIDERS: Record<string, Provider> = {
    /**
     * Javelin's own model: a fine-tuned adapter served locally by Ollama (or any
     * OpenAI-compatible server). Keyless, like the plain local provider, but it
     * points at the trained weights instead of a stock model.
     *
     * Nothing in the runtime changes for this — Javelin Core already treats any
     * endpoint as a swappable engine, so selecting this provider is all that is
     * needed to use a trained model.
     */
    javelin: {
        id: 'javelin',
        label: 'Javelin (self-hosted)',
        baseUrl: 'http://localhost:8080/v1',
        requiresKey: false,
        isJavelinModel: true,
        models: [
            { id: 'javelin', label: 'Javelin (your model)' },
            { id: 'javelin-coder-80b', label: 'Javelin Coder 80B (flagship)' },
        ],
        defaultModel: 'javelin',
        help:
            'Serves YOUR model with Javelin\'s own server — no Ollama. Start it with ' +
            '`npm run serve:model`, then select this provider. Train and merge your model ' +
            'first (run `npm run models` to see whether it exists). See docs/TRAINING.md.',
    },
    local: {
        id: 'local',
        label: 'Local (keyless)',
        baseUrl: 'http://localhost:11434/v1',
        requiresKey: false,
        models: [
            { id: 'javelin-coder', label: 'Javelin Coder (local, built here)' },
            { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B' },
            { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B' },
            { id: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B' },
            { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
            { id: 'codellama:13b', label: 'Code Llama 13B' },
        ],
        defaultModel: 'javelin-coder',
        help:
            'Runs locally, no API key, code never leaves your machine. Build your own ' +
            'Javelin model once with `npm run model:local` (creates `javelin-coder`), ' +
            'then select it here. Or pull a stock model: `ollama pull qwen2.5-coder:7b`.',
    },
    groq: {
        id: 'groq',
        label: 'Groq (cloud, key required)',
        baseUrl: 'https://api.groq.com/openai/v1',
        requiresKey: true,
        models: [
            { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
            { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (fast)' },
            { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
            { id: 'qwen/qwen3-32b', label: 'Qwen3 32B' },
        ],
        defaultModel: 'llama-3.3-70b-versatile',
        help: 'Get a free key at https://console.groq.com/keys',
    },
    custom: {
        id: 'custom',
        label: 'Custom OpenAI-compatible',
        baseUrl: '',
        requiresKey: false,
        models: [],
        defaultModel: '',
        help: 'Any /v1 endpoint, including a self-hosted model.',
    },
};

export const DEFAULT_PROVIDER = 'local';

export function getProvider(id: string): Provider {
    return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER];
}

export interface ToolCall {
    id: string;
    name: string;
    args: any;
}

export interface StreamResult {
    content: string;
    toolCalls: ToolCall[];
    finishReason: string;
}

export interface StreamOptions {
    providerId?: string;
    baseUrl?: string;
    apiKey?: string;
    model: string;
    messages: any[];
    tools?: any[];
    onToken?: (delta: string) => void;
    signal?: AbortSignal;
    temperature?: number;
}

/**
 * Stream a chat completion in OpenAI format, accumulating tool calls.
 * Tool-call arguments arrive as partial JSON fragments, so they are buffered and
 * parsed once the stream ends.
 */
export async function streamCompletion(opts: StreamOptions): Promise<StreamResult> {
    const provider = getProvider(opts.providerId ?? DEFAULT_PROVIDER);
    const base = (opts.baseUrl || provider.baseUrl || '').replace(/\/$/, '');
    if (!base.startsWith('http')) {
        throw new Error(`No endpoint configured for provider "${provider.id}". ${provider.help}`);
    }
    if (provider.requiresKey && !opts.apiKey) {
        throw new Error(`Provider "${provider.label}" needs an API key. ${provider.help}`);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`;
    }

    const body: any = {
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        stream: true,
    };
    if (opts.tools?.length) {
        body.tools = opts.tools;
        body.tool_choice = 'auto';
    }

    let response: Response;
    try {
        response = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: opts.signal,
        });
    } catch (error: any) {
        if (error?.name === 'AbortError') {
            throw error;
        }
        if (provider.id === 'local') {
            throw new Error(
                `Could not reach the local model at ${base}. Is Ollama running? ${provider.help}`,
            );
        }
        throw new Error(`Could not reach ${base}: ${error.message}`);
    }

    if (!response.ok || !response.body) {
        const errorText = await response.text().catch(() => '');
        if (response.status === 401) {
            throw new Error('Invalid API key (401). Run "Javelin AI: Set API Key" to update it.');
        }
        if (response.status === 404) {
            throw new Error(`Model "${opts.model}" not found (404). ${provider.help}`);
        }
        if (response.status === 429) {
            throw new Error('Rate limited (429). Wait a moment or switch to a local model.');
        }
        throw new Error(`Provider error ${response.status}: ${errorText}`);
    }

    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = 'stop';
    const rawCalls: { id: string; name: string; argsRaw: string }[] = [];

    try {
        for (; ;) {
            if (opts.signal?.aborted) {
                break;
            }
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const raw of lines) {
                const line = raw.trim();
                if (!line.startsWith('data:')) {
                    continue;
                }
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') {
                    continue;
                }
                let json: any;
                try {
                    json = JSON.parse(payload);
                } catch {
                    continue;
                }
                const choice = json.choices?.[0];
                if (!choice) {
                    continue;
                }
                if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                }
                const delta = choice.delta ?? {};
                if (delta.content) {
                    content += delta.content;
                    opts.onToken?.(delta.content);
                }
                for (const tc of delta.tool_calls ?? []) {
                    const index = tc.index ?? 0;
                    if (!rawCalls[index]) {
                        rawCalls[index] = { id: '', name: '', argsRaw: '' };
                    }
                    const call = rawCalls[index];
                    if (tc.id) {
                        call.id = tc.id;
                    }
                    if (tc.function?.name) {
                        call.name = tc.function.name;
                    }
                    if (tc.function?.arguments) {
                        call.argsRaw += tc.function.arguments;
                    }
                }
            }
        }
    } finally {
        reader.releaseLock?.();
    }

    const toolCalls: ToolCall[] = [];
    for (const call of rawCalls) {
        if (!call?.name) {
            continue;
        }
        let args: any = {};
        if (call.argsRaw) {
            try {
                args = JSON.parse(call.argsRaw);
            } catch {
                args = { __raw: call.argsRaw, __parseError: true };
            }
        }
        toolCalls.push({ id: call.id || `call_${toolCalls.length}`, name: call.name, args });
    }

    // Fallback for local models (e.g. qwen2.5-coder via Ollama) that emit a tool call
    // as fenced text instead of populating delta.tool_calls. Without this the agent
    // sees prose and never acts.
    if (toolCalls.length === 0 && content) {
        const salvaged = salvageToolCallFromText(content);
        if (salvaged) {
            toolCalls.push(salvaged);
            return { content: '', toolCalls, finishReason };
        }
    }

    return { content, toolCalls, finishReason };
}

/**
 * Recover a single tool call that a model emitted as text.
 * Handles a <tool_call>…</tool_call> block, a ```json fenced object, or a bare JSON
 * object naming a tool. Returns null if nothing tool-shaped is found — it never
 * invents a call that is not there.
 */
export function salvageToolCallFromText(text: string): ToolCall | null {
    if (!text || typeof text !== 'string') {
        return null;
    }
    const candidates: string[] = [];
    const tagged = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
    if (tagged) {
        candidates.push(tagged[1]);
    }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        candidates.push(fenced[1]);
    }
    const braced = text.match(/\{[\s\S]*\}/);
    if (braced) {
        candidates.push(braced[0]);
    }
    for (const raw of candidates) {
        let obj: any;
        try {
            obj = JSON.parse(raw.trim());
        } catch {
            continue;
        }
        const fn = obj?.function ?? obj;
        const name = fn?.name ?? fn?.tool;
        if (typeof name !== 'string' || !name) {
            continue;
        }
        let args: any = fn?.arguments ?? fn?.parameters ?? {};
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch {
                args = { __raw: args, __parseError: true };
            }
        }
        return { id: `salvaged_${name}_${Date.now()}`, name, args };
    }
    return null;
}
