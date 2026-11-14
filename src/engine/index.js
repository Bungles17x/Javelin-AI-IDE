/**
 * Javelin Engine — public API.
 *
 * The IDE (Agent mode) calls `runAgent`. Everything else here exists so the
 * transport, memory and tool layers can be used, tested and tuned independently of
 * the orchestrator:
 *
 *   const result = await runAgent({ task, workspace, provider, events, signal })
 *
 * Provider configuration is a plain object, so local Ollama and hosted
 * OpenAI-compatible models use the same code path:
 *
 *   { providerId: 'javelin', model: 'javelin-coder:latest' }
 *   { providerId: 'openai', apiKey, model: 'gpt-5-codex' }
 *   { providerId: 'custom', baseUrl: 'https://vllm.internal/v1', apiKey, model: 'qwen3-coder' }
 */

export {
  AGENT_SYSTEM_PROMPT,
  PHASE,
  runAgent,
} from './run.js'

export {
  approvalKeyFor,
  executeTool,
  isReadOnlyTool,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  requiresApproval,
  TOOL_DEFS,
  verifyMutation,
} from './tools.js'

export {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  HOSTED_PROVIDER_IDS,
  isHostedProvider,
  isLoopbackEndpoint,
  MAX_MODEL_RETRIES,
  requestCompletion,
  resolveTransport,
} from './providers.js'

export {
  buildTranscript,
  createMemory,
  ensureToolResultPairing,
  estimateTokens,
  snapshotMetrics,
} from './memory.js'

export { buildTaskMessage, extractPlan, hasSuccessfulMutation, VERIFICATION_CLAIM_NOTE } from './reasoning.js'

export {
  buildProjectContext,
  buildWorkspaceIndex,
  detectVerificationCommands,
  findReferences,
  formatProjectOverview,
  isVerificationCommand,
  parseImports,
  refreshProjectIndex,
  relevantFiles,
  resolveImport,
  unresolvedImports,
} from './projectIndex.js'

export {
  classifyModelError,
  codeError,
  ERROR_CODES,
  ERROR_TITLES,
  errorLabel,
  errorTitle,
  isErrorCode,
} from './errors.js'

export {
  DEFAULT_CONTEXT_CHARS,
  DEFAULT_RUN_BUDGET_MS,
  MAX_IDENTICAL_RESPONSES,
  MAX_NO_ACTION_TURNS,
  MAX_REPEATED_ACTIONS,
  MAX_STALLED_STEPS,
  MAX_STEPS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_RESULT_IN_TRANSCRIPT,
} from './limits.js'
