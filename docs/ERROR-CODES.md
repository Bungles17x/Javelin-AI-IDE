# Error Codes

Every run that does not finish cleanly reports a code, both on the result (`result.code`)
and on the `error` event the IDE shows while the run ends. The code is stable: it can be
searched, copied from a screenshot, and cited in a bug report without needing the full
summary text.

Format: **`ER.CCNN`** — category, then a sequence number.

Where the code appears:

- the run result panel (`Run could not finish.` plus the code)
- the final assistant message (`Error code: ER.0203 — ...`)
- the status line when the run ends
- a thrown provider error's `error.code` (chat and agent paths)

## 01 — Model transport and provider configuration

| Code | Meaning | What to check |
| --- | --- | --- |
| `ER.0101` | The model endpoint could not be reached | Is Ollama running on `127.0.0.1:11434`? For a hosted provider: network, VPN, proxy, base URL. |
| `ER.0102` | The model rejected the credential | API key missing, wrong, revoked, or without access to that model. |
| `ER.0103` | The model stopped responding | Request or idle timeout. The server accepted the call and produced nothing. Retry, or use a faster/smaller model. |
| `ER.0104` | The model returned no usable response | Empty stream or no content. Often a broken model file or a server crash mid-stream. |
| `ER.0105` | The model configuration is invalid | Missing key for a hosted provider, non-https endpoint, remote URL on a local provider, or an unknown model id. |
| `ER.0106` | The model call failed | A non-retryable HTTP error (400, 422, 5xx after retries) or an unexpected provider response. The summary includes the status and detail. |

## 02 — Loop bounds (the run was stopped to prevent a loop)

These are protections, not crashes. They mean the model was not making progress.

| Code | Meaning | What to check |
| --- | --- | --- |
| `ER.0201` | The step limit was reached | The model never called `finish`. Try a narrower task, or verify the model is emitting tool calls at all. |
| `ER.0202` | The model never took a tool action | It answered with prose instead of tools on repeated turns. Usually a model that is too small for tool calling, or a vague task. |
| `ER.0203` | The model repeated the same response | Identical text, no tool call, twice. The run stops rather than burn tokens on a loop. Try restating the task concretely, or switch models. |
| `ER.0204` | Repeated actions made no progress | The same tool call was reissued with an unchanged workspace after failing. The reminder in the transcript names the call. If the requested files already exist, the run ends successfully instead of failing on the repeat. |
| `ER.0205` | The requested workspace change never happened | The task asked for a file change; many steps passed with no successful write. Check the tool results for denied or failed writes. |
| `ER.0206` | The run exceeded its time budget | Wall-clock limit for one run. Raise it only if the task genuinely needs longer. |
| `ER.0207` | The task named files that were never created | The summary lists exactly which paths are missing. The run does **not** report success while a named file is absent. |

## 03 — User control

| Code | Meaning |
| --- | --- |
| `ER.0301` | The run was stopped by the user (Stop button or abort). Changes so far remain, and revert is still offered. |

## 04 — Tools

| Code | Meaning |
| --- | --- |
| `ER.0401` | A tool call failed (bad path, failed command, unreadable file). |
| `ER.0402` | A tool call had invalid JSON arguments and was not executed. |
| `ER.0403` | The model asked for a tool that is not available. |

## 05 — Approvals

| Code | Meaning |
| --- | --- |
| `ER.0501` | The user denied the action. It is not retried; the model must propose an alternative. |

## 06 — Workspace safety

| Code | Meaning |
| --- | --- |
| `ER.0601` | A write could not be verified by re-reading the workspace. The write is reported as failed, not as success. |
| `ER.0602` | The safety checkpoint before the run could not be created, so the run refused to edit files it cannot revert. |

## 07 — Engine internals

| Code | Meaning |
| --- | --- |
| `ER.0701` | An internal engine error. The summary carries the underlying message. |
| `ER.0000` | Unclassified failure — the code should be extended to cover it. |

## Adding a code

1. Add it to `ERROR_CODES` and `ERROR_TITLES` in `src/engine/errors.js`.
2. Add a row to this table.
3. Never renumber or reuse an existing code.

`tests/engine-v2.test.mjs` asserts that codes are unique, match `ER.NNNN`, and all have
titles, so a malformed addition fails the suite.
