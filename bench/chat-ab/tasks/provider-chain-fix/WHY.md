# provider-chain-fix

## Provenance

- Base: `7228f2a30` ("workflow cleanup"), tree `7228f2a30:flywheel-tui`, plus `pre-fix.patch`. The patch reconstructs the automatic access-provider chain as a code review saw it in session `9765adef66e9`, before the review fixes. It also adds the two files the chain imports (`src/infra/llm/claude-model-id.ts`, `src/infra/llm/openrouter-model-support.ts`) and the per-request audit attribution in `assistant-turn-stream.ts`, so the tree loads its own modules.
- Reference: the fix commit `fc3aa6454` ("raindrop audits + benchmark work"). It is a large mixed commit. Its six non-test provider files hold the shipped review fixes: `src/infra/session-notice.ts` and `src/orchestration/agent-runtime/llm/{anthropic,openai-completions,openai,provider-availability,provider-chain-client}.ts` under `flywheel-tui/`.
- Converted from `bench/tasks/implement/provider-chain-fix`. `message.md` pastes the review's five findings in the reviewer's words. It names no file and no fix.

## The requirement

The review found five defects, and the user asks for all five to be fixed:

1. The chain chose its serving provider once, when the client was built. Later requests kept using a spent subscription and never returned to a recovered one. Each request (stream and `complete()`) must check availability again. A request that finds the whole chain spent fails with the typed exhausted-chain error. Three existing rules must stay: `accessProvider` reports the head of the chain, a different serving provider is announced through `onProviderFailover` before the fallback request, and a quota failure after the attempt produced output propagates.
2. ChatGPT availability read only the primary rate-limit window. Either window at 100% must count as spent, except a zero-minute window and a window whose reset already passed. The skip notice names the reset in its id and its text.
3. A quota failure on the ChatGPT WebSocket path never reached the shared availability owner. Both terminal frame shapes (`response.failed` and a bare `error`) must mark the window exhausted, with `resets_at` when present. Other frames leave availability alone.
4. Copilot spend was committed only on normal completion. Errors, cancellation, the liveness watchdog, and an early consumer close after the billed total lost it. Every adapter that reads Copilot spend must commit on every exit, and one request is billed exactly once.
5. Resolving a notice that is not raised allocated a new array, so every healthy request produced an empty session patch. That resolve must be a no-op.

## What the tests check

The suite has 21 tests in three files. Each test drives a production entry point that any fix must keep: `createProviderChainClient`, the three provider adapters (`createOpenAIAdapter`, `createOpenAIChatCompletionsAdapter`, `createAnthropicAdapter`), the shared availability owner, and `applySessionNoticeOperation`.

- `provider-chain-availability.test.ts`: per-request selection for streams and `complete()`, recovery, the typed error for a spent chain, the secondary window with its inactive and expired exceptions, the reset in the notice id and text, and the no-op resolve. Where the head is spent when the client is built, the test checks the provider that served and the provider a caller attributes the request to. The attributed provider is the last `onProviderFailover` announcement, else `accessProvider`. So a fix may keep `accessProvider` at the first available candidate or at the first candidate, but it must not serve a fallback silently.
- `chatgpt-websocket-quota.test.ts`: both terminal frame shapes, the three quota codes, an optional `resets_at`, other frames that change nothing, and a later chain request that skips ChatGPT. The frames go through the production frame mapper `mapChatGptBackendEvents`, the same step that the real WebSocket path applies to every socket frame. The mocks for this file live in `acceptance/_chatgpt-websocket-fixtures.ts`, so an edit to the repository's shared test fixtures cannot change the score.
- `copilot-spend-abnormal-exit.test.ts`: a commit on stream error in all three adapters, caller cancellation, the Anthropic liveness failure, an early consumer close after the billed frame was read (with a second close), and a repeated commit that bills once.

Six tests pass on the base. Each is labeled "regression guard" and names the regression it catches. A mutant run on a recorded fix confirmed that each guard fails its named regression: recording non-quota WebSocket frames, moving `accessProvider` to the served provider, starting the fallback after output, counting an inactive or an expired secondary window, double-billing a normal completion, and recording spend that no frame carried.

## What the tests do not check

- The location of any fix. A fix can record the WebSocket quota in the frame mapper, in the adapter, or anywhere the frames pass.
- Whether `accessProvider` names the first candidate or the first available candidate when the head is spent at build time.
- Wording of the notice text, beyond the reset timestamp.
- Persistence, repository-wide `tsc`, and lint. The message rules them out.
- The real WebSocket transport. The test replaces `chatgpt-backend/transport.js` and feeds frames to the mapper.

## How to apply the reference

```
bun --conditions=browser bench/chat-ab/check-task.ts provider-chain-fix --overlay fc3aa6454:flywheel-tui --overlay-files src/infra/session-notice.ts,src/orchestration/agent-runtime/llm/anthropic.ts,src/orchestration/agent-runtime/llm/openai-completions.ts,src/orchestration/agent-runtime/llm/openai.ts,src/orchestration/agent-runtime/llm/provider-availability.ts,src/orchestration/agent-runtime/llm/provider-chain-client.ts
```

## Known reference gap

The reference does not fix finding 3 in production. It records the quota only in the `response.failed` and `error` cases of the adapter's event switch in `openai.ts`. On the real WebSocket path, `websocket.ts` sends every frame through `mapChatGptBackendEvents`, which throws `ChatGptBackendApiError` on those two frame types before the adapter switch sees them. So the reference fails both WebSocket quota tests. The older suite passed it only because the shared fixture skipped the mapper. No historical revision fixes all five findings.

## Validation

`check-task.ts` on 2026-10-05, with per-test results from kept sandboxes:

| Tree | Passed | Failed | Accepted |
|---|---|---|---|
| Base | 6 | 15 | No. Only the six regression guards pass. |
| Reference (`fc3aa6454`, six files) | 19 | 2 | No. It fails the two WebSocket quota tests, the known reference gap. |
| Recorded run r0 (`baseline-r0-db704d10`) | 21 | 0 | Yes |
| Recorded run r1 (`baseline-r1-8b9ac3cb`) | 21 | 0 | Yes |
| Reference with r1's edit to the shared fixture | 19 | 2 | No. The shared fixture no longer affects the score. |

## Design variant

- Availability stays with the existing process-shared, memory-only owner rather than becoming client-local or persistent state.
- Each request starts selection from the preferred provider, including non-streaming completions. A failover walk remembers failed candidates only for that request. An exhausted chain returns the existing typed failure. The client's reported provider identity stays stable, and a different serving provider is announced before its request. Existing failover eligibility and the rule against restarting an attempt after output stay unchanged.
- Either ChatGPT usage window at 100% blocks access, except zero-minute windows and windows that have already reset. The exhausted window's reset appears in both the skip notice's identity and its text.
- Socket quota recording handles both terminal failed responses and standalone errors, retaining a supplied reset and updating the same shared availability state as HTTP failures. Recording must occur where terminal frames become errors, before later consumers can miss the failure. Other frames leave availability unchanged. This addresses the documented reference gap without naming a code location.
- Each adapter that reads Copilot billing keeps one spend observation per wire attempt and finalizes it on every exit. Exits include success, errors, cancellation, watchdog failure, and early consumer closure. Repeated billed totals are not added together, repeated finalization does not bill twice, and an attempt with no observed total records nothing.
- The notice owner preserves the existing collection's identity for unmatched resolutions by either notice identity or scope, rather than merely producing an equal collection. Healthy requests must not create empty session patches.
- Verification stays with relevant tests. Unrelated repository-wide type-checking and lint failures remain outside the task.
