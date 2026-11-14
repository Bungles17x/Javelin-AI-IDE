const WORKSPACE_CHANGE_REQUEST = /\b(create|make|build|implement|add|write|fix|refactor|modify|update|change|generate|scaffold|repair|remove|delete|rename|move)\b/i;
const CONTINUATION_REQUEST = /^(?:(?:please\s+)?(?:continue|go on|keep going|carry on|proceed|resume|try again|keep working|finish it)(?:\s+(?:the task|with it|with that|from where you left off|where you left off))?|fix this and continue)[.!?\s]*$/i;

export function taskRequiresWorkspaceChange(text: string): boolean {
    return WORKSPACE_CHANGE_REQUEST.test(String(text ?? ''));
}

export function resolveContinuationTask(
    task: string,
    priorMessages: Array<{ role?: string; content?: string }> = [],
): string {
    const currentTask = String(task ?? '').trim();
    if (!CONTINUATION_REQUEST.test(currentTask)) {
        return currentTask;
    }

    const previousRequest = [...priorMessages].reverse().find((message) => {
        const content = String(message?.content ?? '').trim();
        return message?.role === 'user' && content && !CONTINUATION_REQUEST.test(content);
    });
    if (!previousRequest) {
        return currentTask;
    }

    return `Continue the previous user request: ${String(previousRequest.content).trim()}\n\nLatest user message: ${currentTask}`;
}
