# Why this task exists

This question asks for a per-route, per-request-kind table whose answer crosses the request inputs, the cache-retention policy, the session-title options, and the OpenAI request helpers. Comments about cache-disabled requests describe a branch that no production producer reaches, so a shallow answer says compaction and title requests carry no key. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `body-key-gate`

The body prompt_cache_key is set from the request's promptCacheKey unless cacheRetention is "none".

- `src/orchestration/agent-runtime/llm/openai-helpers.ts:223`: `if (options.cacheRetention === "none") {`
- `src/orchestration/agent-runtime/llm/openai-helpers.ts:227`: `if (clampedCacheKey) params.prompt_cache_key = clampedCacheKey;`

### Fact `key-is-tree-root`

promptCacheKey is the tree root's session id when the run belongs to a tree (so a subagent shares its root chat's key), else the conversation's provider session key.

- `src/orchestration/agent-runtime/request-inputs.ts:380`: `const treeRoot = runtimeIdentity?.rootSessionId`
- `src/orchestration/agent-runtime/request-inputs.ts:662`: `promptCacheKey: treeRoot ?? conversation.providerSessionKey,`

### Fact `title-shares-chat-key`

The session title run is hosted in the chat's tree with the chat as root, so its cache key equals the chat's key.

- `src/orchestration/chat/chat-request-options.ts:102`: `purpose: SESSION_TITLE_PURPOSE,`
- `src/orchestration/chat/chat-request-options.ts:109`: `treeRootSessionId: sessionId,`

### Fact `no-none-producer`

No production path produces cacheRetention "none": the default retention is only 5m or 1h, the config schema has no none, and compaction makes no separate provider request because the summarizing compactor was removed.

- `src/orchestration/agent-runtime/request-kernel.ts:50`: `export function defaultCacheRetention(`
- `src/orchestration/config/retired-config-names.ts:23`: `Role ids of the removed summarization compactor.`

### Fact `api-headers-own-key`

On the OpenAI API route the session headers carry the session's own provider key, not the cache group.

- `src/orchestration/agent-runtime/llm/openai-helpers.ts:258`: `if (!isChatGPT) return { session_id: identity`

### Fact `chatgpt-headers-group`

On the ChatGPT subscription route the session-id header carries promptCacheKey, the cache group, because that backend groups by the header.

- `src/orchestration/agent-runtime/llm/openai-helpers.ts:259`: `const affinity = options.cacheRetention === "none" ? identity`

### Fact `provider-policy-keeps-key`

A cache policy of "provider" maps to an undefined retention, so the key is still sent.

- `src/orchestration/agent-runtime/llm/types.ts:512`: `return policy === "provider" ? undefined`

### Trap `compaction-title-disabled`

Wrong answer: Compaction and title requests are cache-disabled, so they carry no prompt-cache key on either route.

Why a shallow trace reaches it: The OpenAI helpers document a cache-disabled request that opts out of prompt caching and joins no group, and the turn attempt type has a compaction request purpose.

Misleading evidence:

- `src/orchestration/agent-runtime/llm/openai-helpers.ts:250`: `A cache-disabled ChatGPT request joins no`

Refuted by:

- `src/orchestration/chat/chat-request-options.ts:109`: `treeRootSessionId: sessionId,`
- `src/orchestration/config/retired-config-names.ts:23`: `Role ids of the removed summarization compactor.`

### Trap `api-group-in-headers`

Wrong answer: On the OpenAI API route the cache group travels in the session headers.

Why a shallow trace reaches it: The same helper file explains header grouping for ChatGPT, which reads as route-independent.

Refuted by:

- `src/orchestration/agent-runtime/llm/openai-helpers.ts:258`: `if (!isChatGPT) return { session_id: identity`

### Trap `subagent-own-key`

Wrong answer: A subagent uses its own conversation's key, separate from the chat's.

Why a shallow trace reaches it: Each conversation has its own provider session key.

Refuted by:

- `src/orchestration/agent-runtime/request-inputs.ts:662`: `promptCacheKey: treeRoot ?? conversation.providerSessionKey,`
