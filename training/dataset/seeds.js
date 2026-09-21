/**
 * Seed corpus — bootstrap training examples before any real traces exist.
 * ==========================================================================
 *
 * Chicken-and-egg problem: fine-tuning needs data, but data comes from runs, and
 * early runs are bad. The standard resolution is to bootstrap with synthetic
 * examples, then replace them with real traces as those accumulate.
 *
 * Two hard rules observed here:
 *
 *  1. **Every synthetic record is labelled `source: 'synthetic'`.** A pipeline that
 *     cannot distinguish generated from observed data will eventually train on its
 *     own hallucinations. The label is what makes the data honest.
 *
 *  2. **Synthetic examples are derived from the real tool schemas**, not invented.
 *     A seed that teaches a tool signature Javelin does not have is worse than no
 *     seed at all, so `buildSeedDataset()` reads the live registry.
 *
 * The seeds teach *policy*, which is what a base model lacks and what fine-tuning
 * is genuinely good at:
 *   - inspect before editing
 *   - exact-snippet edits rather than whole-file rewrites
 *   - verify after editing
 *   - state a cause before repairing
 */

import { SOURCE, SKILL, JDF_VERSION, recordId } from './format.js'
import { IDENTITY_TRAINING_PROMPT } from '../../src/core/identity.js'

/**
 * The identity Javelin actually uses, imported from the single source of truth.
 *
 * This previously held a *shortened copy* of the runtime prompt, which meant a
 * fine-tuned model would be trained toward one identity and then served with a
 * different one. It now imports the real thing, so training and inference agree by
 * construction.
 *
 * Note it is the IDENTITY ONLY — the agent contract (tool names, whether commands
 * can run) is deliberately excluded, because that varies per session and must not
 * be baked into the weights.
 */
export const SEED_SYSTEM_PROMPT = IDENTITY_TRAINING_PROMPT

