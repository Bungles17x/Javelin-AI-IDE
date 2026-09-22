# Contributing to Javelin AI

Thanks for wanting to help. This project has a few standards that matter more than
usual, because it's an agent that edits other people's files.

## Getting set up

```bash
git clone https://github.com/javelin-ai/javelin-ai-assistant.git
cd javelin-ai-assistant
npm install
npm test          # must pass before you open a PR
npm run dev       # the web app on http://localhost:5173
```

For the VS Code extension:

```bash
cd vscode-extension
npm install
npm run compile   # REQUIRED after any change under src/
```

Then press **F5** in VS Code to launch an Extension Development Host.

## The one rule that will trip you up

**The extension runs compiled JavaScript, not the TypeScript you edit.**

If you change `vscode-extension/src/`, VS Code still runs the old `out/` until you
rebuild and reload. Testing without rebuilding means testing code you didn't write.
This has caused a real, confusing bug report ("no buttons work") — so:

```bash
cd vscode-extension && npm run compile
```

then **Developer: Reload Window**.

## Standards

- **Tests come with the change.** `npm test` is the contract. If you fix a bug, add
  the assertion that would have caught it — several tests here exist purely to lock
  in a bug that already shipped once.
- **No unguarded setup-time reads.** Read persisted state defensively
  (`Array.isArray(x) ? x : []`). A throw during panel setup can prevent the message
  listener from ever registering, which makes every button silently dead.
- **Comment the *why*.** Explain what the code is protecting against, not what it
  does. "Guard the read — a stale value here kills the whole panel" is useful;
  "check if array" is not.
- **Match the surrounding style.** The codebase favours early returns, explicit
  names, and dependency-free implementations.

## Safety invariants — do not weaken these

This agent edits real files. These behaviours are load-bearing:

| Invariant | Why |
|---|---|
| A safety checkpoint is taken **before the first tool call** | The agent cannot be trusted to remember to checkpoint; the escape hatch must not depend on it |
| `delete_file` still asks under `auto-edit` | Only `full` autonomy grants unattended deletion |
| "Always allow" on a delete is scoped **per file** | Consent for one file must not become permission for any file |
| Catastrophic commands are refused at **every** autonomy level | `rm -rf /` is never a thing the agent may do |
| An unverified `finish` is refused once files changed | Claiming success without running anything is the failure mode to avoid |

## Reporting a bug

Include: what you asked, what happened, what you expected, and whether you are in
**Chat**, **Agent** or **Javelin** mode.

That last one matters: **Chat mode has no tools and cannot see your files.** It
saying "I can't access your workspace" is correct behaviour, not a bug.

## Honesty

Don't claim something is verified if you didn't verify it. The project's own
docs say so, and it's the whole point of the verify phase.