/**
 * Javelin Core for VS Code — engine layer.
 *
 * Mirrors src/core/engines.js. Javelin owns its reasoning lifecycle; engines
 * supply the raw language ability and can be swapped, chained, or degraded.
 */

import { streamCompletion } from '../providers';

export const CAPABILITY = {
    TOOLS: 'tools',
    LONG_CONTEXT: 'long-context',
    STRONG_REASONING: 'strong-reasoning',
    FAST: 'fast',
    OFFLINE: 'offline',
} as const;

export interface EngineRequest {
    messages: any[];
    tools?: any[];
    signal?: AbortSignal;
    onToken?: (delta: string) => void;
    temperature?: number;
}

export interface EngineResponse {
    text: string;
    toolCalls: { id: string; name: string; args: any }[];
    finishReason: string;
    engineId: string;
}

export interface EngineDescriptor {
    id: string;
    label: string;
    capabilities: string[];
    probe(): Promise<{ ok: boolean; detail?: string }>;
    generate(req: EngineRequest): Promise<EngineResponse>;
}

/** Adapt a Javelin provider into a Javelin engine. */
export function providerEngine(
    provider: { id: string; label: string; baseUrl: string; apiKey?: string; defaultModel: string },
    opts: { id?: string; label?: string; capabilities?: string[]; model?: string } = {},
): EngineDescriptor {
    const id = opts.id ?? provider.id;
    return {
        id,
        label: opts.label ?? provider.label,
        capabilities: opts.capabilities ?? [],
        async probe() {
            try {
                const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
                    signal: AbortSignal.timeout(1500),
                });
                return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
            } catch (error: any) {
                return { ok: false, detail: error.message };
            }
        },
        async generate(req: EngineRequest) {
            const result = await streamCompletion({
                providerId: provider.id,
                baseUrl: provider.baseUrl,
                apiKey: provider.apiKey,
                model: opts.model ?? provider.defaultModel,
                messages: req.messages,
                tools: req.tools,
                signal: req.signal,
                temperature: req.temperature,
                onToken: req.onToken,
            });
            return {
                text: result.content ?? '',
                toolCalls: result.toolCalls ?? [],
                finishReason: result.finishReason ?? 'stop',
                engineId: id,
            };
        },
    };
}

/** A deterministic engine, used for dry runs and tests. */
export function scriptedEngine(steps: any[]): EngineDescriptor {
    let call = 0;
    return {
        id: 'scripted',
        label: 'Scripted (deterministic)',
        capabilities: [CAPABILITY.TOOLS, CAPABILITY.OFFLINE],
        async probe() {
            return { ok: true, detail: 'deterministic engine' };
        },
        async generate() {
            const step = steps[Math.min(call, steps.length - 1)];
            call++;
            return {
                text: step.text ?? '',
                toolCalls: step.toolCalls ?? [],
                finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
                engineId: 'scripted',
            };
        },
    };
}

/** The registry: Javelin holds engines, assigns them to roles, and degrades gracefully. */
export class EngineRegistry {
    private engines = new Map<string, EngineDescriptor>();
    private roles = new Map<string, string>();
    private primaryId?: string;
    private health = new Map<string, { ok: boolean; detail?: string }>();

    register(engine: EngineDescriptor): this {
        this.engines.set(engine.id, engine);
        if (!this.primaryId) {
            this.primaryId = engine.id;
        }
        return this;
    }

    assign(role: string, engineId: string): this {
        if (!this.engines.has(engineId)) {
            throw new Error(`Cannot assign unknown engine "${engineId}" to role "${role}"`);
        }
        this.roles.set(role, engineId);
        if (role === 'primary') {
            this.primaryId = engineId;
        }
        return this;
    }

    resolve(role = 'primary'): EngineDescriptor {
        const id = this.roles.get(role) ?? this.primaryId;
        const engine = (id ? this.engines.get(id) : undefined) ?? this.engines.values().next().value;
        if (!engine) {
            throw new Error('No inference engine is registered.');
        }
        return engine;
    }

    list() {
        return [...this.engines.values()].map((e) => ({
            id: e.id,
            label: e.label,
            capabilities: e.capabilities,
            health: this.health.get(e.id) ?? null,
            roles: [...this.roles.entries()].filter(([, v]) => v === e.id).map(([r]) => r),
        }));
    }

    async probeAll(): Promise<Record<string, { ok: boolean; detail?: string }>> {
        const results: Record<string, { ok: boolean; detail?: string }> = {};
        for (const engine of this.engines.values()) {
            const res = await engine.probe().catch((err: any) => ({ ok: false, detail: err.message }));
            this.health.set(engine.id, res);
            results[engine.id] = res;
        }
        return results;
    }

    /** Healthiest available engine, preferring the requested role. */
    async bestAvailable(role = 'primary'): Promise<EngineDescriptor> {
        if (this.health.size === 0) {
            await this.probeAll();
        }
        const preferred = this.resolve(role);
        if (this.health.get(preferred.id)?.ok !== false) {
            return preferred;
        }
        for (const engine of this.engines.values()) {
            if (this.health.get(engine.id)?.ok) {
                return engine;
            }
        }
        return preferred;
    }
}