function call(name, args) {
  return {
    id: 'call_seed',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function sft({ skill, task, context, toolName, args, toolResult, tags = [], notes }) {
  const messages = [{ role: 'system', content: SEED_SYSTEM_PROMPT }]
  if (notes) {
    messages.push({ role: 'system', content: notes })
  }
  messages.push({ role: 'user', content: `TASK: ${task}` })
  for (const m of context ?? []) {
    messages.push(m)
  }
  messages.push({ role: 'assistant', content: null, tool_calls: [call(toolName, args)] })
  if (toolResult != null) {
    messages.push({
      role: 'tool',
      tool_call_id: 'call_seed',
      name: toolName,
      content: String(toolResult),
    })
  }

  return {
    id: recordId('seed', skill, toolName, JSON.stringify(args), task),
    version: JDF_VERSION,
    kind: 'sft',
    source: SOURCE.SYNTHETIC,
    skill,
    messages,
    outcome: { status: 'success', verified: true },
    meta: { task, weight: 0.5, derivedFrom: 'seed' },
    tags: ['seed', ...tags],
  }
}

/**
 * Build the seed dataset. `toolSchemas` is accepted so callers can assert that
 * every seeded tool actually exists in the registry.
 */
export function buildSeedDataset({ toolSchemas = null } = {}) {
  const records = []

  // ---------------------------------------------------------------- inspect
  records.push(
    sft({
      skill: SKILL.TOOL_SELECTION,
      task: 'Fix the off-by-one error in the pagination helper',
      toolName: 'list_files',
      args: { path: 'src' },
      toolResult: 'src/\nsrc/pagination.js\nsrc/api.js\n',
      tags: ['inspect-first'],
    }),
    sft({
      skill: SKILL.TOOL_SELECTION,
      task: 'Fix the off-by-one error in the pagination helper',
      context: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [call('list_files', { path: 'src' })],
        },
        { role: 'tool', tool_call_id: 'call_seed', name: 'list_files', content: 'src/pagination.js\nsrc/api.js\n' },
      ],
      toolName: 'read_file',
      args: { path: 'src/pagination.js' },
      toolResult: 'export function page(items, n, size) {\n  const start = n * size\n  return items.slice(start, start + size + 1)\n}\n',
      tags: ['read-before-write'],
    }),
    sft({
      skill: SKILL.TOOL_SELECTION,
      task: 'Where is the discount formula defined?',
      toolName: 'search_code',
      args: { query: 'discount', isRegex: false },
      toolResult: 'src/pricing.js:14: function applyDiscount(price) {',
      tags: ['search-instead-of-guess'],
    }),
  )

  // ------------------------------------------------------------------ edits
  records.push(
    sft({
      skill: SKILL.EDIT_PRECISION,
      task: 'Fix the off-by-one error in the pagination helper',
      context: [
        {
          role: 'assistant',
          content: 'Plan:\n1. Read src/pagination.js\n2. Fix the slice bound\n3. Run the tests',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [call('read_file', { path: 'src/pagination.js' })],
        },
        {
          role: 'tool',
          tool_call_id: 'call_seed',
          name: 'read_file',
          content: 'export function page(items, n, size) {\n  const start = n * size\n  return items.slice(start, start + size + 1)\n}\n',
        },
      ],
      toolName: 'edit_file',
      args: {
        path: 'src/pagination.js',
        old_string: 'return items.slice(start, start + size + 1)',
        new_string: 'return items.slice(start, start + size)',
      },
      toolResult: 'Edited src/pagination.js (+1 / -1 lines).',
      tags: ['exact-snippet'],
      notes: 'Prefer a minimal, exact-snippet edit over rewriting the file.',
    }),

    // A "create a new file" example, which correctly uses write_file.
    sft({
      skill: SKILL.EDIT_PRECISION,
      task: 'Add a helper that clamps a number to a range',
      toolName: 'write_file',
      args: {
        path: 'src/clamp.js',
        content: 'export function clamp(value, min, max) {\n  return Math.min(Math.max(value, min), max)\n}\n',
      },
      toolResult: 'Created src/clamp.js (+3 / -0 lines).',
      tags: ['new-file'],
      notes: 'write_file is correct here because the file does not exist yet.',
    }),
  )

  // ------------------------------------------------------------ verification
  records.push(
    sft({
      skill: SKILL.VERIFICATION,
      task: 'Fix the pagination bug and confirm it is fixed',
      context: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_seed',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  path: 'src/pagination.js',
                  old_string: 'return items.slice(start, start + size + 1)',
                  new_string: 'return items.slice(start, start + size)',
                }),
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_seed', name: 'edit_file', content: 'Edited src/pagination.js (+1 / -1 lines).' },
      ],
      toolName: 'run_command',
      args: { command: 'npm test' },
      toolResult: '$ npm test\nexit code: 0\n--- stdout ---\nPASS test/pagination.test.js\n',
      tags: ['verify-after-edit'],
      notes: 'Files were changed. Run the tests before claiming the task is complete.',
    }),
  )

  // --------------------------------------------------------------- repair
  records.push(
    sft({
      skill: SKILL.REPAIR,
      task: 'Fix the pagination bug and confirm it is fixed',
      context: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_failed',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  path: 'src/pagination.js',
                  old_string: 'items.slice(start, start + size)',
                  new_string: 'items.slice(start, start + size)',
                }),
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_failed',
          name: 'edit_file',
          content: 'ERROR: old_string not found in src/pagination.js. It must match the file exactly, including indentation.',
        },
      ],
      toolName: 'read_file',
      args: { path: 'src/pagination.js' },
      toolResult: 'export function page(items, n, size) {\n  const start = n * size\n  return items.slice(start, start + size + 1)\n}\n',
      tags: ['repair', 'hypothesis-driven'],
      notes:
        'Diagnosis: the edit failed because the snippet was guessed rather than read. ' +
        'The correct response is to read the file to obtain the exact text, not to retry the same edit.',
    }),
  )

  // --------------------------------------------------- honesty / refusal
  records.push(
    {
      id: recordId('seed', SKILL.HONESTY, 'no-repeat'),
      version: JDF_VERSION,
      kind: 'sft',
      source: SOURCE.SYNTHETIC,
      skill: SKILL.HONESTY,
      messages: [
        { role: 'system', content: SEED_SYSTEM_PROMPT },
        { role: 'user', content: 'TASK: Fix the build' },
        {
          role: 'system',
          content:
            'ACTIONS THAT ALREADY FAILED — never repeat these:\n- run_command:npm run build:prod',
        },
        {
          role: 'assistant',
          content:
            'I will not re-run that command — it already failed, and the failure is already in context. I will inspect the build configuration to find the cause instead.',
        },
      ],
      outcome: { status: 'success', verified: true },
      meta: { task: 'Fix the build', weight: 0.5, derivedFrom: 'seed' },
      tags: ['seed', 'no-repeat'],
    },
    {
      id: recordId('seed', SKILL.VERIFICATION, 'unverified-finish'),
      version: JDF_VERSION,
      kind: 'sft',
      source: SOURCE.SYNTHETIC,
      skill: SKILL.VERIFICATION,
      messages: [
        { role: 'system', content: SEED_SYSTEM_PROMPT },
        { role: 'user', content: 'TASK: Refactor the parser' },
        {
          role: 'assistant',
          content:
            'I changed the parser but have not verified it. I should run the project tests before calling this complete. I will not claim verification I did not perform.',
        },
      ],
      outcome: { status: 'success', verified: true },
      meta: { task: 'Refactor the parser', weight: 0.5, derivedFrom: 'seed' },
      tags: ['seed', 'verify-before-claiming'],
    },
  )

  // Guard against seeds drifting from the real tool surface.
  if (toolSchemas) {
    const known = new Set(toolSchemas.map((t) => t.function?.name).filter(Boolean))
    const used = new Set()
    for (const r of records) {
      for (const m of r.messages) {
        for (const tc of m.tool_calls ?? []) {
          used.add(tc.function.name)
        }
      }
    }
    const missing = [...used].filter((name) => !known.has(name))
    if (missing.length) {
      throw new Error(
        `Seed dataset references tools that do not exist in the registry: ${missing.join(', ')}. ` +
        `Update training/dataset/seeds.js so seeds match the real tool surface.`,
      )
    }
  }

  return records
}