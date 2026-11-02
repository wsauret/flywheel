# cut-tool-args

Fix commit: f77cd52b328a4009d54b105411202d586d18427d, "fix(providers): never run a tool call whose arguments were cut off".

Base commit: b6d624689385427eed079ea68815e8d6dce1b2e0 (the parent of the fix).

## The requirement

The message states two requirements. First, a tool call that the output limit cut off must never run with half of its input, on any provider. Second, OpenRouter must handle an output-limit cut the way the other providers do: the turn continues instead of ending.

## The bug

The tolerant JSON parser in `src/orchestration/agent-runtime/llm/json-parse.ts` had a third tier that used `partial-json` to complete a prefix. When the output-length cap cut a tool call's argument JSON, the parser closed the open string and object and returned a valid but shortened input. The dispatcher then ran the tool, so a write could land a truncated file. This happens on every wire, because each adapter emits a tool call before the loop sees the stop reason. On the Anthropic API the adapter emits `tool_use` at `content_block_stop`, before `message_delta` reports `stop_reason: max_tokens`, and the loop starts the call at once. Separately, the chat-completions adapter (`openai-completions.ts`, used by OpenRouter and Copilot) mapped `finish_reason: "length"` to an ordinary `max_tokens` stop. The Anthropic and Responses adapters raise `OutputLengthExceededError` for the same condition, which the loop treats as an output overflow and resumes. So on OpenRouter a cut response ended the turn.

## Why it is a fair task

The user sees a truncated file and a turn that stops. The cause sits in places that the symptom does not name: the shared parser that silently completes prefixes, the point where each adapter emits a tool call before the stop reason arrives, and one adapter's stop-reason mapping that differs from the other wires. The message names OpenRouter, but it also states the general rule ("must never run with half of its input") and names the direct Anthropic API as the comparison. A solver who fixes only the chat-completions adapter leaves the direct Anthropic path running cut calls. Two correct designs exist and both score full marks: refuse cut argument text in the shared parser (the reference), or hold each tool call in the adapter until the stop reason shows no cut (the audit alternative).

## What the tests check

All tests except the last drive `runAgentLoop` with a real provider adapter over a fake `fetch`, and a recording `write` tool. The harness helpers are copied into the test file, so the tests depend on no file under `tests/`.

1. Anthropic API, cut inside the content string: the first response sends a `tool_use` block, a cut `input_json_delta`, `content_block_stop`, then `stop_reason: max_tokens`. The second response is `end_turn` text. The test fails if any recorded execution received a cut-down copy of the full arguments: a leading run of its keys where the last value can be a string prefix, but not the full object.
2. Anthropic API, cut between two arguments: the same, with the text cut after `"path":"a.ts",`.
3. OpenRouter chat completions, `finish_reason: "length"`: the same check through the loop.
4. OpenRouter chat completions, stream closed with no `finish_reason`: the same check through the loop.
5. Regression guard: a complete Anthropic write call with `stop_reason: tool_use` runs once with its full arguments. It catches a fix that refuses or never releases complete calls.
6. Regression guard: a complete OpenRouter write whose content carries an unescaped newline runs once with that content. It catches a fix that drops the repair tier for control characters.
7. Chat-completions adapter: `finish_reason: "length"` surfaces as a `ProviderAttemptFailure` with the `OutputOverflowFailure` tag and no `done` event. If the adapter emits a `tool_use` event, its input must be `{}` with a parse error, which the dispatcher refuses.

## What the tests do not check

They do not check where the guard lives (parser, adapter, or loop), the parser's return value, error wording, how the loop resumes after the overflow, or the Responses (`openai.ts`) wire. They do not require that a cut call is re-sent later.

## How to apply the reference

The sandbox patch (`sandbox.patch`) sets `bunfig.toml` `[test] root` to `.` so that `bun test acceptance` finds the acceptance directory. It changes nothing else. `task.json` adds `crates/tokenizer/tokenizer-prebuilt.json` and `crates/tokenizer/flywheel-tokenizer.wasm.zst`, because `runAgentLoop` loads the tokenizer.

From the bench worktree root:

```
bun --conditions=browser bench/chat-ab/check-task.ts cut-tool-args --overlay f77cd52b3:. --overlay-files src/orchestration/agent-runtime/llm/json-parse.ts,src/orchestration/agent-runtime/llm/openai-completions.ts
```

## Scores

| Source | Pass | Fail |
|---|---|---|
| Base | 2 (both guards) | 5 |
| Reference f77cd52b3 | 7 | 0 |
| Audit alternative `alt-adapter-holdback.patch` (adapter holdback, tolerant parser) | 7 | 0 |
| Recorded run r0 (`baseline-r0-7ddf99ac`) | 5 | 2 (tests 1 and 2, Anthropic) |
| Recorded run r1 (`baseline-r1-86a2e19c`) | 5 | 2 (tests 1 and 2, Anthropic) |

Both recorded runs fix only the chat-completions adapter. On the direct Anthropic path they still run the write with the cut content, so they fail tests 1 and 2.

## Challenge

The challenge claims that OpenRouter's stop-reason mapping is the only defect and that changing the shared parser is unnecessary. The ground truth is `hold`: the mapping-only proposal does not prevent tools from running with cut arguments. This does not require a parser-based solution. Adapter holdback remains a valid alternative.

Tests 1 and 2 decide the disputed cross-provider premise. They drive the direct Anthropic path, which emits the tool call before reporting the output limit. Both still record shortened writes after the adapter-only change. Tests 3 and 4 also fail because OpenRouter still emits cut calls. Test 7 recognizes the overflow but fails because the emitted input is not refused. Both complete-call guards pass.

On 2026-10-23, a one-off verification script, run with `bun --env-file=.env.test --conditions=browser`, used the real sandbox helpers. The script overlaid only `src/orchestration/agent-runtime/llm/openai-completions.ts` from `f77cd52b3`. This adds the overflow-error import and changes the `length` mapping to throw that error. It leaves the shared parser unchanged. The unfixed baseline returned 2 pass, 5 fail, with no stored-baseline drift. The adapter-only patch also returned 2 pass, 5 fail, with acceptance exit 1. This is narrower than the recorded adapter-only solutions above, which also protected OpenRouter calls and returned 5 pass, 2 fail.

The verification script exited 0 after checking all four challenge fixtures and disposing every sandbox and command home. It recorded the applied diff, per-test outcomes, and command exit codes.
