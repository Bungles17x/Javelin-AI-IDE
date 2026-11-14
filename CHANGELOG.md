# Changelog

All notable changes to Javelin AI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Private extension auto-updates.** The VS Code extension checks private GitHub Releases at startup, installs newer VSIX versions, and keeps update credentials in SecretStorage.
- **Automatic safety checkpoint.** A checkpoint is taken by the runtime *before the
  first tool call* of every run. It does not depend on the agent remembering to ask
  for one, so "revert everything" is always available — even after a run that
  corrupted files or crashed mid-way. If the workspace cannot be snapshotted, the run
  refuses to edit rather than proceeding unprotected.
- **Accept all / Revert all.** After any run that changed files, choose to keep the
  changes or put every changed file back, including un-deleting removed ones.
  Available in the panel and the Command Palette.
- **Revert to your last message.** Discards your last request and everything after
  it, and restores the files to before it ran. Your wording returns to the input box.
- **`get_tree` tool.** The agent now sees the whole project as a nested tree of
  folders and files, with an explicit depth cap that announces itself instead of
  truncating silently.
- **Live task checklist.** A stated plan is parsed into ordered steps and ticked off
  as real work succeeds. Only successes advance it, so a retry never reads as progress.
- Menu action and command-palette entries for revert/accept.
- `LICENSE` (MIT), `CONTRIBUTING.md`, and this changelog.

### Changed

- **`auto-edit` autonomy no longer auto-approves file deletion.** It trusts code
  edits; deleting a file and unusual commands still confirm. Only `full` grants
  unattended deletion.
- **"Always allow" on a deletion is scoped to that specific file**, not to every file.
- The agent's identity prompt now begins with the project tree instead of probing
  directories one at a time.
- Root `package.json` gains `license`, `repository`, `author` and keywords.

### Fixed

- **Panel could load fully dead.** `loadConversation()` ran before the webview message
  listener was registered; a throw there meant no button responded. Setup is now
  guarded, the listener is registered last, and dispatch errors are contained so one
  failing action cannot wedge the panel.
- **Corrupt persisted state could break the panel.** Undo marks are now read
  defensively (`Array.isArray` check) instead of assuming an array.
- **Async project indexing was never awaited** in `src/core/index.js`, so a workspace
  exposing only async `snapshotFiles()` indexed nothing and the agent planned against
  an empty project.
- Removed a dead no-op "opportunistic checkpoint" block that claimed to be a backstop
  but did nothing — superseded by the automatic baseline.
- Removed a stray scratch file (`tmp-tooltest.json`) from the repo root.

### Tests

- `revert-changes.test.mjs` — proves the safety net: revert restores corrupted files,
  un-deletes deleted ones, is idempotent, survives a mid-run crash, and that a run
  refuses to edit when no checkpoint can be taken.
- `workspace-visibility.test.mjs` — proves the tree covers nested folders and files,
  honours its depth cap, degrades gracefully, and that plans become task steps.
- `webview-integrity.test.mjs` — proves every element the panel binds exists and every
  critical button is wired, so the "no buttons work" failure cannot recur silently.
- `file-permissions.test.mjs` — extended to lock in that `auto-edit` gates deletion
  and that only `full` grants it.

## [1.0.0]

- Initial release: Chat, Agent and Javelin modes; web app and VS Code extension;
  approval gate with preview diffs; failure memory; checkpoints; local (keyless) and
  cloud providers; a training-data capture pipeline.

[Unreleased]: https://github.com/javelin-ai/javelin-ai-assistant/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/javelin-ai/javelin-ai-assistant/releases/tag/v1.0.0