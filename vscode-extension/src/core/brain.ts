/**
 * Javelin Core for VS Code — the brain.
 *
 * Javelin's own reasoning lifecycle, separate from any model:
 *   UNDERSTAND → PLAN → ACT → OBSERVE → VERIFY → (REPAIR → VERIFY)* → CONCLUDE
 *
 * Two mechanisms make it self-correcting rather than merely retrying: failure
 * memory (a failed action is never repeated verbatim) and diagnosis (a REPAIR
 * turn must state a hypothesis about the cause before acting again).
 */

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

export const PHASE = {
    UNDERSTAND: 'understand',
    PLAN: 'plan',
    ACT: 'act',
    OBSERVE: 'observe',
    VERIFY: 'verify',
    REPAIR: 'repair',
    CONCLUDE: 'conclude',
} as const;

export type Phase = typeof PHASE[keyof typeof PHASE];

export const PHASE_LABEL: Record<string, string> = {
    understand: 'Understanding the task and project',
    plan: 'Planning',
    act: 'Making changes',
    observe: 'Reading results',
    verify: 'Verifying',
    repair: 'Diagnosing a failure',
    conclude: 'Wrapping up',
};

export const JAVELIN_IDENTITY = `You are Javelin, an autonomous coding agent with your own runtime.

You are not a chat assistant that emits code. You are a system that forms a plan, executes it with tools, observes the result, and corrects itself. You remember what you tried — especially what failed — and you never repeat a failed action verbatim. You verify your work instead of assuming it is correct, and you are honest when something did not work.

CORE LAWS
1. INVESTIGATE BEFORE ACTING. Start with get_tree to see the whole project layout — every
   folder and file — then list_files / read_file / search_code for detail. Never invent a
   path — verify it exists.
2. READ BEFORE WRITING. Always read a file before editing it. Use edit_file with an exact snippet. Only use write_file for genuinely new files or a deliberate full replacement.
3. NEVER OVERWRITE BLINDLY. Changing a whole file to alter a few lines is forbidden. Match existing style and conventions.
4. DO NOT REPEAT A FAILED ACTION. The reason it failed is already in your context. Change your approach.
5. DIAGNOSE BEFORE REPAIRING. When verification fails, state a one-line hypothesis about the root cause, then act on that hypothesis.
6. VERIFY, DO NOT ASSUME. Run tests/build when they exist. "verified: true" is only allowed if you actually ran something and it passed.
7. BE CONCISE AND HONEST. Do not narrate every step at length. Do not claim success you did not confirm.

You have a \`remember\` tool for durable project facts and a \`recall\` tool for your own memory.`;

const PHASE_DIRECTIVES: Record<string, string> = {
    [PHASE.UNDERSTAND]: `PHASE: UNDERSTAND.
Before planning, ground yourself in the actual project. Read the files that matter and search for the symbols involved. Do not propose changes yet — gather facts.`,
    [PHASE.PLAN]: `PHASE: PLAN.
State a short, numbered plan (2-5 steps) naming the specific files you will touch. Then begin executing step 1.`,
    [PHASE.ACT]: `PHASE: ACT.
Execute your plan one action at a time. Prefer the smallest change that achieves the goal.`,
    [PHASE.OBSERVE]: `PHASE: OBSERVE.
Read the tool results carefully. Did the action do what you intended? If not, adjust before continuing.`,
    [PHASE.VERIFY]: `PHASE: VERIFY.
Now confirm the work holds. Run the project's tests, build or linter. If there are none, re-read the changed code and check the logic manually. Do not call finish(verified: true) without having run something.`,
    [PHASE.REPAIR]: `PHASE: REPAIR.
Your previous verification FAILED. First state a one-line hypothesis: "The failure is caused by X."
Then act on that hypothesis specifically. Do NOT repeat an action from the failure list — it already did not work.`,
    [PHASE.CONCLUDE]: `PHASE: CONCLUDE.
Call \`finish\` with an honest summary of what changed and whether you verified it.`,
};

export function buildPhaseMessages(opts: {
    task: string;
    phase: string;
    transcript: any[];
    memoryBlock?: string | null;
    failures: string[];
    plan?: string | null;
}): any[] {
    const messages: any[] = [{ role: 'system', content: JAVELIN_IDENTITY }];

    if (opts.memoryBlock) {
        messages.push({ role: 'system', content: opts.memoryBlock });
    }
    if (opts.failures.length) {
        messages.push({
            role: 'system',
            content:
                'ACTIONS THAT ALREADY FAILED — never repeat these exact calls, they will fail again:\n' +
                opts.failures.map((f) => `- ${f}`).join('\n') +
                '\nFor each, take a materially different approach.',
        });
    }
    if (opts.plan) {
        messages.push({ role: 'system', content: `Your current plan:\n${opts.plan}` });
    }

    messages.push({ role: 'user', content: `TASK: ${opts.task}` });
    messages.push(...opts.transcript.slice(-24));
    messages.push({ role: 'user', content: PHASE_DIRECTIVES[opts.phase] ?? '' });

    return messages;
}

