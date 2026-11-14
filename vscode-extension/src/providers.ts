/**
 * Provider layer for the VS Code extension.
 *
 * The default Javelin provider uses the locally hosted Javelin model through
 * Ollama. No cloud API or API key is required.
 */

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import { canonicalizeToolCall } from './core/tools';

export interface ProviderModel {
    id: string;
    label: string;
}

export interface Provider {
    id: 'javelin' | 'local' | 'groq' | 'openai' | 'anthropic' | 'together' | 'replicate' | 'anyscale' | 'openrouter' | 'custom';
    label: string;
    baseUrl: string;
    requiresKey: boolean;
    models: ProviderModel[];
    defaultModel: string;
    help: string;
    /**
     * True when this provider serves the Javelin model rather than another local
     * Ollama model.
     */
    isJavelinModel?: boolean;
}

export const PROVIDERS: Record<string, Provider> = {
    /**
     * Javelin's own model served by the local Ollama runtime.
     *
     * Nothing in the runtime changes for this — Javelin Core already treats any
     * endpoint as a swappable engine, so selecting this provider is all that is
     * needed to use a trained model.
     */
    javelin: {
        id: 'javelin',
        label: 'Javelin (self-hosted)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        requiresKey: false,
        isJavelinModel: true,
        models: [
            { id: 'javelin-coder:latest', label: 'Javelin Coder (your local model)' },
        ],
        defaultModel: 'javelin-coder:latest',
        help:
            'Uses your Javelin model through Ollama running on this machine. No cloud API or API key is used. ' +
            'Ollama starts automatically when needed; install the model using the instructions supplied with its distribution.',
    },
    local: {
        id: 'local',
        label: 'Local (keyless)',
        baseUrl: 'http://localhost:11434/v1',
        requiresKey: false,
        models: [
            { id: 'javelin-coder:latest', label: 'Javelin Coder (local)' },
            { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B' },
            { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B' },
            { id: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B' },
            { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
            { id: 'codellama:13b', label: 'Code Llama 13B' },
        ],
        defaultModel: 'qwen2.5-coder:7b',
        help:
            'Runs inference through Ollama on this machine; prompts and project files stay local. ' +
            'The extension starts Ollama when needed. Install a model only if it is missing, for example ' +
            '`ollama pull qwen2.5-coder:7b`, then choose an installed model.',
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
    openai: {
        id: 'openai',
        label: 'OpenAI (cloud, key required)',
        baseUrl: 'https://api.openai.com/v1',
        requiresKey: true,
        models: [
            { id: 'gpt-4o', label: 'GPT-4o' },
            { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
            { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
            { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
        ],
        defaultModel: 'gpt-4o',
        help: 'Get an API key at https://platform.openai.com/api-keys',
    },
    anthropic: {
        id: 'anthropic',
        label: 'Anthropic Claude (cloud, key required)',
        baseUrl: 'https://api.anthropic.com/v1',
        requiresKey: true,
        models: [
            { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
            { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
            { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
        ],
        defaultModel: 'claude-sonnet-4-20250514',
        help: 'Get an API key at https://console.anthropic.com/',
    },
    together: {
        id: 'together',
        label: 'Together AI (cloud, key required)',
        baseUrl: 'https://api.together.xyz/v1',
        requiresKey: true,
        models: [
            { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B (Coding)' },
            { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen2.5 Coder 32B' },
            { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen2.5 72B' },
            { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', label: 'Llama 3.1 70B' },
            { id: 'deepseek-ai/DeepSeek-Coder-V2-Instruct', label: 'DeepSeek Coder V2' },
        ],
        defaultModel: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        help: 'Get an API key at https://api.together.xyz/. Supports custom fine-tuned models.',
    },
    replicate: {
        id: 'replicate',
        label: 'Replicate (cloud, key required)',
        baseUrl: 'https://api.replicate.com/v1',
        requiresKey: true,
        models: [
            { id: 'meta/codellama-34b-instruct', label: 'CodeLlama 34B' },
            { id: 'mistralai/mistral-7b-instruct-v0.2', label: 'Mistral 7B' },
            { id: 'meta/llama-2-70b-chat', label: 'Llama 2 70B' },
            { id: 'snowflake/snowflake-arctic-instruct', label: 'Arctic Instruct' },
        ],
        defaultModel: 'meta/codellama-34b-instruct',
        help: 'Get an API key at https://replicate.com/account/api-tokens. Supports custom fine-tuned models.',
    },
    anyscale: {
        id: 'anyscale',
        label: 'Anyscale (cloud, key required)',
        baseUrl: 'https://api.endpoints.anyscale.com/v1',
        requiresKey: true,
        models: [
            { id: 'mistralai/Mistral-7B-Instruct-v0.2', label: 'Mistral 7B' },
            { id: 'meta-llama/Llama-2-70b-chat-hf', label: 'Llama 2 70B' },
            { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B' },
        ],
        defaultModel: 'mistralai/Mistral-7B-Instruct-v0.2',
        help: 'Get an API key at https://console.anyscale.com/. Supports custom fine-tuned models.',
    },
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter (cloud, key required)',
        baseUrl: 'https://openrouter.ai/api/v1',
        requiresKey: true,
        models: [
            { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
            { id: 'openai/gpt-4o', label: 'GPT-4o' },
            { id: 'google/gemini-pro-1.5', label: 'Gemini Pro 1.5' },
            { id: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B' },
        ],
        defaultModel: 'anthropic/claude-sonnet-4',
        help: 'Get an API key at https://openrouter.ai/keys',
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

export const DEFAULT_PROVIDER = 'javelin';

export function isLocalOllamaEndpoint(baseUrl: string): boolean {
    try {
        const endpoint = new URL(baseUrl);
        return endpoint.protocol === 'http:' &&
            (endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]') &&
            endpoint.port === '11434';
    } catch {
        return false;
    }
}

export function getProvider(id: string): Provider {
    return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER];
}

export interface ProviderProbeResult {
    ok: boolean;
    detail: string;
    available: string[];
}

export async function probeProviderModel(opts: {
    providerId?: string;
    baseUrl?: string;
    model: string;
    apiKey?: string;
    signal?: AbortSignal;
}): Promise<ProviderProbeResult> {
    const provider = getProvider(opts.providerId ?? DEFAULT_PROVIDER);
    const base = (opts.baseUrl || provider.baseUrl || '').replace(/\/$/, '');
    if (provider.id !== 'javelin' && provider.id !== 'local') {
        return {
            ok: false,
            detail: 'Only self-hosted Javelin and local Ollama providers are enabled.',
            available: [],
        };
    }
    if (!isLocalOllamaEndpoint(base)) {
        return {
            ok: false,
            detail: 'Javelin only connects to the local Ollama runtime on port 11434.',
            available: [],
        };
    }
    if (!base.startsWith('http')) {
        return {
            ok: false,
            detail: `No endpoint configured for provider "${provider.id}". ${provider.help}`,
            available: [],
        };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const timeout = opts.signal ?? AbortSignal.timeout(4000);
    try {
        const response = await fetch(`${base}/models`, {
            method: 'GET',
            headers,
            signal: timeout,
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            const status = response.status || 'unknown';
            return {
                ok: false,
                detail: `Model check failed (${status}): ${errorText || 'no response from the model server'}. ${provider.help}`,
                available: [],
            };
        }

        const data: any = await response.json();
        const available = ((Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []) as any[])
            .map((entry) => typeof entry === 'string' ? entry : entry?.id || entry?.name)
            .filter((id): id is string => Boolean(id));

        if (!available.length) {
            return {
                ok: false,
                detail: `No models were reported by ${base}. ${provider.help}`,
                available: [],
            };
        }

        const hasModel = available.some((id) => id === opts.model || id.startsWith(`${opts.model}:`));
        if (!hasModel) {
            return {
                ok: false,
                detail: `Model "${opts.model}" is not served yet. Available: ${available.join(', ') || 'none'}. ${provider.help}`,
                available,
            };
        }

        return {
            ok: true,
            detail: `Model "${opts.model}" is available.`,
            available,
        };
    } catch (error: any) {
        const fallbackMessage = provider.id === 'local'
            ? `Could not connect to Ollama at ${base} after attempting local startup. Check that Ollama is installed and retry. ${provider.help}`
            : `Could not reach ${base}: ${error?.message || 'unknown error'}`;
        return {
            ok: false,
            detail: fallbackMessage,
            available: [],
        };
    }
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

function _toAnthropicMessages(messages: any[]): { system?: string; messages: any[] } {
    const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content ?? ''))
        .filter(Boolean)
        .join('\n\n');
    const converted: any[] = [];

    for (const message of messages) {
        if (message.role === 'system') {
            continue;
        }
        if (message.role === 'tool') {
            const result = {
                type: 'tool_result',
                tool_use_id: message.tool_call_id,
                content: String(message.content ?? ''),
            };
            const previous = converted[converted.length - 1];
            if (previous?.role === 'user' && Array.isArray(previous.content)) {
                previous.content.push(result);
            } else {
                converted.push({ role: 'user', content: [result] });
            }
            continue;
        }

        const content: any[] = [];
        if (message.content) {
            content.push({ type: 'text', text: String(message.content) });
        }
        for (const call of message.tool_calls ?? []) {
            let input: any = {};
            try {
                input = typeof call.function?.arguments === 'string'
                    ? JSON.parse(call.function.arguments)
                    : call.function?.arguments ?? {};
            } catch {
                input = {};
            }
            content.push({
                type: 'tool_use',
                id: call.id,
                name: call.function?.name,
                input,
            });
        }
        converted.push({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: content.length ? content : String(message.content ?? ''),
        });
    }

    return { system: system || undefined, messages: converted };
}

async function _readAnthropicStream(response: Response, opts: StreamOptions): Promise<StreamResult> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = 'stop';
    const rawCalls: { id: string; name: string; argsRaw: string }[] = [];

    const processEvent = (raw: string) => {
        const data = raw
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
        if (!data || data === '[DONE]') {
            return;
        }
        let event: any;
        try {
            event = JSON.parse(data);
        } catch {
            return;
        }

        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            const call = rawCalls[event.index] ?? { id: '', name: '', argsRaw: '' };
            call.id = event.content_block.id ?? call.id;
            call.name = event.content_block.name ?? call.name;
            const initialInput = event.content_block.input;
            if (initialInput && Object.keys(initialInput).length && !call.argsRaw) {
                call.argsRaw = JSON.stringify(initialInput);
            }
            rawCalls[event.index] = call;
        } else if (event.type === 'content_block_delta') {
            const delta = event.delta ?? {};
            if (delta.type === 'text_delta' && delta.text) {
                content += delta.text;
                opts.onToken?.(delta.text);
            } else if (delta.type === 'input_json_delta') {
                const call = rawCalls[event.index] ?? { id: '', name: '', argsRaw: '' };
                call.argsRaw += delta.partial_json ?? '';
                rawCalls[event.index] = call;
            }
        } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
            finishReason = event.delta.stop_reason;
        }
    };

    try {
        for (;;) {
            if (opts.signal?.aborted) {
                break;
            }
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() ?? '';
            for (const event of events) {
                processEvent(event);
            }
        }
        if (buffer.trim()) {
            processEvent(buffer);
        }
    } finally {
        reader.releaseLock();
    }

    const toolCalls = rawCalls.flatMap((call, index) => {
        if (!call?.name) {
            return [];
        }
        let args: any = {};
        try {
            args = call.argsRaw ? JSON.parse(call.argsRaw) : {};
        } catch {
            args = { __raw: call.argsRaw, __parseError: true };
        }
        return [{ id: call.id || `call_${index}`, name: call.name, args }];
    });
    return { content, toolCalls, finishReason };
}

/**
 * Stream a chat completion in OpenAI format, accumulating tool calls.
 * Tool-call arguments arrive as partial JSON fragments, so they are buffered and
 * parsed once the stream ends.
 */
export async function streamCompletion(opts: StreamOptions): Promise<StreamResult> {
    const provider = getProvider(opts.providerId ?? DEFAULT_PROVIDER);
    const base = (opts.baseUrl || provider.baseUrl || '').replace(/\/$/, '');
    if (provider.id !== 'javelin' && provider.id !== 'local') {
        throw new Error('Only self-hosted Javelin and local Ollama providers are enabled.');
    }
    if (!isLocalOllamaEndpoint(base)) {
        throw new Error('Javelin only connects to the local Ollama runtime on port 11434.');
    }
    if (!base.startsWith('http')) {
        throw new Error(`No endpoint configured for provider "${provider.id}". ${provider.help}`);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const url = `${base}/chat/completions`;
    const body: any = {
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        // Some servers default to a few hundred output tokens, which truncates any
        // file worth writing.
        max_tokens: 8192,
        stream: true,
    };
    if (opts.tools?.length) {
        body.tools = opts.tools;
        body.tool_choice = 'auto';
    }

    let response: Response;
    try {
        response = await fetch(url, {
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
                `Could not connect to Ollama at ${base}. The extension attempts to start it automatically; check the Ollama installation and retry. ${provider.help}`,
            );
        }
        throw new Error(`Could not reach ${base}: ${error.message}`);
    }

    if (!response.ok || !response.body) {
        const errorText = await response.text().catch(() => '');
        if (response.status === 404) {
            throw new Error(`Model "${opts.model}" not found (404). ${provider.help}`);
        }
        if (response.status === 429) {
            throw new Error('Rate limited (429). Wait a moment or switch to a local model.');
        }
        throw new Error(`Provider error ${response.status}: ${errorText}`);
    }

    const reader = response.body.getReader();
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

    // Fallback for local models that emit tool calls in prose instead of the
    // structured channel. Some label code fences `jsonCopy` and repeat the JSON.
    if (toolCalls.length === 0 && content) {
        const salvaged = salvageToolCallsFromText(content);
        if (salvaged.length) {
            toolCalls.push(...salvaged);
            return { content: '', toolCalls, finishReason };
        }
    }

    return { content, toolCalls, finishReason };
}

/**
 * Recover recognized tool calls embedded in model text without interpreting
 * arbitrary code or prose as executable actions.
 */
export function salvageToolCallFromText(text: string): ToolCall | null {
    return salvageToolCallsFromText(text)[0] ?? null;
}

export function salvageToolCallsFromText(text: string): ToolCall[] {
    if (!text || typeof text !== 'string') {
        return [];
    }
    const knownTools = new Set([
        'list_files', 'read_file', 'search_code', 'write_file', 'create_file', 'edit_file',
        'delete_file', 'create_folder', 'run_command', 'create_checkpoint', 'finish',
    ]);
    const requiredArguments: Record<string, string[]> = {
        read_file: ['path'],
        search_code: ['query'],
        write_file: ['path', 'content'],
        create_file: ['path', 'content'],
        edit_file: ['path', 'old_string', 'new_string'],
        delete_file: ['path'],
        create_folder: ['path'],
        run_command: ['command'],
        create_checkpoint: ['label'],
        finish: ['summary'],
    };
    const calls: { call: ToolCall; position: number }[] = [];
    const seen = new Set<string>();
    for (const raw of extractBalancedJsonObjects(text)) {
        let obj: any;
        try {
            obj = JSON.parse(raw);
        } catch {
            continue;
        }
        const fn = obj?.function ?? obj?.tool_call ?? obj;
        const rawName = fn?.name ?? fn?.tool;
        if (typeof rawName !== 'string') {
            continue;
        }
        const name = canonicalizeToolCall({ name: rawName }).name;
        if (!knownTools.has(name)) {
            continue;
        }
        let args: any = fn?.arguments ?? fn?.parameters ?? fn?.args ?? {};
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch {
                continue;
            }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            continue;
        }
        if ((requiredArguments[name] ?? []).some((key) => !(key in args))) {
            continue;
        }
        const signature = JSON.stringify([name, args]);
        if (seen.has(signature)) {
            continue;
        }
        seen.add(signature);
        calls.push({
            position: text.indexOf(raw),
            call: { id: `salvaged_${name}_${calls.length}`, name, args },
        });
    }

    for (const fileCall of salvageExplicitNewFile(text)) {
        const signature = JSON.stringify([fileCall.call.name, fileCall.call.args]);
        if (seen.has(signature)) {
            continue;
        }
        seen.add(signature);
        calls.push(fileCall);
    }

    return calls.sort((a, b) => a.position - b.position).map(({ call }) => call);
}

function salvageExplicitNewFile(text: string): { call: ToolCall; position: number }[] {
    const calls: { call: ToolCall; position: number }[] = [];
    const declaration = /\bcreate\s+a\s+new\s+file\s+[`'"]?([^`'"\s:]+)[`'"]?\s+inside\s+(?:the\s+)?[`'"]?([^`'".:]+)[`'"]?\s+folder\b/gi;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(text)) !== null) {
        const fileName = match[1];
        const directory = match[2].replace(/[\\/]+$/, '');
        const path = `${directory}/${fileName}`.replace(/\\/g, '/');
        if (path.startsWith('/') || path.split('/').includes('..')) {
            continue;
        }

        const fence = /```[^\r\n`]*\r?\n([\s\S]*?)```/g;
        fence.lastIndex = declaration.lastIndex;
        let block: RegExpExecArray | null;
        let selected: { code: string; position: number } | undefined;
        while ((block = fence.exec(text)) !== null) {
            const code = block[1].trim();
            if (!code) {
                continue;
            }
            try {
                const parsed = JSON.parse(code);
                if (parsed && (parsed.name || parsed.function?.name || parsed.tool)) {
                    continue;
                }
            } catch {
                // Source code is normally not JSON.
            }

            const declaredPath = code.match(/^\s*(?:\/\/|#)\s*([^\r\n]+\.[\w.-]+)\s*$/m)?.[1]?.trim();
            if (declaredPath && declaredPath.replace(/\\/g, '/') !== path) {
                continue;
            }
            selected = { code: `${code}\n`, position: block.index };
            break;
        }
        if (!selected) {
            continue;
        }
        calls.push({
            position: selected.position,
            call: {
                id: `salvaged_write_file_${calls.length}`,
                name: 'write_file',
                args: { path, content: selected.code },
            },
        });
    }

    const mentionedPath = /\b(?:write|create|save|add|generate|implement|put)\b[^.\r\n]{0,180}?\b(?:in|to|at|as)\s+[`'"]?((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+)[`'"]?/gi;
    while ((match = mentionedPath.exec(text)) !== null) {
        const path = match[1].replace(/\\/g, '/');
        if (path.startsWith('/') || path.split('/').includes('..')) {
            continue;
        }

        const fence = /```[^\r\n`]*\r?\n([\s\S]*?)```/g;
        let block: RegExpExecArray | null;
        let selected: { code: string; position: number } | undefined;
        while ((block = fence.exec(text)) !== null) {
            const code = block[1].trim();
            if (!code) {
                continue;
            }
            try {
                const parsed = JSON.parse(code);
                if (parsed && (parsed.name || parsed.function?.name || parsed.tool)) {
                    continue;
                }
            } catch {
                // Source code is normally not JSON.
            }

            const declaredPath = code.match(/^\s*(?:\/\/|#|<!--)\s*([^\r\n>]+\.[\w.-]+)\s*(?:-->)?\s*$/m)?.[1]?.trim();
            if (declaredPath?.replace(/\\/g, '/') !== path) {
                continue;
            }
            selected = { code: `${code}\n`, position: block.index };
            break;
        }
        if (!selected) {
            continue;
        }

        calls.push({
            call: {
                id: `salvaged_write_file_${calls.length}`,
                name: 'write_file',
                args: { path, content: selected.code },
            },
            position: selected.position,
        });
    }

    const codeFence = /```[^\r\n`]*\r?\n([\s\S]*?)```/g;
    let block: RegExpExecArray | null;
    while ((block = codeFence.exec(text)) !== null) {
      const code = block[1].trim();
      if (!code) {
        continue;
      }

      const declaration = text.slice(0, block.index).split(/```/).pop() ?? '';
      const explicitlyCreatesFile =
        /\b(?:create|write|save|add|generate|implement|build)\b[^.!?\r\n]{0,180}\b(?:file|script|module|component|page|game|program)\b/i.test(declaration) ||
        /\b(?:let['’]s|let us)\s+(?:call|name)\s+(?:it|this)\s+[`'"]?(?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+[`'"]?/i.test(declaration);
      if (!explicitlyCreatesFile) {
        continue;
      }

      const headerPath =
        code.match(/^\s*(?:\/\/|#)\s*((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+)\s*$/m)?.[1] ??
        code.match(/^\s*<!--\s*((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+)\s*-->\s*$/m)?.[1];
      if (!headerPath) {
        continue;
      }
      const path = headerPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..')) {
        continue;
      }
      try {
        const parsed = JSON.parse(code);
        if (parsed && (parsed.name || parsed.function?.name || parsed.tool)) {
          continue;
        }
      } catch {
        // Source code is normally not JSON.
      }

      calls.push({
        position: block.index,
        call: {
          id: `salvaged_write_file_${calls.length}`,
          name: 'write_file',
          args: { path, content: `${code}\n` },
        },
      });
    }
    return calls;
}

function extractBalancedJsonObjects(text: string): string[] {
    const objects: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"' && depth > 0) {
            inString = true;
        } else if (char === '{') {
            if (depth === 0) {
                start = index;
            }
            depth += 1;
        } else if (char === '}' && depth > 0) {
            depth -= 1;
            if (depth === 0) {
                objects.push(text.slice(start, index + 1));
                if (objects.length >= 100) {
                    break;
                }
            }
        }
    }
    return objects;
}
