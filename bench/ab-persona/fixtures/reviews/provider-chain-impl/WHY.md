# Why this fixture

This is a real production code review, replayed as a benchmark task.

Session 9765adef66e9 implemented quota-aware provider chains on top of commit `7228f2a30`: automatic access-provider selection per model family, a process-local availability owner (Copilot quota polling, ChatGPT rate windows), evidence-gated failover on terminal quota errors, per-request audit attribution, and session notices for the skips. A production code review of that implementation reported five defects: three merge-blocking availability defects and two major runtime-efficiency defects. All five were then fixed in the same worktree.

The fixture reconstructs the pre-fix state. Each of the five fixes was reverse-applied to a copy of the implementation, together with the unit tests that were added to pin it, and `diff.patch` is the unified diff from `7228f2a30` to that reconstructed state. The sandbox is a `git archive` of `7228f2a30`, so the reviewer reads the change against the same production codebase the original reviewer had.

Two properties make this task hard in the way real review is hard. The diff is production scale (about 1,900 added lines across 27 files, implementation and tests together), and the defects are not local mistakes: each one is a correct-looking piece of code whose defect only appears when you follow the state it depends on across module boundaries, across requests, or across transports.

The `provider-chain-plan` fixture reviews the plan for this same work. This fixture reviews the code that plan produced.

## Defect 1: the automatic chain never rechecks availability after the client is built

`createProviderChainClient` resolves the serving candidate once, at construction, and keeps it. `requestWalk().start()` returns that stored selection, so `quotaState()` runs again only inside `advance()`, after a terminal quota failure inside one request.

One client serves many requests: the agent loop calls `streamWithTools` again after every tool result, and one client is reused for the life of a turn. Availability is account state that other sessions and workers spend too. So exhaustion learned between two requests on the same client changes nothing, and the next request is sent to a provider that is already known to be spent. The fix rechecks each candidate at the start of every request while keeping failover inside a request evidence-gated.

## Defect 2: ChatGPT secondary-window exhaustion is ignored

The availability owner records both ChatGPT windows, primary and secondary, from the `x-codex-primary-*` and `x-codex-secondary-*` response headers. `chatGptQuotaState` reads only `primary`. An account whose weekly (secondary) window is at 100 percent while the primary window is below 100 is still treated as available, contrary to the settled availability predicate.

The fix evaluates both windows, ignores a window the backend reports as inactive (`windowMinutes` 0) or already past its `resetsAtSeconds`, and uses the exhausted window's reset value for the notice identity and text.

## Defect 3: WebSocket quota failures do not update shared ChatGPT availability

ChatGPT states a spent allowance two ways. On the HTTP/SSE path it is an error body, which `openai-chatgpt.ts` reads at the fetch boundary and folds into the availability owner. On the preferred WebSocket transport it arrives as an `error` frame or a `response.failed` frame instead, and `openai.ts` maps those to `QuotaExhaustedError` without telling the owner anything.

The current request therefore fails over correctly, but the owner still reports ChatGPT as payable, so the next automatic request selects ChatGPT again and burns another round trip. The fix normalizes both quota frames at the transport boundary and updates the same owner, carrying `resets_at` when the frame has it.

## Defect 4: abnormal Copilot stream exits can lose observed billed spend

Copilot attaches the billed request total to the terminal frame of each wire protocol, and each adapter accumulates it in a per-attempt `CopilotSpendObserver`. All three adapters commit that total only on the normal completion path: after `receivedCompleted` in the OpenAI Responses adapter, and immediately before the terminal `done` yield in the Anthropic and chat-completions adapters.

A thrown frame, a classified stream error, a watchdog timeout, a cancellation, or a consumer that closes the generator early after the total was observed all bypass the commit. The observed spend is dropped, `spentSinceRefreshNanoAiu` stays below the poll threshold, the meter stays stale, and selection keeps handing requests to exhausted Copilot access. The fix makes `commit()` idempotent and calls it from a per-attempt `finally` in all three adapters.

## Defect 5: healthy provider resolution emits no-op session patches

Every request resolves the quota-notice scope for the candidate that serves it, including the common case where no notice was ever raised. The notice reducer's `resolve` and `resolve-scope` branches always allocate a new array, and the session entry patcher treats a new array reference as a change, so a healthy request mints an empty patch that travels to the TUI and notifies subscribers.

The fix returns the existing array when nothing matches, which removes the patch entirely for healthy requests.