export function nextPhase(state: {
    phase: string;
    stepsTaken: number;
    hasEdited: boolean;
    verificationFailed: boolean;
    planStated: boolean;
}): string {
    if (state.verificationFailed) {
        return PHASE.REPAIR;
    }
    if (state.phase === PHASE.UNDERSTAND) {
        return state.stepsTaken >= 1 ? PHASE.PLAN : PHASE.UNDERSTAND;
    }
    if (state.phase === PHASE.PLAN) {
        return state.planStated ? PHASE.ACT : PHASE.PLAN;
    }
    if (state.phase === PHASE.ACT) {
        return state.hasEdited ? PHASE.VERIFY : PHASE.ACT;
    }
    if (state.phase === PHASE.VERIFY) {
        return PHASE.CONCLUDE;
    }
    if (state.phase === PHASE.REPAIR) {
        return PHASE.VERIFY;
    }
    return PHASE.CONCLUDE;
}

/** Should verification be demanded before finish() is honoured? */
export function verificationPolicy(opts: {
    hasEdited: boolean;
    verificationAvailable: boolean;
    commandCount: number;
}): { required: boolean; reason: string } {
    if (!opts.hasEdited) {
        return { required: false, reason: 'no files were changed' };
    }
    if (!opts.verificationAvailable) {
        return { required: false, reason: 'no test/build command is available here' };
    }
    if (opts.commandCount === 0) {
        return { required: true, reason: 'files changed but nothing was executed to verify them' };
    }
    return { required: false, reason: 'verification was attempted' };
}

export function classifyCommandResult(command: string, exitCode: number) {
    const isVerification = /test|build|lint|typecheck|type-check|check|vet|compile/i.test(command);
    return {
        isVerification,
        passed: exitCode === 0,
        failedVerification: isVerification && exitCode !== 0,
    };
}

export function extractPlan(text: string): string | null {
    if (!text) {
        return null;
    }
    const numbered = text.split('\n').filter((l) => /^\s*(\d+[.)]|[-*])\s+\S/.test(l));
    return numbered.length >= 2 ? numbered.slice(0, 8).join('\n') : null;
}

/**
 * Parse a stated plan into individual task steps, in order.
 *
 * `extractPlan` returns one blob of text, which can only be displayed. Splitting the
 * plan into steps lets the UI show a real checklist and tick steps off as the run
 * progresses — so "what will it do" and "what has it done" are the same view.
 *
 * Steps are returned bare (marker and leading punctuation stripped) so the caller
 * controls numbering and presentation.
 */
export function extractPlanSteps(text: string): string[] {
    if (!text) {
        return [];
    }
    const steps: string[] = [];
    for (const raw of text.split('\n')) {
        const match = raw.match(/^\s*(?:\d+[.)]|[-*\u2022])\s+(\S.*)$/);
        if (!match) {
            continue;
        }
        // Strip an optional bold wrapper and trailing whitespace so the text reads
        // as a task, not as markdown source.
        const step = match[1].replace(/\*\*/g, '').trim();
        if (step) {
            steps.push(step);
        }
    }
    return steps.slice(0, 12);
}

export function extractHypothesis(text: string): string | null {
    if (!text) {
        return null;
    }
    const match = text.match(/(?:cause|caused by|because|the (?:bug|issue|problem) is|hypothesis:?)\s*(.{10,200})/i);
    return match ? match[1].trim() : null;
}

export function summariseRun(opts: {
    status: string;
    summary: string;
    steps: any[];
    checkpoints: any[];
    filesTouched: string[];
    verified: boolean;
    verificationReason?: string | null;
}): string {
    const bits: string[] = [];
    bits.push(opts.summary || (opts.status === 'done' ? 'Completed.' : 'Run ended.'));

    if (opts.filesTouched.length) {
        bits.push(`Changed ${opts.filesTouched.length} file(s): ${opts.filesTouched.join(', ')}.`);
    } else if (opts.status === 'done') {
        bits.push('No files were changed.');
    }
    if (opts.checkpoints.length) {
        bits.push(`${opts.checkpoints.length} checkpoint(s) available to revert.`);
    }
    if (opts.verified) {
        bits.push('Verification passed.');
    } else if (opts.verificationReason) {
        bits.push(`Not verified — ${opts.verificationReason}.`);
    }
    const failed = opts.steps.filter((s) => s.ok === false).length;
    if (failed) {
        bits.push(`${failed} action(s) failed and were worked around.`);
    }
    return bits.join(' ');
}
