# interrupted-question-blank-result

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(chat): prevent interrupted questions from breaking model requests".

## The bug

When the user interrupts an open `ask_user` question, the tool returns `{ content: "", outcome: "interrupted", suspendTurn: true }`. Settlement in `src/orchestration/agent-runtime/agent-loop-tools.ts` already skips a suspended call, so that the resume path can answer it later. But the dispatcher finalized the entry eagerly as soon as the tool returned, and that wrote an in-flight checkpoint and a `tool_result_available` event with blank interrupted content. The blank result then reached recorded history as an error tool result with empty text. Anthropic rejects an error `tool_result` with empty content, so every later request failed. `healConversation` in `src/orchestration/agent-runtime/llm/heal-messages.ts` repaired orphans and duplicates but passed blank error results through, so sessions that already held one stayed broken.

## Why it is a fair task

The user sees a provider rejection after an interrupt. A solver must connect the provider error to the blank result and meet two requirements. First, an interrupted question must not write a blank result: the eager finalization contradicts the settlement rule for suspended calls. Second, history that already holds a blank error result must again produce a valid Anthropic request. The reference fix repairs that history in `healConversation`. The tests accept a repair at any of these sites equally: the `chat.entries.appended` fact decoder, the recovery boundary that loads recorded history (`persistedToConversationMessage` and `buildSessionContext`), `healConversation`, the Anthropic converter `toAnthropicMessagesRequest`, or the adapter entry point `convertMessages` in `src/orchestration/agent-runtime/llm/anthropic-adapter-helpers.ts`. The tests do not cover a repair in the agent-loop request-context step (`src/orchestration/agent-runtime/agent-loop.ts`, which assembles the messages for each request before the adapter sees them), because the tests do not run the agent loop. A repair that lives only there fails the history tests.

The hidden tests check behavior only:

- A suspended tool call is neither checkpointed nor published as a tool result (`tool_result` or `tool_result_available` for that call). Other events that the dispatcher emits are not checked.
- The history tests write the base build's own `chat.entries.appended` facts into a SQLite event store, open the recorded conversation with `tryOpenConversationTree`, call `buildContext()`, and convert the loaded messages with `convertMessages`. `prepareAnthropicRequest` in `llm/anthropic.ts` calls `convertMessages` for every real Anthropic request, and `convertMessages` calls `toAnthropicMessagesRequest`, which calls `healConversation`. So a repair in the fact decoder, the recovery boundary, `buildSessionContext`, `healConversation`, the converter, or `convertMessages` passes. The agent-loop request-context step is not on this path and is not covered.
- A recorded session with an interrupted blank error result (empty or whitespace-only text), followed by a new user message, produces a request whose `tool_result` is paired with its `tool_use`, keeps `is_error: true`, has non-empty text, and still carries the new message.
- A recorded session with a plain blank error result (no `interrupted` flag) also produces a request with non-empty error content and `is_error: true`.
- Three regression guards pass on the base. First, when a quick tool finishes while a sibling call in the same batch is still running, the quick result is checkpointed and made available before the sibling finishes. Second, a recorded non-blank error result reaches the request with its text unchanged. Third, a recorded blank successful (non-error) result reaches the request paired with its `tool_use` and without `is_error: true`.

Keeping the error signal is an intended requirement. An interrupted question did not produce an answer, so the model must still see it as a failed call: the repaired `tool_result` keeps `is_error: true` and carries non-empty text. A fix that avoids the rejection by sending the blank result as a non-error result removes the only signal that the question was not answered, so the tests reject it.

Repairing every blank error result, not only interrupted ones, is an intended engineering-care requirement. The user names the rule that Anthropic enforces: a `tool_result` with empty content while `is_error` is true. A repair keyed only to the `interrupted` flag leaves the same rejection, and the same permanently broken session, reachable from any other blank error result. The reference fix repairs both cases.

The first guard exists because the eager finalization in `settle()` is load-bearing for ordinary results. It checkpoints and publishes each finished result as soon as its tool returns, while siblings still run. A fix that deletes the eager finalization instead of skipping it for suspended calls makes every ordinary result wait for the whole batch, and the guard catches that. The second guard catches a repair that replaces the content of every error result with a tombstone, which destroys real error text that the model needs. The third guard catches a repair that keys on blank content alone and marks a blank successful result as an error, which tells the model that a tool that worked had failed.

The tests do not check the tombstone wording, where the repair happens, or the normalized tool id. A fix that repairs only the request path fails the suspended-call test, and a fix that only stops new blank results fails the history tests.

## Validation

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. `sandbox.patch` sets the bunfig test root to `.` so that `bun test acceptance` finds the acceptance directory. It restores the defect in two places: the dispatcher in `src/orchestration/agent-runtime/agent-loop-tools.ts` again finalizes a suspended call as soon as its tool returns, and `healConversation` in `src/orchestration/agent-runtime/llm/heal-messages.ts` again passes blank error results through (with its doc comment returned to the pre-fix text). It also returns the unit tests that the fix changed to their state before the fix: the suspended-call test in `tests/unit/orchestration/agent-runtime/agent-loop-tools.test.ts` no longer checks checkpoints, and the blank-result tests in `tests/unit/orchestration/agent-runtime/llm/heal-messages.test.ts` and `tests/unit/orchestration/agent-runtime/llm/conversions/anthropic-messages.test.ts` are gone, so the unit suite passes on the bugged tree as it did before the fix.

The history tests write `chat.entries.appended` version 3, which the base writer still uses for these plain messages (`chatEntriesAppendedVersion`).

- Base sandbox: 3 pass, 4 fail (the 3 passes are the regression guards).
- Base plus `reference.patch`: 7 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts interrupted-question-blank-result --apply-diff bench/chat-ab/tasks/interrupted-question-blank-result/reference.patch
```

The results below were measured on the earlier fixture, which pinned a pre-public parent of the fix; they have not been measured again on the public base.

- Base plus the dispatcher fix and a recovery-boundary repair in `persistedToConversationMessage`: 7 pass, 0 fail.
- Base plus the dispatcher fix and a repair inside `convertMessages`: 7 pass, 0 fail.
- Base plus a fix that deletes the eager finalization in `settle()` (plus a converter repair): 6 pass, 1 fail (the sibling guard).
- Base plus the dispatcher fix and a `healConversation` repair that replaces every error result with the interrupted tombstone: 6 pass, 1 fail (the non-blank error guard).
- Base plus the dispatcher fix and a converter repair that sends a blank error result as a non-error result with text: 4 pass, 3 fail.
- Recorded pilot runs `baseline-r0` and `baseline-r1` (dispatcher fix plus a converter repair): 7 pass, 0 fail each.

## Design variant

- The tool dispatcher owns the distinction between a suspended call and a completed result.
- Suspended calls must not checkpoint or publish a result, because the resume path owns the later answer.
- Ordinary completed results must remain checkpointed and available immediately while sibling tools are still running.
- The shared conversation repair step before provider conversion owns the repair of existing blank error results.
- The repair covers all blank error results, not only interrupted questions, and treats whitespace-only text as blank.
- Results with images must remain unchanged.
- Replacement text must preserve failure status and tool-call pairing, distinguish known interruption from missing content, and retain later user messages.
- Existing meaningful error text and successful results must remain unchanged.
- Verification must cover both premature result prevention and a subsequent request from a reopened affected session.
