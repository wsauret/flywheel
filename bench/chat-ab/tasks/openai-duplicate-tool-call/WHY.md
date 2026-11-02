# openai-duplicate-tool-call

Fix commit: 679ea558ca1c0ff29c40e7d460e475042bd13986, "fix(openai): dedupe tool calls by call id on the completed refold".

Base commit: e67ebae9d014895afadf4e539ce77aec9c374240 (the parent of the fix).

## The requirement

The user says that a GPT turn with parallel tool calls records one call twice. The turn then fails with "assistant message 1 contains duplicate tool_use ids", and the session cannot open again because two `tool.input.completed` facts carry the same canonical toolUseId. The user asks that new turns no longer record a call twice. The message names no layer, so any fix that stops the duplicate before the turn forwards, canonicalizes, or commits the call meets the requirement. Ordinary engineering care also requires that the fix keeps every distinct call.

## The bug

The OpenAI Responses adapter (`src/orchestration/agent-runtime/llm/openai.ts`) yields terminal items from two places: each `response.output_item.done` event, and the refold over `response.completed.output`. It deduplicated the refold by the wire item id, and by the output index when an item had no id. A provider that omits the item id and also reports a different array position on the completed frame defeats both keys, so the same `function_call` yielded two `tool_use` events. The turn stream forwarded both, which wrote two `tool.input.completed` facts, and committed both, which made the session context refuse the turn.

## Why it is a fair task

Neither error message names the adapter. A solver must trace from the session-context and fact-replay errors back through the turn recording to the stream adapter, or must find where the turn accepts provider calls. The reference fixes the adapter refold by call id. A fix at the turn stream that drops a repeated call id before forwarding is equally valid, and the tests accept it.

## What the tests check

The single test file `acceptance/parallel-tool-calls-turn.test.ts` sends a provider stream through the real `createOpenAIAdapter` (only the `openai` SDK client is faked, inside the test file) and the real `streamAssistantTurn`, through a one-candidate `ModelClient`. For each stream it reads four outputs: the `tool_use` ids that the turn forwards through `onEvent` (the source of `tool.input.completed`), the ids it hands to `canonicalizeToolCall`, `result.toolCalls`, and the `tool_use` blocks in `result.assistantContent`. Each must equal `["call_1", "call_2"]`, and the outcome must be `ok`.

1. The fault stream: a message item and two parallel calls with no item id are streamed at output indexes 0, 1, and 2, and the completed frame lists them as `[call_1, call_2, message]`. Base gives `[call_1, call_2, call_1]` everywhere and fails.
2. Regression guard: one call is streamed, and the completed frame reports a second call that had no done event. It catches a fix that stops reading calls from the completed frame.
3. Regression guard: two calls with no item id, the same tool name, and the same arguments are streamed, and the completed frame swaps them. It catches a fix that merges distinct calls by tool name, arguments, or the missing item id.

## What the tests do not check

- The tests do not run `runAgentLoop`, so a fix that removes the duplicate only in the loop's commit step, after `streamAssistantTurn` returns, fails. That fix would still forward a duplicate `tool_use` event, so it would still write two `tool.input.completed` facts.
- The tests do not check stream retries. A turn-level fix that never clears its seen ids on a retried attempt is not detected.
- The tests do not repair sessions that already hold duplicate facts. The user asked only about new turns.
- The tests do not check providers other than the OpenAI Responses adapter, or the ChatGPT transport.

## How to apply the reference

The sandbox patch (`sandbox.patch`) sets `bunfig.toml` `[test] root` to `.` so that `bun test acceptance` finds the acceptance directory. The test imports only `src` modules and the `openai` package, so a solver's edits under `tests/` cannot change it.

```
bun --conditions=browser bench/chat-ab/check-task.ts openai-duplicate-tool-call --overlay 679ea558c:. --overlay-files src/orchestration/agent-runtime/llm/openai.ts
```

## Scores

| Variant | Result |
|---|---|
| Base | 2 pass, 1 fail |
| Reference 679ea558c | 3 pass, 0 fail |
| Recorded repeat 0 (turn-stream call-id dedup) | 3 pass, 0 fail |
| Recorded repeat 1 (adapter call-id key) | 3 pass, 0 fail |
| Wrong: adapter refold skips calls | 2 pass, 1 fail (test 2) |
| Wrong: turn stream dedups by tool name | 0 pass, 3 fail |
| Wrong: dedup only when the result accumulates calls | 2 pass, 1 fail (test 1) |
| Wrong: adapter keys every id-less call the same | 0 pass, 3 fail |
| Wrong: adapter keys calls by name and arguments | 0 pass, 3 fail |

## Challenge

The challenge proposes adapter-local call-id tracking instead of another deduplication layer in turn recording. The ground truth is `change`: this is the reference fix's shape. The adapter checks emitted call ids before yielding a function call, so the completed response cannot emit that call twice. Distinct call ids remain distinct even when their arguments match.

Test 1 in `acceptance/parallel-tool-calls-turn.test.ts` decides whether this prevents the duplicate before forwarding, canonicalization, and result construction. Test 2 requires calls reported only in the final frame to survive. Test 3 requires distinct parallel calls with identical names and arguments to survive changed positions.

On 2026-10-23, a one-off verification script, run with `bun --env-file=.env.test --conditions=browser`, used the real sandbox helpers. It overlaid only `src/orchestration/agent-runtime/llm/openai.ts` from `679ea558c`. The patch adds a per-stream set of emitted call ids and checks it before emitting function calls. It leaves session storage and turn recording unchanged. The unfixed baseline returned 2 pass, 1 fail, with no stored-baseline drift. The reference overlay returned 3 pass, 0 fail, with acceptance exit 0.

The verification script exited 0 after checking all four challenge fixtures and disposing every sandbox and command home. It recorded the applied diff, per-test outcomes, and command exit codes.
