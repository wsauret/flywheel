# Why this task exists

The question needs a trace across several files of the pinned tree. It restores the behavior of fix f752c144f, which is in the public history before the pin, and its trap is the behavior before that fix or a shallow reading of it. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `b5833f6a4e4458a80e02612cfb5c0729aaaaf267`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `usage-window-gate`

The usage-limit text reports spent quota only when the last rate-limit event read was a rejection that names a usage window (five_hour, seven_day, seven_day_opus, seven_day_sonnet, seven_day_overage_included, overage).

- `src/orchestration/modules/provider-claude-agent-sdk/sdk-events.ts:126`: `"five_hour", "seven_day"`
- `src/orchestration/modules/provider-claude-agent-sdk/sdk-events.ts:142`: `!USAGE_WINDOWS.has(info.rateLimitType)) return undefined;`
- `src/orchestration/modules/provider-claude-agent-sdk/sdk-events.ts:151`: `return rejection !== undefined && isUsageLimitText(text);`

### Fact `concurrency-not-quota`

A concurrency rejection names no usage window, so no quota mark is recorded; the 429 becomes a rate-limit failure.

- `src/orchestration/modules/provider-claude-agent-sdk/sdk-events.ts:148`: `Any other limit, such as too many concurrent requests, is`
- `src/orchestration/modules/provider-claude-agent-sdk/sdk-events.ts:198`: `if (reportsSpentUsage(text, rejection)) return quotaFailure(`
- `src/orchestration/agent-runtime/llm/provider-failure.ts:389-391`: `return new RateLimitFailure(`

### Fact `retried-in-place`

The rate-limit failure is retried on the same candidate up to 3 times, waiting the provider's retry delay (capped at 60 s) or a backoff.

- `src/orchestration/agent-runtime/llm/failover-client.ts:126`: `const CANDIDATE_RETRY_LIMIT = 3;`
- `src/orchestration/agent-runtime/llm/failover-client.ts:144`: `Math.min(failure.retryAfterMs, RETRY_AFTER_MAX_MS)`
- `src/orchestration/agent-runtime/llm/failover-client.ts:657`: `if (retries < CANDIDATE_RETRY_LIMIT) {`
- `src/orchestration/agent-runtime/llm/provider-failure.ts:150`: `case "RateLimitFailure":`

### Fact `failover-owner`

The failover client's candidate walk owns moving to the next candidate, after the retry budget is spent; the Claude engine adapter only classifies the failure.

- `src/orchestration/agent-runtime/llm/failover-client.ts:667`: `walk.publishOutageFailure(attempt, failure, retries + 1);`
- `src/orchestration/agent-runtime/llm/failover-client.ts:674`: `selection = await walk.selectNext();`

### Trap `text-marks-quota`

Wrong answer: Any usage-limit text from the engine marks the login's quota spent and suppresses the account.

Why a shallow trace reaches it: The engine writes the same usage-limit text for every limit, and the text classifier is the most visible check. Before fix f752c144f the text alone marked quota for five minutes.

Refuted by:

- `src/orchestration/modules/provider-claude-agent-sdk/sdk-events.ts:150-151`: `return rejection !== undefined && isUsageLimitText(text);`
