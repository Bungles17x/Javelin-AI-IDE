/**
 * Agent entry point.
 *
 * The implementation lives in `src/engine`:
 *
 *   providers.js  model transport (Ollama, hosted OpenAI-compatible), retries, timeouts
 *   memory.js     bounded transcript, attempt ledger, file cache, metrics
 *   tools.js      tool policy, execution and post-write verification
 *   reasoning.js  prompts, plan extraction, completion rules
 *   run.js        the bounded orchestrator loop
 *
 * This module is deliberately thin: the IDE and the existing test suite address one
 * stable import path while the engine evolves underneath it.
 */

export { runAgent, MAX_STEPS, PHASE, AGENT_SYSTEM_PROMPT } from '../engine/run.js'
